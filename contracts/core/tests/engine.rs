//! Engine scenarios on an in-memory host (C-10, C-12, C-16, D4, D5, D17).
//! The host here is deliberately dumb, so these tests pin down the rules any chain adapter
//! inherits, including the books invariant: cash held == reserve + accrued + outstanding.

use reorg_core::crypto::{expected_answer_hash, Sha256, SoftSha256};
use reorg_core::engine::{self, ClaimResolution, Error};
use reorg_core::model::*;
use reorg_core::rules::{employee_state, EmployeeStatus};
use reorg_core::views::{claimable, recent_results, TaskResult, TaskView};
use reorg_core::{Config, Event, TaskId};
use std::collections::HashMap;

const H: SoftSha256 = SoftSha256;
const TOKEN: u128 = 1_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SUPPLY: u128 = 1_000_000_000 * TOKEN;

struct Game {
    cfg: Config,
    now: u64,
    current: TaskId,
    last_finalized: TaskId,
    tasks: HashMap<TaskId, Task>,
    subs: HashMap<(TaskId, String), Submission>,
    emps: HashMap<String, Employee>,
    holders: HashMap<String, HolderInfo>,
    treasury: Treasury,
    secrets: HashMap<TaskId, [u8; 32]>,
    events: Vec<Event>,
    /// Native currency actually held by the "contract" for the company.
    cash: u128,
    paid_out: HashMap<String, u128>,
    operator: u128,
}

impl Game {
    fn new(cfg: Config) -> Self {
        Self {
            cfg,
            now: 1_000,
            current: 0,
            last_finalized: 0,
            tasks: HashMap::new(),
            subs: HashMap::new(),
            emps: HashMap::new(),
            holders: HashMap::new(),
            treasury: Treasury::default(),
            secrets: HashMap::new(),
            events: Vec::new(),
            cash: 0,
            paid_out: HashMap::new(),
            operator: 0,
        }
    }

    fn check_books(&self) {
        assert_eq!(self.cash, self.treasury.books(), "cash held must equal the books");
    }

    fn hold(&mut self, w: &str, balance: u128) {
        self.holders.insert(w.into(), HolderInfo { balance, last_received_at: self.now });
        self.now += 1;
    }

    fn deposit(&mut self, amount: u128) {
        let ev = engine::deposit_income(&mut self.treasury, "bot", amount, IncomeTag::ClientJob).unwrap();
        self.cash += amount;
        self.events.push(ev);
        self.check_books();
    }

    fn open(&mut self) -> TaskId {
        let id = self.current + 1;
        let secret = H.sha256(&id.to_le_bytes());
        let closes = self.now + self.cfg.min_window_ns;
        let (task, ev) = engine::open_task(&self.cfg, self.current, self.last_finalized, TaskKind::DecodeMemo, H.sha256(&secret), closes, self.now).unwrap();
        self.tasks.insert(id, task);
        self.secrets.insert(id, secret);
        self.current = id;
        self.events.push(ev);
        self.now += 1;
        id
    }

    fn submit(&mut self, w: &str, correct: bool) -> Result<bool, Error> {
        let id = self.current;
        let key = (id, w.to_string());
        let task = self.tasks.get_mut(&id).ok_or(Error::TaskNotFound)?;
        engine::precheck_submission(&self.cfg, task, w, self.now, self.subs.contains_key(&key))?;
        let answer = if correct { expected_answer_hash(&H, &self.secrets[&id], w) } else { [1; 32] };
        let holder = self.holders.get(w).copied().unwrap_or_default();
        let acc = engine::accept_submission(&self.cfg, task, self.last_finalized, w, self.emps.get(w).cloned(), answer, holder, SUPPLY, self.now)?;
        let reapply = acc.submission.reapply;
        self.emps.insert(w.into(), acc.employee);
        self.subs.insert(key, acc.submission);
        self.events.push(acc.event);
        Ok(reapply)
    }

    /// Boss: recompute passers from the revealed secret, finalize in batches of `batch`.
    fn finalize(&mut self, batch: usize) {
        let id = self.current;
        let secret = self.secrets[&id];
        self.now = self.tasks[&id].closes_at;
        let mut passers: Vec<String> = self
            .subs
            .iter()
            .filter(|((t, w), s)| *t == id && s.answer_hash == expected_answer_hash(&H, &secret, w))
            .map(|((_, w), _)| w.clone())
            .collect();
        passers.sort();
        let task = self.tasks.get_mut(&id).unwrap();
        engine::begin_finalize(&H, &self.cfg, task, &mut self.treasury, &secret, self.now).unwrap();
        for chunk in passers.chunks(batch.max(1)) {
            engine::check_batch(&self.cfg, chunk.len()).unwrap();
            engine::begin_finalize(&H, &self.cfg, task, &mut self.treasury, &secret, self.now).unwrap();
            for w in chunk {
                let s = self.subs.get_mut(&(id, w.clone())).unwrap();
                let e = self.emps.get_mut(w).unwrap();
                engine::verify_passer(&H, &self.cfg, task, w, s, e, &mut self.events).unwrap();
            }
        }
        let op = engine::settle(&self.cfg, task, &mut self.treasury, self.now, &mut self.events).unwrap();
        self.cash -= op;
        self.operator += op;
        self.last_finalized = id;
        let a = task.allocation.as_ref().unwrap();
        assert_eq!(a.total_payable() + a.settlement.as_ref().unwrap().to_reserve, a.income);
        self.now += 1;
        self.check_books();
    }

    fn claim(&mut self, task_id: TaskId, w: &str) -> Result<ClaimResolution, Error> {
        let task = self.tasks.get(&task_id).ok_or(Error::TaskNotFound)?;
        let s = self.subs.get_mut(&(task_id, w.to_string())).ok_or(Error::NoSubmission)?;
        engine::begin_claim(task, s)?;
        let current = self.holders.get(w).map(|h| h.balance);
        let r = engine::resolve_claim(&self.cfg, &mut self.treasury, task_id, w, s, current, &mut self.events)?;
        if let ClaimResolution::Pay(amount) = r {
            self.cash -= amount;
            *self.paid_out.entry(w.into()).or_default() += amount;
            engine::confirm_salary(self.emps.get_mut(w).unwrap(), task_id, w, amount, &mut self.events);
        }
        self.check_books();
        Ok(r)
    }

    fn state(&self, w: &str) -> reorg_core::rules::EmployeeState {
        employee_state(&self.emps[w], self.last_finalized, self.cfg.layoff_after, self.cfg.layoff_len)
    }
}

fn demo_cfg() -> Config {
    Config { operating_cost: 0, reserve_low: 0, min_window_ns: 50, ..Config::default() }
}

/// Spec §5.3 end to end: three interns (100k/50k/50k of a 1e8 supply would be Interns; here
/// we pick balances that are Interns of a 1e9 supply), 20 NEAR income.
#[test]
fn spec_5_3_worked_example_and_claims() {
    let mut g = Game::new(demo_cfg());
    g.hold("a", 1_000_000 * TOKEN);
    g.hold("b", 500_000 * TOKEN);
    g.hold("c", 500_000 * TOKEN);
    g.deposit(20 * NEAR);
    g.open();
    g.submit("a", true).unwrap();
    g.submit("b", false).unwrap();
    g.submit("c", true).unwrap();
    g.finalize(50);
    let pay = |g: &Game, w: &str| g.subs[&(1, w.to_string())].pay;
    assert_eq!(pay(&g, "a"), 9 * NEAR / 10);
    assert_eq!(pay(&g, "b"), 0);
    assert_eq!(pay(&g, "c"), 45 * NEAR / 100);
    // 20 − 0.9 − 0.45 = 18.65 NEAR stays in the reserve.
    assert_eq!(g.treasury.reserve, 20 * NEAR - 135 * NEAR / 100);

    assert_eq!(g.claim(1, "a"), Ok(ClaimResolution::Pay(9 * NEAR / 10)));
    assert_eq!(g.claim(1, "a"), Err(Error::AlreadyClaimed), "double claim");
    assert_eq!(g.claim(1, "b"), Err(Error::NotAPasser));
    // c dumps below 90% → forfeit to the reserve.
    g.holders.get_mut("c").unwrap().balance = 500_000 * TOKEN * 9 / 10 - 1;
    assert_eq!(g.claim(1, "c"), Ok(ClaimResolution::Forfeited(45 * NEAR / 100)));
    assert_eq!(g.treasury.reserve, 20 * NEAR - 9 * NEAR / 10);
    assert_eq!(g.treasury.outstanding, 0);
    assert!(g.events.iter().any(|e| matches!(e, Event::SalaryForfeited { .. })));
    assert_eq!(g.emps["a"].total_earned, 9 * NEAR / 10);
}

/// Demo wallet F (roadmap D-02): pass 1, miss 2-4 → laid off, pass 5 as reapply → rehired.
#[test]
fn layoff_and_rehire() {
    let mut g = Game::new(demo_cfg());
    g.hold("F", 600_000 * TOKEN);
    g.hold("x", 600_000 * TOKEN);
    for t in 1..=5u64 {
        g.deposit(NEAR);
        g.open();
        g.submit("x", true).unwrap();
        match t {
            1 => assert!(!g.submit("F", true).unwrap()),
            5 => {
                assert_eq!(g.state("F").status, EmployeeStatus::LaidOff);
                assert!(g.submit("F", true).unwrap(), "laid-off wallet submits as reapply");
            }
            _ => {}
        }
        g.finalize(1);
        match t {
            2 => assert_eq!(g.state("F").status, EmployeeStatus::Struggling),
            3 => assert_eq!(g.state("F").misses_in_row, 2),
            4 => {
                let st = g.state("F");
                assert!(st.laid_off);
                assert_eq!(st.layoff_tasks_left, 7);
            }
            _ => {}
        }
    }
    let f = &g.emps["F"];
    assert_eq!(g.state("F").status, EmployeeStatus::Active);
    assert_eq!(f.badges & BADGE_REHIRED, BADGE_REHIRED);
    assert_eq!(f.streak, 1);
    let s5 = &g.subs[&(5, "F".to_string())];
    assert!(s5.passed && s5.reapply && s5.pay == 0 && s5.weight > 0);
    assert_eq!(g.claim(5, "F"), Err(Error::NotAPasser), "reapply passes are never paid");
    assert!(g.events.iter().any(|e| matches!(e, Event::Rehired { task_id: 5, .. })));
    // x passed 5 in a row: milestone 3 fired once.
    let milestones: Vec<_> = g.events.iter().filter(|e| matches!(e, Event::StreakMilestone { account_id, .. } if account_id == "x")).collect();
    assert_eq!(milestones.len(), 1);
    assert_eq!(g.emps["x"].streak, 5);
    assert_eq!(g.subs[&(5, "x".to_string())].multiplier_bps, 14_000, "streak 4 before task 5");

    // Recent results, newest first: 5 pass, 4/3/2 miss, 1 pass.
    let r = recent_results(&g.emps["F"], g.current, g.last_finalized, |t| g.subs.get(&(t, "F".into())).map(|s| s.passed));
    let got: Vec<_> = r.iter().map(|x| (x.task_id, x.result)).collect();
    use TaskResult::*;
    assert_eq!(got, vec![(5, Pass), (4, Miss), (3, Miss), (2, Miss), (1, Pass)]);
}

#[test]
fn submission_rules() {
    let mut cfg = demo_cfg();
    cfg.excluded_accounts = vec!["deployer".into()];
    let mut g = Game::new(cfg);
    g.hold("deployer", 500_000_000 * TOKEN);
    g.hold("whale", 50_000_000 * TOKEN);
    g.hold("visitor", 10 * TOKEN);
    g.open();
    assert_eq!(g.submit("deployer", true), Err(Error::Excluded));
    assert_eq!(g.submit("visitor", true), Err(Error::Visitor));
    assert_eq!(g.submit("nobody", true), Err(Error::Visitor));
    g.submit("whale", true).unwrap();
    assert_eq!(g.subs[&(1, "whale".into())].tier, 0);
    assert_eq!(g.submit("whale", true), Err(Error::AlreadySubmitted));

    // D15: tokens received at/after opens_at → rejected; no state change.
    g.hold("recycler", 50_000_000 * TOKEN);
    let before = g.tasks[&1].clone();
    assert_eq!(g.submit("recycler", true), Err(Error::RecycledTokens));
    assert_eq!(g.tasks[&1], before);
    assert!(!g.emps.contains_key("recycler"));

    // Window closes; a new task can't open before finalize; finalize can't start early.
    let task = g.tasks.get_mut(&1).unwrap();
    let closes = task.closes_at;
    assert_eq!(engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &g.secrets[&1], closes - 1), Err(Error::TaskStillOpen));
    assert_eq!(engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &[0; 32], closes), Err(Error::BadSecret));
    assert_eq!(engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &[0; 31], closes), Err(Error::BadSecret));
    assert!(engine::open_task(&g.cfg, 1, 0, TaskKind::DecodeMemo, [0; 32], g.now + 100, g.now).is_err());
    g.now = closes;
    assert_eq!(g.submit("late", true), Err(Error::WindowClosed));
    assert_eq!(TaskView::new(&g.tasks[&1], g.now).status, reorg_core::views::TaskStatusView::Closed);

    // Late callback after finalize started: the read was in flight, now rejected.
    let task = g.tasks.get_mut(&1).unwrap();
    engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &g.secrets[&1], closes).unwrap();
    let h = HolderInfo { balance: 50_000_000 * TOKEN, last_received_at: 0 };
    let r = engine::accept_submission(&g.cfg, task, 0, "slow", None, [0; 32], h, SUPPLY, closes);
    assert!(matches!(r, Err(Error::TaskNotOpen)));
    assert_eq!(engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &[0; 32], closes), Err(Error::SecretMismatch));

    // Duplicate passer and wrong answers fail the call.
    let s = g.subs.get_mut(&(1, "whale".into())).unwrap();
    let e = g.emps.get_mut("whale").unwrap();
    engine::verify_passer(&H, &g.cfg, task, "whale", s, e, &mut g.events).unwrap();
    assert_eq!(engine::verify_passer(&H, &g.cfg, task, "whale", s, e, &mut g.events), Err(Error::DuplicatePasser));
    let mut cfg_small = g.cfg.clone();
    cfg_small.max_passers_per_call = 2;
    assert_eq!(engine::check_batch(&cfg_small, 3), Err(Error::TooManyPassers));

    // Window too short.
    assert_eq!(
        engine::open_task(&g.cfg, 0, 0, TaskKind::DecodeMemo, [0; 32], g.now + g.cfg.min_window_ns - 1, g.now).err(),
        Some(Error::WindowTooShort)
    );
}

/// D17: the boss leaves an honest passer off the list; they prove it themselves and get
/// exactly their D1 share, moved from the reserve. The window closes when N+1 finalizes.
#[test]
fn prove_pass_after_censorship() {
    let mut g = Game::new(demo_cfg());
    g.hold("honest", 600_000 * TOKEN);
    g.hold("other", 600_000 * TOKEN);
    g.deposit(10 * NEAR);
    g.open();
    g.submit("honest", true).unwrap();
    g.submit("other", true).unwrap();
    // Censoring boss: finalize with an empty pass list.
    let secret = g.secrets[&1];
    g.now = g.tasks[&1].closes_at;
    let task = g.tasks.get_mut(&1).unwrap();
    engine::begin_finalize(&H, &g.cfg, task, &mut g.treasury, &secret, g.now).unwrap();
    engine::settle(&g.cfg, task, &mut g.treasury, g.now, &mut g.events).unwrap();
    g.last_finalized = 1;
    let reserve_before = g.treasury.reserve;

    let s = g.subs.get_mut(&(1, "honest".into())).unwrap();
    let e = g.emps.get_mut("honest").unwrap();
    let pay = engine::prove_pass(&H, &g.cfg, task, 1, &mut g.treasury, "honest", s, e, &mut g.events).unwrap();
    // Two equal interns: each gets half of the intern bucket.
    let bucket = task.allocation.as_ref().unwrap().buckets[3];
    assert_eq!(pay, bucket / 2);
    assert_eq!(g.treasury.reserve, reserve_before - pay);
    assert_eq!(g.treasury.outstanding, pay);
    assert_eq!(e.last_pass_day, Some(1));
    assert_eq!(claimable(task, s), pay);
    let a = task.allocation.as_ref().unwrap();
    assert_eq!(a.total_payable() + a.settlement.as_ref().unwrap().to_reserve, a.income);
    assert_eq!(engine::prove_pass(&H, &g.cfg, task, 1, &mut g.treasury, "honest", s, e, &mut g.events), Err(Error::DuplicatePasser));
    g.check_books();
    assert_eq!(g.claim(1, "honest"), Ok(ClaimResolution::Pay(pay)));

    // Wrong answer can't be proven; after task 2 finalizes the window is closed.
    g.open();
    g.finalize(10);
    let task = g.tasks.get_mut(&1).unwrap();
    let s = g.subs.get_mut(&(1, "other".into())).unwrap();
    let e = g.emps.get_mut("other").unwrap();
    assert_eq!(engine::prove_pass(&H, &g.cfg, task, 2, &mut g.treasury, "other", s, e, &mut g.events), Err(Error::ProveWindowClosed));
}

#[test]
fn claim_retry_and_rollback() {
    let mut g = Game::new(demo_cfg());
    g.hold("a", 600_000 * TOKEN);
    g.deposit(NEAR);
    g.open();
    g.submit("a", true).unwrap();
    g.finalize(1);
    let task = g.tasks[&1].clone();
    let s = g.subs.get_mut(&(1, "a".into())).unwrap();
    let pay = engine::begin_claim(&task, s).unwrap();
    assert_eq!(s.claim, ClaimState::Pending);
    assert_eq!(engine::begin_claim(&task, s), Err(Error::AlreadyClaimed), "same-block double claim");
    // Balance read failed → unclaimed again.
    assert_eq!(engine::resolve_claim(&g.cfg, &mut g.treasury, 1, "a", s, None, &mut g.events), Ok(ClaimResolution::Retry));
    assert_eq!(s.claim, ClaimState::Unclaimed);
    // Transfer failed → books and claim restored.
    engine::begin_claim(&task, s).unwrap();
    let r = engine::resolve_claim(&g.cfg, &mut g.treasury, 1, "a", s, Some(600_000 * TOKEN), &mut g.events).unwrap();
    assert_eq!(r, ClaimResolution::Pay(pay));
    engine::rollback_salary(&mut g.treasury, s, pay).unwrap();
    assert_eq!(s.claim, ClaimState::Unclaimed);
    g.check_books();
    assert_eq!(g.claim(1, "a"), Ok(ClaimResolution::Pay(pay)));
}

#[test]
fn operating_cost_and_reserve_low() {
    let cfg = Config { operating_cost: NEAR / 10, reserve_low: NEAR, min_window_ns: 50, ..Config::default() };
    let mut g = Game::new(cfg);
    g.deposit(NEAR);
    g.open();
    g.finalize(1);
    // Nobody submitted: everything to the reserve, minus 0.1 NEAR operating cost.
    assert_eq!(g.treasury.reserve, NEAR - NEAR / 10);
    assert_eq!(g.operator, NEAR / 10);
    let low = g.events.iter().any(|e| matches!(e, Event::ReserveLow { .. }));
    assert!(low);
    // Failed operator transfer is rolled back into the reserve.
    engine::rollback_operating_cost(&mut g.treasury, NEAR / 10).unwrap();
    assert_eq!(g.treasury.reserve, NEAR);
    assert_eq!(g.treasury.total_operating_cost, 0);
    // Zero income: operating cost is capped by the reserve.
    let mut g = Game::new(Config { operating_cost: NEAR, ..demo_cfg() });
    g.open();
    g.finalize(1);
    assert_eq!(g.operator, 0);
    assert_eq!(engine::deposit_income(&mut g.treasury, "x", 0, IncomeTag::Seed).err(), Some(Error::ZeroDeposit));
}

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// C-10 / C-12 property: random multi-task games. After every step the books equal the cash
/// held, each task's income is fully split between payable and reserve, nobody is paid more
/// than allocated, and pay never depends on the finalize batch size.
#[test]
fn random_games_keep_books_exact() {
    for seed in 1..=40u64 {
        let mut r = XorShift(seed.wrapping_mul(0x2545_f491_4f6c_dd1d));
        let cfg = Config {
            operating_cost: (r.below(3) as u128) * NEAR / 10,
            reserve_low: NEAR,
            min_window_ns: 50,
            layoff_len: r.below(8) as u32,
            ..Config::default()
        };
        let mut g = Game::new(cfg);
        let wallets: Vec<String> = (0..14).map(|i| format!("w{i}")).collect();
        for w in &wallets {
            // Visitors up to whales.
            let bal = [TOKEN, 600_000 * TOKEN, 3_000_000 * TOKEN, 12_000_000 * TOKEN, 40_000_000 * TOKEN][r.below(5) as usize];
            g.hold(w, bal + r.below(1_000_000) as u128);
        }
        let mut allocated = 0u128;
        for _ in 0..25 {
            g.deposit(1 + r.below(50) as u128 * NEAR / 7 + r.below(1000) as u128);
            let id = g.open();
            for w in &wallets {
                if r.below(10) < 7 {
                    let _ = g.submit(w, r.below(10) < 8);
                }
            }
            g.finalize(1 + r.below(4) as usize);
            allocated += g.tasks[&id].allocation.as_ref().unwrap().total_payable();
            // Some holders dump a little or a lot, then a random subset claims old tasks.
            for w in &wallets {
                if r.below(10) == 0 {
                    let h = g.holders.get_mut(w).unwrap();
                    h.balance = h.balance * (80 + r.below(21) as u128) / 100;
                }
            }
            for _ in 0..8 {
                let t = 1 + r.below(id);
                let w = &wallets[r.below(wallets.len() as u64) as usize];
                let _ = g.claim(t, w);
            }
        }
        let paid: u128 = g.paid_out.values().sum();
        assert_eq!(paid + g.treasury.total_forfeited + g.treasury.outstanding, allocated, "seed {seed}");
        assert_eq!(paid, g.treasury.total_paid);
        assert_eq!(g.operator, g.treasury.total_operating_cost);
        g.check_books();
    }
}
