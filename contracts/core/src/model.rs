//! Stored records (PROTOCOL.md §2, §6, §7). Borsh for storage, serde where the stored shape
//! is also the wire shape. Wallet ids never appear in records: hosts key records by them.

use crate::wire::{dec, dec4};
use crate::TaskId;
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// Tier index: 0 = Director … 3 = Intern. "No tier" (visitor) is `None` wherever it can occur.
pub type Tier = u8;
pub const TIERS: usize = 4;

/// Badge bit 0: the wallet was rehired after a layoff (§6.6).
pub const BADGE_REHIRED: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum TaskKind {
    DecodeMemo = 0,
}

/// Stored status. `closed` is derived in views (§2) and never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum TaskStatus {
    Open = 0,
    Finalizing = 1,
    Finalized = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ClaimState {
    Unclaimed = 0,
    /// Marked before the async balance read (§7.4); cleared again if the payout fails.
    Pending = 1,
    Claimed = 2,
    Forfeited = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum IncomeTag {
    ClientJob = 0,
    FeeShare = 1,
    Seed = 2,
}

/// The token's per-holder data (D15, D16), as read from the token at submit / claim time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolderInfo {
    #[serde(with = "dec")]
    pub balance: u128,
    /// 0 if the token never recorded a receive.
    #[serde(with = "dec")]
    pub last_received_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Employee {
    pub joined_after: TaskId,
    pub last_pass_day: Option<TaskId>,
    pub streak: u32,
    pub last_tier: Tier,
    pub last_balance: u128,
    pub total_earned: u128,
    pub badges: u32,
}

impl Employee {
    pub fn new(joined_after: TaskId) -> Self {
        Self {
            joined_after,
            last_pass_day: None,
            streak: 0,
            last_tier: 0,
            last_balance: 0,
            total_earned: 0,
            badges: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Submission {
    pub answer_hash: [u8; 32],
    /// Snapshot balance at submission.
    pub balance: u128,
    pub tier: Tier,
    pub streak_before: u32,
    pub multiplier_bps: u32,
    /// `balance × multiplier_bps`, never divided.
    pub weight: u128,
    pub submitted_at: u64,
    pub reapply: bool,
    pub passed: bool,
    pub pay: u128,
    pub claim: ClaimState,
}

/// Rounding-exact allocation of one task's income (§7.3). Wire shape = TS `Allocation`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Allocation {
    #[serde(with = "dec")]
    pub income: u128,
    #[serde(with = "dec")]
    pub payroll: u128,
    #[serde(with = "dec")]
    pub jackpot: u128,
    #[serde(with = "dec")]
    pub reserve_share: u128,
    #[serde(with = "dec4")]
    pub buckets: [u128; 4],
    #[serde(with = "dec")]
    pub payroll_dust: u128,
    #[serde(with = "dec4")]
    pub tier_payable: [u128; 4],
    pub settlement: Option<Settlement>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Settlement {
    #[serde(with = "dec")]
    pub to_reserve: u128,
    #[serde(with = "dec")]
    pub operating_cost_paid: u128,
    #[serde(with = "dec")]
    pub reserve_after: u128,
    pub runway_tasks: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Task {
    pub id: TaskId,
    pub kind: TaskKind,
    pub commit_hash: [u8; 32],
    pub opens_at: u64,
    pub closes_at: u64,
    pub status: TaskStatus,
    pub day_secret: Option<[u8; 32]>,
    pub submitted: u32,
    pub passed: u32,
    pub tier_submitted_weight: [u128; 4],
    pub tier_passed_weight: [u128; 4],
    pub allocation: Option<Allocation>,
    pub finalized_at: Option<u64>,
}

/// Internal books (§7.5). Payouts never exceed them.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Treasury {
    pub reserve: u128,
    pub income_accrued: u128,
    /// Allocated but not yet claimed or forfeited.
    pub outstanding: u128,
    pub total_income: u128,
    /// Indexed by `IncomeTag as usize`.
    pub income_by_tag: [u128; 3],
    pub total_paid: u128,
    pub total_forfeited: u128,
    pub total_operating_cost: u128,
}

impl Treasury {
    /// Everything the company holds or owes. The host's free balance must always cover this;
    /// storage deposits are separate and never count as treasury (§7.5).
    pub fn books(&self) -> u128 {
        self.reserve + self.income_accrued + self.outstanding
    }
}
