//! Sandbox harness: deploys the real token and contract, creates players, and plays the boss
//! (secrets, commits, passer lists) the way the boss service will, using `reorg-core`.
#![allow(dead_code)]

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use reorg_core::crypto::{expected_answer_hash, Sha256, SoftSha256};
use serde_json::{json, Value};

pub const TOKEN: u128 = 1_000_000_000_000_000_000;
pub const SUPPLY: u128 = 1_000_000_000 * TOKEN;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const MAX_GAS: Gas = Gas::from_tgas(300);
/// What a wallet should attach to `submit` / `claim_salary` (each burns well under 60 Tgas).
pub const USER_GAS: Gas = Gas::from_tgas(100);
/// Long enough for setup transactions; tests fast-forward past it.
pub const WINDOW_NS: u64 = 600_000_000_000;

pub fn b64(v: &[u8]) -> String {
    STANDARD.encode(v)
}

fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("{path} missing: run `npm run contracts:build` first"))
}

pub fn default_config() -> Value {
    json!({
        "tier_thresholds_ppm": [30000, 10000, 2500, 10],
        "tier_bucket_bps": [3500, 3000, 2000, 1500],
        "payroll_bps": 6000, "reserve_bps": 3000, "jackpot_bps": 1000,
        "streak_step_bps": 1000, "streak_max_steps": 5, "streak_milestones": [3, 7, 14],
        "layoff_after": 3, "layoff_len": 7, "antidump_bps": 9000, "bankruptcy_empty_tasks": 3,
        "operating_cost": "0", "reserve_low": "0",
        "min_window_ns": "1000000000", "max_passers_per_call": 50,
        "excluded_accounts": [],
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub deployer: Account,
    pub boss: Account,
    pub token: Contract,
    pub reorg: Contract,
    secret_counter: std::sync::atomic::AtomicU64,
}

pub struct OpenTask {
    pub id: u64,
    pub secret: [u8; 32],
    pub closes_at: u64,
}

impl Env {
    /// Deploys token + contract. `cfg` overrides keys of `default_config()`.
    pub async fn new(cfg: Value) -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let deployer = sub(&root, "deployer", 50).await?;
        let boss = sub(&root, "boss", 20).await?;
        let token = deployer
            .create_subaccount("token")
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()?
            .deploy(&wasm("reorg_token"))
            .await?
            .into_result()?;
        token
            .call("new")
            .args_json(json!({
                "owner_id": deployer.id(),
                "total_supply": SUPPLY.to_string(),
                "metadata": { "spec": "ft-1.0.0", "name": "REORG", "symbol": "REORG", "decimals": 18 },
            }))
            .transact()
            .await?
            .into_result()?;
        let reorg = deployer
            .create_subaccount("reorg")
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()?
            .deploy(&wasm("reorg_contract"))
            .await?
            .into_result()?;
        let mut config = default_config();
        for (k, v) in cfg.as_object().into_iter().flatten() {
            config[k] = v.clone();
        }
        config["excluded_accounts"] = json!([deployer.id(), reorg.id(), token.id()]);
        reorg
            .call("new")
            .args_json(json!({
                "config": config,
                "token": token.id(),
                "boss": boss.id(),
                "total_supply": SUPPLY.to_string(),
                "owner": deployer.id(),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(Self { worker, root, deployer, boss, token, reorg, secret_counter: 0.into() })
    }

    /// A player account holding `tokens` whole $REORG (registered with the token).
    pub async fn player(&self, name: &str, tokens: u128) -> Result<Account> {
        let acc = sub(&self.root, name, 30).await?;
        self.register(&acc).await?;
        if tokens > 0 {
            self.send_tokens(&self.deployer, &acc, tokens * TOKEN).await?;
        }
        Ok(acc)
    }

    pub async fn register(&self, acc: &Account) -> Result<()> {
        let bounds: Value = self.token.view("storage_balance_bounds").await?.json()?;
        let min: u128 = bounds["min"].as_str().unwrap().parse()?;
        acc.call(self.token.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_yoctonear(min))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn send_tokens(&self, from: &Account, to: &Account, amount: u128) -> Result<()> {
        from.call(self.token.id(), "ft_transfer")
            .args_json(json!({ "receiver_id": to.id(), "amount": amount.to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn now(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.reorg.view(method).args_json(args).await?.json()?)
    }

    pub async fn deposit_income(&self, near_yocto: u128) -> Result<()> {
        self.root
            .call(self.reorg.id(), "deposit_income")
            .args_json(json!({ "tag": "client_job" }))
            .deposit(NearToken::from_yoctonear(near_yocto))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn open(&self) -> Result<OpenTask> {
        let n = self.secret_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let secret = SoftSha256.sha256(format!("sandbox-secret-{n}").as_bytes());
        let closes_at = self.now().await? + WINDOW_NS;
        let res = self
            .boss
            .call(self.reorg.id(), "open_task")
            .args_json(json!({
                "kind": "decode_memo",
                "commit_hash": b64(&SoftSha256.sha256(&secret)),
                "closes_at": closes_at.to_string(),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(OpenTask { id: res.json()?, secret, closes_at })
    }

    /// Submits the right (or a wrong) answer hash. Returns the raw result.
    pub async fn submit(&self, acc: &Account, task: &OpenTask, correct: bool) -> Result<ExecutionFinalResult> {
        let hash = if correct {
            expected_answer_hash(&SoftSha256, &task.secret, acc.id().as_str())
        } else {
            SoftSha256.sha256(b"WRONG")
        };
        Ok(acc
            .call(self.reorg.id(), "submit")
            .args_json(json!({ "task_id": task.id, "answer_hash": b64(&hash) }))
            .gas(USER_GAS)
            .transact()
            .await?)
    }

    /// Submits and returns the callback's `SubmitOutcome`.
    pub async fn submit_outcome(&self, acc: &Account, task: &OpenTask, correct: bool) -> Result<Value> {
        Ok(self.submit(acc, task, correct).await?.into_result()?.json()?)
    }

    /// Fast-forwards the sandbox until the task window has closed.
    pub async fn close(&self, task: &OpenTask) -> Result<()> {
        for _ in 0..50 {
            if self.now().await? >= task.closes_at {
                return Ok(());
            }
            self.worker.fast_forward(1_000).await?;
        }
        Err(anyhow!("sandbox clock did not pass closes_at"))
    }

    pub async fn finalize(&self, task: &OpenTask, passers: &[&Account], last: bool) -> Result<ExecutionFinalResult> {
        self.finalize_raw(task.id, &task.secret, passers.iter().map(|a| a.id().to_string()).collect(), last).await
    }

    pub async fn finalize_raw(&self, id: u64, secret: &[u8], passers: Vec<String>, last: bool) -> Result<ExecutionFinalResult> {
        Ok(self
            .boss
            .call(self.reorg.id(), "finalize_task")
            .args_json(json!({ "task_id": id, "day_secret": b64(secret), "passers": passers, "last": last }))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    /// Boss side: everyone whose stored answer hash verifies (paged like the boss service).
    pub async fn passers(&self, task: &OpenTask) -> Result<Vec<String>> {
        let mut out = Vec::new();
        let mut from = 0;
        loop {
            let page = self.view("list_submissions", json!({ "task_id": task.id, "from_index": from, "limit": 100 })).await?;
            let page = page.as_array().unwrap().clone();
            if page.is_empty() {
                break;
            }
            from += page.len();
            for s in page {
                let w = s["account_id"].as_str().unwrap().to_string();
                if s["answer_hash"].as_str().unwrap() == b64(&expected_answer_hash(&SoftSha256, &task.secret, &w)) {
                    out.push(w);
                }
            }
        }
        Ok(out)
    }

    pub async fn claim(&self, acc: &Account, task_id: u64) -> Result<ExecutionFinalResult> {
        Ok(acc
            .call(self.reorg.id(), "claim_salary")
            .args_json(json!({ "task_id": task_id }))
            .gas(USER_GAS)
            .transact()
            .await?)
    }

    pub async fn events(&self) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut since = 0u64;
        loop {
            let page = self.view("get_events", json!({ "since_seq": since, "limit": 100 })).await?;
            let page = page.as_array().unwrap().clone();
            let Some(last) = page.last() else { break };
            since = last["seq"].as_u64().unwrap();
            out.extend(page);
        }
        Ok(out)
    }

    /// §7.5 / C-12: the contract's free balance always covers the books.
    pub async fn assert_books_covered(&self) -> Result<()> {
        let t = self.view("get_treasury", json!({})).await?;
        let books: u128 = ["reserve", "income_accrued", "outstanding"]
            .iter()
            .map(|k| t[*k].as_str().unwrap().parse::<u128>().unwrap())
            .sum();
        let acc = self.reorg.view_account().await?;
        let stake = acc.storage_usage as u128 * 10_000_000_000_000_000_000;
        let free = acc.balance.as_yoctonear() - stake;
        assert!(free >= books, "free balance {free} < books {books}");
        let float: String = self.view("get_storage_float", json!({})).await?.as_str().unwrap().into();
        assert_eq!(float.parse::<u128>()?, free - books);
        Ok(())
    }
}

pub async fn sub(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

pub fn big(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected decimal string, got {v}")).parse().unwrap()
}

/// Error text of a failed transaction (first failing receipt).
pub fn failure(res: ExecutionFinalResult) -> String {
    match res.into_result() {
        Ok(_) => "<success>".into(),
        Err(e) => format!("{e:?}"),
    }
}
