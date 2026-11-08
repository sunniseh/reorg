//! Events (PROTOCOL.md §12). Serialized as `{seq, at, event, data}`; hosts additionally log
//! them in their native event format (see Appendix A for NEAR).

use crate::model::{IncomeTag, TaskKind, Tier};
use crate::wire::{b64, dec, dec4};
use crate::TaskId;
use borsh::{BorshDeserialize, BorshSerialize};
use serde::Serialize;

/// Event standard name and version used in host logs.
pub const EVENT_STANDARD: &str = "reorg";
pub const EVENT_VERSION: &str = "1.0.0";
/// Size of the on-chain event ring buffer (D8).
pub const EVENT_RING: u64 = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, BorshSerialize, BorshDeserialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum Event {
    TaskOpened {
        task_id: TaskId,
        kind: TaskKind,
        #[serde(with = "b64")]
        commit_hash: [u8; 32],
        #[serde(with = "dec")]
        opens_at: u64,
        #[serde(with = "dec")]
        closes_at: u64,
    },
    SubmissionReceived {
        task_id: TaskId,
        account_id: String,
        tier: Tier,
        #[serde(with = "dec")]
        balance: u128,
        #[serde(with = "dec")]
        weight: u128,
        reapply: bool,
    },
    TaskFinalized {
        task_id: TaskId,
        #[serde(with = "b64")]
        day_secret: [u8; 32],
        submitted: u32,
        passed: u32,
    },
    PayrollAllocated {
        task_id: TaskId,
        #[serde(with = "dec")]
        income: u128,
        #[serde(with = "dec")]
        payroll: u128,
        #[serde(with = "dec")]
        jackpot: u128,
        #[serde(with = "dec")]
        reserve_share: u128,
        #[serde(with = "dec4")]
        buckets: [u128; 4],
        #[serde(with = "dec4")]
        tier_payable: [u128; 4],
        #[serde(with = "dec")]
        to_reserve: u128,
        #[serde(with = "dec")]
        operating_cost_paid: u128,
        #[serde(with = "dec")]
        reserve_after: u128,
        runway_tasks: Option<u64>,
    },
    SalaryPaid {
        task_id: TaskId,
        account_id: String,
        #[serde(with = "dec")]
        amount: u128,
    },
    SalaryForfeited {
        task_id: TaskId,
        account_id: String,
        #[serde(with = "dec")]
        amount: u128,
        #[serde(with = "dec")]
        snapshot_balance: u128,
        #[serde(with = "dec")]
        current_balance: u128,
    },
    IncomeDeposited {
        from: String,
        #[serde(with = "dec")]
        amount: u128,
        tag: IncomeTag,
    },
    StreakMilestone {
        task_id: TaskId,
        account_id: String,
        streak: u32,
    },
    Rehired {
        task_id: TaskId,
        account_id: String,
    },
    ReserveLow {
        task_id: TaskId,
        #[serde(with = "dec")]
        reserve: u128,
        #[serde(with = "dec")]
        threshold: u128,
    },
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::TaskOpened { .. } => "task_opened",
            Event::SubmissionReceived { .. } => "submission_received",
            Event::TaskFinalized { .. } => "task_finalized",
            Event::PayrollAllocated { .. } => "payroll_allocated",
            Event::SalaryPaid { .. } => "salary_paid",
            Event::SalaryForfeited { .. } => "salary_forfeited",
            Event::IncomeDeposited { .. } => "income_deposited",
            Event::StreakMilestone { .. } => "streak_milestone",
            Event::Rehired { .. } => "rehired",
            Event::ReserveLow { .. } => "reserve_low",
        }
    }
}

/// One entry of the event feed: `{seq, at, event, data}` (TS `ReorgEventSchema`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, BorshSerialize, BorshDeserialize)]
pub struct EventEntry {
    pub seq: u64,
    #[serde(with = "dec")]
    pub at: u64,
    #[serde(flatten)]
    pub event: Event,
}

/// Ring-buffer slot for `seq` (1-based, gapless).
pub fn ring_slot(seq: u64) -> u64 {
    (seq - 1) % EVENT_RING
}

/// First `seq` still held by a ring whose newest entry is `last_seq`.
pub fn ring_oldest(last_seq: u64) -> u64 {
    last_seq.saturating_sub(EVENT_RING - 1).max(1)
}
