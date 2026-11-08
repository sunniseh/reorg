//! REORG company contract (roadmap C-03 … C-15, C-21): the NEAR adapter.
//!
//! Every rule lives in `reorg-core`. This file only maps NEAR concepts onto it:
//! storage (lazy `near_sdk::store` collections, no loops over employees), the account id as
//! the opaque wallet string, `env::sha256_array` as the SHA-256 host, balance reads from the
//! token (`ft_holder_info`) through promise callbacks, NEAR transfers, and events as NEP-297
//! logs plus an on-chain ring buffer (D8).
//!
//! Async safety: `submit` and `claim_salary` set a marker before the balance read; callbacks
//! never panic (a panic would revert the marker removal), they report failures as values.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, serde_json, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};
use reorg_core::crypto::Sha256;
use reorg_core::engine::{self, ClaimResolution};
use reorg_core::events::{ring_oldest, ring_slot, EVENT_STANDARD, EVENT_VERSION};
use reorg_core::model::{Employee, HolderInfo, IncomeTag, Submission, Task, TaskKind, Treasury};
use reorg_core::views::{self, EmployeeView, SubmissionView, TaskView, TreasuryView};
use reorg_core::{Config, Event, EventEntry, TaskId};

const GAS_HOLDER_INFO: Gas = Gas::from_tgas(5);
const GAS_ON_BALANCE: Gas = Gas::from_tgas(20);
const GAS_ON_CLAIM_BALANCE: Gas = Gas::from_tgas(25);
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_TOTAL_SUPPLY: Gas = Gas::from_tgas(5);
const GAS_ON_TOTAL_SUPPLY: Gas = Gas::from_tgas(5);
/// Max bytes accepted from `ft_holder_info` (two decimal strings in a small object).
const MAX_HOLDER_INFO_LEN: usize = 256;
/// Page size cap for list views and `get_events`.
const MAX_PAGE: u32 = 100;
/// `submit` requires at least this much free (non-treasury, non-storage) balance, so storage
/// for new submissions is never paid out of the books (§7.5, R-05).
const MIN_STORAGE_FLOAT: NearToken = NearToken::from_millinear(50);

/// SHA-256 via the NEAR host function.
struct HostSha256;
impl Sha256 for HostSha256 {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        env::sha256_array(data)
    }
}

#[ext_contract(ext_token)]
#[allow(dead_code)]
trait Token {
    fn ft_holder_info(&self, account_id: AccountId) -> HolderInfo;
    fn ft_total_supply(&self) -> U128;
}

#[derive(BorshStorageKey)]
#[near]
enum Prefix {
    Tasks,
    Subs,
    SubIndex,
    Pending,
    Employees,
    EmployeeIds,
    Events,
}

/// Result of `submit` (the value of its callback).
#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct SubmitOutcome {
    pub accepted: bool,
    pub reason: Option<String>,
}

/// Result of `claim_salary` (the value of its last callback).
#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ClaimOutcome {
    Paid { amount: U128 },
    Forfeited { amount: U128 },
    /// The balance read or the transfer failed; the claim can be retried.
    Retry { reason: String },
}

#[near(serializers = [json])]
pub struct ContractInfo {
    pub owner: AccountId,
    pub boss: AccountId,
    pub token: AccountId,
    pub total_supply: U128,
    pub current_task_id: TaskId,
    pub last_finalized: TaskId,
    pub event_seq: u64,
    pub employees: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Reorg {
    owner: AccountId,
    boss: AccountId,
    token: AccountId,
    total_supply: u128,
    config: Config,
    current_task: TaskId,
    last_finalized: TaskId,
    treasury: Treasury,
    event_seq: u64,
    tasks: LookupMap<TaskId, Task>,
    subs: LookupMap<(TaskId, AccountId), Submission>,
    /// (task, submission index) → account, for paging `list_submissions`.
    sub_index: LookupMap<(TaskId, u32), AccountId>,
    /// Submissions whose balance read is in flight (C-06).
    pending: LookupSet<(TaskId, AccountId)>,
    employees: LookupMap<AccountId, Employee>,
    employee_ids: Vector<AccountId>,
    /// Ring buffer of the last `EVENT_RING` events, keyed by slot.
    events: LookupMap<u64, EventEntry>,
}

/// NEAR allows 100 log lines per call.
const MAX_LOGS_PER_CALL: u32 = 100;

/// Core validation plus NEAR limits: the last `finalize_task` call logs up to one event per
/// passer (two if 1 is a streak milestone: milestone + rehired) plus three settlement events.
fn validate_config(cfg: &Config) {
    cfg.validate().unwrap_or_else(|e| env::panic_str(e));
    let per_passer = 1 + cfg.streak_milestones.contains(&1) as u32;
    require!(
        cfg.max_passers_per_call.saturating_mul(per_passer).saturating_add(3) <= MAX_LOGS_PER_CALL,
        "config: max_passers_per_call too large for NEAR's 100 logs per call"
    );
}

fn fail(e: engine::Error) -> ! {
    env::panic_str(e.as_str())
}

fn bytes32(v: &Base64VecU8, what: &str) -> [u8; 32] {
    v.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str(&format!("{what} must be 32 bytes")))
}

/// Reads the single promise result as `HolderInfo`; `None` if the call failed or is malformed.
fn holder_info_result() -> Option<HolderInfo> {
    env::promise_result_checked(0, MAX_HOLDER_INFO_LEN).ok().and_then(|v| serde_json::from_slice(&v).ok())
}

#[near]
impl Reorg {
    // ------------------------------------------------------------ init & admin (C-04, C-15)

    #[init]
    pub fn new(config: Config, token: AccountId, boss: AccountId, total_supply: U128, owner: Option<AccountId>) -> Self {
        validate_config(&config);
        require!(total_supply.0 > 0, "total_supply must be positive");
        Self {
            owner: owner.unwrap_or_else(env::predecessor_account_id),
            boss,
            token,
            total_supply: total_supply.0,
            config,
            current_task: 0,
            last_finalized: 0,
            treasury: Treasury::default(),
            event_seq: 0,
            tasks: LookupMap::new(Prefix::Tasks),
            subs: LookupMap::new(Prefix::Subs),
            sub_index: LookupMap::new(Prefix::SubIndex),
            pending: LookupSet::new(Prefix::Pending),
            employees: LookupMap::new(Prefix::Employees),
            employee_ids: Vector::new(Prefix::EmployeeIds),
            events: LookupMap::new(Prefix::Events),
        }
    }

    pub fn update_config(&mut self, config: Config) {
        self.assert_owner();
        validate_config(&config);
        self.config = config;
    }

    pub fn set_boss(&mut self, boss: AccountId) {
        self.assert_owner();
        self.boss = boss;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    pub fn set_excluded(&mut self, accounts: Vec<AccountId>, excluded: bool) {
        self.assert_owner();
        let ids: Vec<String> = accounts.into_iter().map(String::from).collect();
        self.config.set_excluded(&ids, excluded);
    }

    /// Anyone: re-reads the token's total supply (the tier denominator).
    pub fn refresh_total_supply(&mut self) -> Promise {
        ext_token::ext(self.token.clone())
            .with_static_gas(GAS_TOTAL_SUPPLY)
            .ft_total_supply()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_TOTAL_SUPPLY).on_total_supply())
    }

    #[private]
    pub fn on_total_supply(&mut self, #[callback_unwrap] supply: U128) -> U128 {
        if supply.0 > 0 && supply.0 != self.total_supply {
            log!("total_supply {} -> {}", self.total_supply, supply.0);
            self.total_supply = supply.0;
        }
        U128(self.total_supply)
    }

    // ------------------------------------------------------------ tasks (C-05, C-09)

    /// Boss: opens the next task with `commit_hash = sha256(day_secret)`. Returns its id.
    pub fn open_task(&mut self, kind: TaskKind, commit_hash: Base64VecU8, closes_at: U64) -> TaskId {
        self.assert_boss();
        let commit = bytes32(&commit_hash, "commit_hash");
        let (task, event) = engine::open_task(
            &self.config,
            self.current_task,
            self.last_finalized,
            kind,
            commit,
            closes_at.0,
            env::block_timestamp(),
        )
        .unwrap_or_else(|e| fail(e));
        let id = task.id;
        self.tasks.insert(id, task);
        self.current_task = id;
        self.emit(event);
        id
    }

    /// Boss: reveals the secret and verifies passers, at most `max_passers_per_call` per call.
    /// Any wrong passer fails the whole call. `last = true` settles the books.
    pub fn finalize_task(&mut self, task_id: TaskId, day_secret: Base64VecU8, passers: Vec<AccountId>, last: bool) {
        self.assert_boss();
        engine::check_batch(&self.config, passers.len()).unwrap_or_else(|e| fail(e));
        let now = env::block_timestamp();
        let mut events = Vec::new();
        let task = self.tasks.get_mut(&task_id).unwrap_or_else(|| fail(engine::Error::TaskNotFound));
        engine::begin_finalize(&HostSha256, &self.config, task, &mut self.treasury, &day_secret.0, now)
            .unwrap_or_else(|e| fail(e));
        for p in passers {
            let wallet = p.to_string();
            let sub = self.subs.get_mut(&(task_id, p.clone())).unwrap_or_else(|| {
                env::panic_str(&format!("{}: {wallet}", engine::Error::NoSubmission.as_str()))
            });
            let emp = self.employees.get_mut(&p).unwrap_or_else(|| fail(engine::Error::NoSubmission));
            engine::verify_passer(&HostSha256, &self.config, task, &wallet, sub, emp, &mut events)
                .unwrap_or_else(|e| env::panic_str(&format!("{}: {wallet}", e.as_str())));
        }
        if last {
            let op_cost = engine::settle(&self.config, task, &mut self.treasury, now, &mut events)
                .unwrap_or_else(|e| fail(e));
            self.last_finalized = task_id;
            if op_cost > 0 {
                Promise::new(self.boss.clone())
                    .transfer(NearToken::from_yoctonear(op_cost))
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_TRANSFER).on_operating_cost(U128(op_cost)))
                    .detach();
            }
        }
        self.emit_all(events);
    }

    #[private]
    pub fn on_operating_cost(&mut self, amount: U128) -> bool {
        let ok = near_sdk::is_promise_success();
        if !ok {
            // Never panic in a callback; the rollback can only fail on corrupted books.
            if let Err(e) = engine::rollback_operating_cost(&mut self.treasury, amount.0) {
                log!("operating cost rollback failed: {}", e.as_str());
            }
        }
        ok
    }

    // ------------------------------------------------------------ submissions (C-06, C-07)

    /// Submits `answer_hash = sha256(norm(answer) ‖ 0x00 ‖ account_id)` for the open task.
    pub fn submit(&mut self, task_id: TaskId, answer_hash: Base64VecU8) -> Promise {
        let hash = bytes32(&answer_hash, "answer_hash");
        let wallet = env::predecessor_account_id();
        let key = (task_id, wallet.clone());
        let task = self.tasks.get(&task_id).unwrap_or_else(|| fail(engine::Error::TaskNotFound));
        let already = self.subs.contains_key(&key) || self.pending.contains(&key);
        engine::precheck_submission(&self.config, task, wallet.as_str(), env::block_timestamp(), already)
            .unwrap_or_else(|e| fail(e));
        require!(
            self.storage_float() >= MIN_STORAGE_FLOAT.as_yoctonear(),
            "storage float is low: the operator must top up the contract"
        );
        self.pending.insert(key);
        ext_token::ext(self.token.clone())
            .with_static_gas(GAS_HOLDER_INFO)
            .ft_holder_info(wallet.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_BALANCE)
                    .on_balance(task_id, wallet, Base64VecU8(hash.to_vec())),
            )
    }

    #[private]
    pub fn on_balance(&mut self, task_id: TaskId, account_id: AccountId, answer_hash: Base64VecU8) -> SubmitOutcome {
        let key = (task_id, account_id.clone());
        self.pending.remove(&key);
        let reject = |reason: &str| {
            log!("submission rejected: {} ({})", reason, account_id);
            SubmitOutcome { accepted: false, reason: Some(reason.to_string()) }
        };
        let Some(holder) = holder_info_result() else {
            return reject("balance read failed");
        };
        let Ok(hash) = <[u8; 32]>::try_from(answer_hash.0.as_slice()) else {
            return reject("answer_hash must be 32 bytes");
        };
        let Some(task) = self.tasks.get_mut(&task_id) else {
            return reject(engine::Error::TaskNotFound.as_str());
        };
        let employee = self.employees.get(&account_id).cloned();
        let accepted = match engine::accept_submission(
            &self.config,
            task,
            self.last_finalized,
            account_id.as_str(),
            employee,
            hash,
            holder,
            self.total_supply,
            env::block_timestamp(),
        ) {
            Ok(a) => a,
            Err(e) => return reject(e.as_str()),
        };
        let index = task.submitted - 1;
        if accepted.is_new_employee {
            self.employee_ids.push(account_id.clone());
        }
        self.employees.insert(account_id.clone(), accepted.employee);
        self.sub_index.insert((task_id, index), account_id);
        self.subs.insert(key, accepted.submission);
        self.emit(accepted.event);
        SubmitOutcome { accepted: true, reason: None }
    }

    // ------------------------------------------------------------ prove_pass (C-21, D17)

    /// After the reveal and until the next task finalizes: prove your own pass if the boss
    /// left you off the list. Returns the pay booked for you (claim it with `claim_salary`).
    pub fn prove_pass(&mut self, task_id: TaskId) -> U128 {
        let wallet = env::predecessor_account_id();
        let mut events = Vec::new();
        let task = self.tasks.get_mut(&task_id).unwrap_or_else(|| fail(engine::Error::TaskNotFound));
        let sub = self.subs.get_mut(&(task_id, wallet.clone())).unwrap_or_else(|| fail(engine::Error::NoSubmission));
        let emp = self.employees.get_mut(&wallet).unwrap_or_else(|| fail(engine::Error::NoSubmission));
        let pay = engine::prove_pass(
            &HostSha256,
            &self.config,
            task,
            self.last_finalized,
            &mut self.treasury,
            wallet.as_str(),
            sub,
            emp,
            &mut events,
        )
        .unwrap_or_else(|e| fail(e));
        self.emit_all(events);
        U128(pay)
    }

    // ------------------------------------------------------------ claims (C-11)

    pub fn claim_salary(&mut self, task_id: TaskId) -> Promise {
        let wallet = env::predecessor_account_id();
        let task = self.tasks.get(&task_id).unwrap_or_else(|| fail(engine::Error::TaskNotFound));
        let sub = self.subs.get_mut(&(task_id, wallet.clone())).unwrap_or_else(|| fail(engine::Error::NoSubmission));
        engine::begin_claim(task, sub).unwrap_or_else(|e| fail(e));
        ext_token::ext(self.token.clone())
            .with_static_gas(GAS_HOLDER_INFO)
            .ft_holder_info(wallet.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CLAIM_BALANCE).on_claim_balance(task_id, wallet))
    }

    #[private]
    pub fn on_claim_balance(&mut self, task_id: TaskId, account_id: AccountId) -> PromiseOrValue<ClaimOutcome> {
        let balance = holder_info_result().map(|h| h.balance);
        let mut events = Vec::new();
        let Some(sub) = self.subs.get_mut(&(task_id, account_id.clone())) else {
            return PromiseOrValue::Value(ClaimOutcome::Retry { reason: engine::Error::NoSubmission.as_str().into() });
        };
        let resolution =
            engine::resolve_claim(&self.config, &mut self.treasury, task_id, account_id.as_str(), sub, balance, &mut events);
        self.emit_all(events);
        match resolution {
            Ok(ClaimResolution::Pay(amount)) => PromiseOrValue::Promise(
                Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(amount)).then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_TRANSFER)
                        .on_salary_transfer(task_id, account_id, U128(amount)),
                ),
            ),
            Ok(ClaimResolution::Forfeited(amount)) => PromiseOrValue::Value(ClaimOutcome::Forfeited { amount: U128(amount) }),
            Ok(ClaimResolution::Retry) => PromiseOrValue::Value(ClaimOutcome::Retry { reason: "balance read failed".into() }),
            Err(e) => PromiseOrValue::Value(ClaimOutcome::Retry { reason: e.as_str().into() }),
        }
    }

    #[private]
    pub fn on_salary_transfer(&mut self, task_id: TaskId, account_id: AccountId, amount: U128) -> ClaimOutcome {
        let mut events = Vec::new();
        if near_sdk::is_promise_success() {
            if let Some(emp) = self.employees.get_mut(&account_id) {
                engine::confirm_salary(emp, task_id, account_id.as_str(), amount.0, &mut events);
            }
            self.emit_all(events);
            return ClaimOutcome::Paid { amount };
        }
        if let Some(sub) = self.subs.get_mut(&(task_id, account_id.clone())) {
            if let Err(e) = engine::rollback_salary(&mut self.treasury, sub, amount.0) {
                log!("salary rollback failed: {}", e.as_str());
            }
        }
        ClaimOutcome::Retry { reason: "transfer failed".into() }
    }

    // ------------------------------------------------------------ income (C-12)

    /// Adds the attached NEAR to `income_accrued` (allocated at the next finalize).
    #[payable]
    pub fn deposit_income(&mut self, tag: IncomeTag) {
        let amount = env::attached_deposit().as_yoctonear();
        let from = env::predecessor_account_id();
        let event = engine::deposit_income(&mut self.treasury, from.as_str(), amount, tag).unwrap_or_else(|e| fail(e));
        self.emit(event);
    }

    // ------------------------------------------------------------ views (C-13)

    pub fn get_config(&self) -> &Config {
        &self.config
    }

    pub fn get_info(&self) -> ContractInfo {
        ContractInfo {
            owner: self.owner.clone(),
            boss: self.boss.clone(),
            token: self.token.clone(),
            total_supply: U128(self.total_supply),
            current_task_id: self.current_task,
            last_finalized: self.last_finalized,
            event_seq: self.event_seq,
            employees: self.employee_ids.len(),
        }
    }

    pub fn get_current_task_id(&self) -> TaskId {
        self.current_task
    }

    pub fn get_task(&self, task_id: TaskId) -> Option<TaskView> {
        self.tasks.get(&task_id).map(|t| TaskView::new(t, env::block_timestamp()))
    }

    pub fn get_employee(&self, account_id: AccountId) -> Option<EmployeeView> {
        self.employees.get(&account_id).map(|e| self.employee_view(&account_id, e))
    }

    pub fn list_employees(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<EmployeeView> {
        let (from, end) = page(from_index, limit, self.employee_ids.len());
        (from..end)
            .filter_map(|i| {
                let id = self.employee_ids.get(i)?;
                self.employees.get(id).map(|e| self.employee_view(id, e))
            })
            .collect()
    }

    pub fn get_submission(&self, task_id: TaskId, account_id: AccountId) -> Option<SubmissionView> {
        let s = self.subs.get(&(task_id, account_id.clone()))?;
        Some(SubmissionView::new(task_id, account_id.into(), s))
    }

    pub fn list_submissions(&self, task_id: TaskId, from_index: Option<u32>, limit: Option<u32>) -> Vec<SubmissionView> {
        let total = self.tasks.get(&task_id).map_or(0, |t| t.submitted);
        let (from, end) = page(from_index, limit, total);
        (from..end)
            .filter_map(|i| {
                let id = self.sub_index.get(&(task_id, i))?;
                let s = self.subs.get(&(task_id, id.clone()))?;
                Some(SubmissionView::new(task_id, id.to_string(), s))
            })
            .collect()
    }

    pub fn get_claimable(&self, task_id: TaskId, account_id: AccountId) -> U128 {
        let amount = match (self.tasks.get(&task_id), self.subs.get(&(task_id, account_id))) {
            (Some(t), Some(s)) => views::claimable(t, s),
            _ => 0,
        };
        U128(amount)
    }

    pub fn get_treasury(&self) -> TreasuryView {
        TreasuryView::new(&self.treasury, &self.config)
    }

    /// Free balance outside the books and the storage stake. Top it up with a plain transfer.
    pub fn get_storage_float(&self) -> U128 {
        U128(self.storage_float())
    }

    /// Events with `seq > since_seq`, oldest first, from the ring buffer (last 512).
    pub fn get_events(&self, since_seq: u64, limit: Option<u32>) -> Vec<&EventEntry> {
        if self.event_seq == 0 {
            return Vec::new();
        }
        let start = since_seq.saturating_add(1).max(ring_oldest(self.event_seq));
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as u64;
        let end = self.event_seq.min(start.saturating_add(limit).saturating_sub(1));
        (start..=end).filter_map(|seq| self.events.get(&ring_slot(seq))).collect()
    }
}

// ---------------------------------------------------------------- internals

fn page(from_index: Option<u32>, limit: Option<u32>, total: u32) -> (u32, u32) {
    let from = from_index.unwrap_or(0).min(total);
    let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
    (from, from.saturating_add(limit).min(total))
}

impl Reorg {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_boss(&self) {
        require!(env::predecessor_account_id() == self.boss, "boss only");
    }

    fn storage_float(&self) -> u128 {
        let stake = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(stake).saturating_sub(self.treasury.books())
    }

    fn employee_view(&self, id: &AccountId, e: &Employee) -> EmployeeView {
        let recent = views::recent_results(e, self.current_task, self.last_finalized, |t| {
            self.subs.get(&(t, id.clone())).map(|s| s.passed)
        });
        EmployeeView::new(id.to_string(), e, &self.config, self.last_finalized, recent)
    }

    /// NEP-297 log plus ring buffer (D8).
    fn emit(&mut self, event: Event) {
        self.event_seq += 1;
        let entry = EventEntry { seq: self.event_seq, at: env::block_timestamp(), event };
        // The adjacently-tagged event serializes as `{"event":"<name>","data":{…}}`; reuse that
        // string for the NEP-297 envelope instead of building a JSON tree (smaller wasm, less gas).
        let name = entry.event.name();
        let tagged = serde_json::to_string(&entry.event).unwrap_or_default();
        let prefix = r#"{"event":""#.len() + name.len() + r#"","data":"#.len();
        let data = tagged.get(prefix..tagged.len().saturating_sub(1)).unwrap_or("null");
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{name}","data":[{data}]}}"#
        ));
        self.events.insert(ring_slot(entry.seq), entry);
    }

    fn emit_all(&mut self, events: Vec<Event>) {
        for e in events {
            self.emit(e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .block_timestamp(ts)
            .account_balance(NearToken::from_near(10))
            .build());
    }

    fn contract() -> Reorg {
        ctx(accounts(0), 1);
        let cfg = Config { min_window_ns: 10, ..Config::default() };
        Reorg::new(cfg, accounts(4), accounts(1), U128(1_000_000_000 * 10u128.pow(18)), None)
    }

    #[test]
    #[should_panic(expected = "config: tier_bucket_bps must sum to 10000")]
    fn init_validates_config() {
        ctx(accounts(0), 1);
        let cfg = Config { tier_bucket_bps: [1, 2, 3, 4], ..Config::default() };
        Reorg::new(cfg, accounts(4), accounts(1), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "boss only")]
    fn open_task_is_boss_only() {
        let mut c = contract();
        c.open_task(TaskKind::DecodeMemo, Base64VecU8(vec![0; 32]), U64(100));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn admin_is_owner_only() {
        let mut c = contract();
        ctx(accounts(1), 2);
        c.set_boss(accounts(2));
    }

    #[test]
    fn open_task_emits_nep297_and_ring() {
        let mut c = contract();
        ctx(accounts(1), 5);
        let id = c.open_task(TaskKind::DecodeMemo, Base64VecU8(vec![7; 32]), U64(100));
        assert_eq!(id, 1);
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let json: serde_json::Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(json["standard"], "reorg");
        assert_eq!(json["event"], "task_opened");
        assert_eq!(json["data"][0]["task_id"], 1);
        assert_eq!(json["data"][0]["kind"], "decode_memo");
        assert_eq!(json["data"][0]["closes_at"], "100");
        let ev = serde_json::to_value(c.get_events(0, None)).unwrap();
        assert_eq!(ev[0]["seq"], 1);
        assert_eq!(ev[0]["at"], "5");
        assert_eq!(ev[0]["event"], "task_opened");
        assert_eq!(ev[0]["data"], json["data"][0]);
        // Second open before finalize fails.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.open_task(TaskKind::DecodeMemo, Base64VecU8(vec![7; 32]), U64(100))
        }));
        assert!(r.is_err());
    }

    #[test]
    fn ring_buffer_wraps() {
        let mut c = contract();
        for _ in 0..12 {
            ctx(accounts(2), 3); // fresh call: NEAR allows 100 logs per call
            for _ in 0..50 {
                c.emit(Event::Rehired { task_id: 1, account_id: "x".into() });
            }
        }
        assert_eq!(c.event_seq, 600);
        let first = c.get_events(0, Some(5));
        assert_eq!(first.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![89, 90, 91, 92, 93], "oldest kept is 600-511");
        let tail = c.get_events(595, None);
        assert_eq!(tail.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![596, 597, 598, 599, 600]);
        assert!(c.get_events(600, None).is_empty());
        assert_eq!(c.get_events(100, Some(1000)).len(), MAX_PAGE as usize);
    }

    #[test]
    fn deposit_income_books_and_event() {
        let mut c = contract();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(3))
            .attached_deposit(NearToken::from_near(2))
            .account_balance(NearToken::from_near(12))
            .build());
        c.deposit_income(IncomeTag::Seed);
        let t = serde_json::to_value(c.get_treasury()).unwrap();
        assert_eq!(t["income_accrued"], NearToken::from_near(2).as_yoctonear().to_string());
        assert_eq!(t["income_by_tag"]["seed"], NearToken::from_near(2).as_yoctonear().to_string());
        assert_eq!(t["runway_tasks"], 0);
        assert_eq!(c.get_events(0, None)[0].event.name(), "income_deposited");
    }

    const SELF_ID: &str = "reorg.near";
    const TOKENS: u128 = 10u128.pow(18);

    /// A callback context: predecessor = the contract itself, with one promise result.
    fn callback_ctx(ts: u64, result: near_sdk::PromiseResult) {
        let me: AccountId = SELF_ID.parse().unwrap();
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(me.clone())
                .predecessor_account_id(me)
                .block_timestamp(ts)
                .account_balance(NearToken::from_near(10))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    fn holder_json(balance: u128, last_received_at: u64) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(
            format!(r#"{{"balance":"{balance}","last_received_at":"{last_received_at}"}}"#).into_bytes(),
        )
    }

    fn boss_ctx(ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(SELF_ID.parse().unwrap())
            .predecessor_account_id(accounts(1))
            .block_timestamp(ts)
            .account_balance(NearToken::from_near(10))
            .build());
    }

    /// C-07 / R-04: callbacks remove the pending marker on every path, accept valid
    /// submissions, and reject a read that lands after finalization started.
    #[test]
    fn on_balance_paths() {
        let mut c = contract();
        let secret = [5u8; 32];
        boss_ctx(10);
        c.open_task(TaskKind::DecodeMemo, Base64VecU8(env::sha256_array(secret).to_vec()), U64(100));
        let (a, b, d) = (accounts(2), accounts(3), accounts(5));
        for w in [&a, &b, &d] {
            c.pending.insert((1, w.clone()));
        }

        // Accepted: 1M tokens of a 1e9 supply is an Intern; received before opens_at.
        callback_ctx(20, holder_json(1_000_000 * TOKENS, 9));
        let out = c.on_balance(1, a.clone(), Base64VecU8(vec![1; 32]));
        assert_eq!(out, SubmitOutcome { accepted: true, reason: None });
        assert!(!c.pending.contains(&(1, a.clone())));
        let sub = serde_json::to_value(c.get_submission(1, a.clone()).unwrap()).unwrap();
        assert_eq!(sub["tier"], 3);
        assert_eq!(sub["claim"], "unclaimed");
        assert_eq!(c.list_submissions(1, None, None).len(), 1);
        assert_eq!(c.get_info().employees, 1);

        // Failed read: rejected, marker removed, nothing stored.
        callback_ctx(21, near_sdk::PromiseResult::Failed);
        let out = c.on_balance(1, b.clone(), Base64VecU8(vec![1; 32]));
        assert_eq!(out.reason.as_deref(), Some("balance read failed"));
        assert!(!c.pending.contains(&(1, b.clone())));
        assert!(c.get_submission(1, b).is_none());

        // Late callback: finalization started while the read was in flight.
        boss_ctx(100);
        c.finalize_task(1, Base64VecU8(secret.to_vec()), vec![], false);
        callback_ctx(101, holder_json(1_000_000 * TOKENS, 9));
        let out = c.on_balance(1, d.clone(), Base64VecU8(vec![1; 32]));
        assert_eq!(out.reason.as_deref(), Some("task is not open"));
        assert!(!c.pending.contains(&(1, d.clone())));
        assert!(c.get_employee(d).is_none());
        let t = serde_json::to_value(c.get_task(1).unwrap()).unwrap();
        assert_eq!((t["status"].as_str(), t["submitted"].as_u64()), (Some("finalizing"), Some(1)));
    }

    #[test]
    fn config_respects_log_limit() {
        ctx(accounts(0), 1);
        let ok = Config { max_passers_per_call: 97, ..Config::default() };
        Reorg::new(ok, accounts(4), accounts(1), U128(1), None);
        let r = std::panic::catch_unwind(|| {
            let bad = Config { max_passers_per_call: 49, streak_milestones: vec![1, 3], ..Config::default() };
            Reorg::new(bad, accounts(4), accounts(1), U128(1), None)
        });
        assert!(r.is_err(), "2 logs per passer × 49 + 3 > 100");
    }

    #[test]
    fn excluded_accounts_admin() {
        let mut c = contract();
        ctx(accounts(0), 2);
        c.set_excluded(vec![accounts(2), accounts(3)], true);
        c.set_excluded(vec![accounts(2)], true);
        assert_eq!(c.get_config().excluded_accounts, vec![accounts(2).to_string(), accounts(3).to_string()]);
        c.set_excluded(vec![accounts(2)], false);
        assert_eq!(c.get_config().excluded_accounts, vec![accounts(3).to_string()]);
    }
}
