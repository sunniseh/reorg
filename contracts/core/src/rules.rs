//! Pure formulas (PROTOCOL.md §6, §7). No state, no host.

use crate::config::Config;
use crate::math::{mul_div, mul_wide};
use crate::model::{Allocation, Employee, Tier};
use crate::{TaskId, BPS};
use serde::Serialize;

/// §6.1: smallest k with `balance × BPS ≥ thresholds[k] × total_supply`, else visitor (`None`).
/// Compared on 256-bit products, so no input can overflow.
pub fn tier_of(balance: u128, total_supply: u128, thresholds_bps: &[u16; 4]) -> Option<Tier> {
    if total_supply == 0 {
        return None;
    }
    let lhs = mul_wide(balance, BPS);
    thresholds_bps
        .iter()
        .position(|&t| lhs >= mul_wide(t as u128, total_supply))
        .map(|k| k as Tier)
}

/// §6.4 / D6: `BPS + streak_step_bps × min(streak_before, streak_max_steps)`.
pub fn multiplier_bps(streak_before: u32, cfg: &Config) -> u32 {
    BPS as u32 + cfg.streak_step_bps as u32 * streak_before.min(cfg.streak_max_steps as u32)
}

/// §6.4: stored streak after passing task `task_id`.
pub fn streak_after_pass(task_id: TaskId, last_pass_day: Option<TaskId>, stored_streak: u32) -> u32 {
    if task_id > 0 && last_pass_day == Some(task_id - 1) {
        stored_streak.saturating_add(1)
    } else {
        1
    }
}

/// §7.4: anti-dump. `current × BPS ≥ antidump_bps × snapshot`.
pub fn claim_allowed(current_balance: u128, snapshot_balance: u128, antidump_bps: u16) -> bool {
    mul_wide(current_balance, BPS) >= mul_wide(antidump_bps as u128, snapshot_balance)
}

/// §7.1 rule 4 / D15: tokens received at or after `opens_at` disqualify. 0 = never received.
pub fn received_before(last_received_at: u64, opens_at: u64) -> bool {
    last_received_at < opens_at
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmployeeStatus {
    Active,
    Struggling,
    LaidOff,
}

/// Derived employee state (§6.3-§6.5). Never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmployeeState {
    pub gap: u64,
    pub status: EmployeeStatus,
    pub laid_off: bool,
    pub layoff_tasks_left: u64,
    pub misses_in_row: u64,
    pub effective_streak: u32,
}

/// §6.3 / D5 against `last_finalized`, with `A = layoff_after`, `L = layoff_len`.
pub fn employee_state(emp: &Employee, last_finalized: TaskId, layoff_after: u32, layoff_len: u32) -> EmployeeState {
    let (a, l) = (layoff_after as u64, layoff_len as u64);
    let base = emp.last_pass_day.unwrap_or(emp.joined_after);
    let gap = last_finalized.saturating_sub(base);
    let (laid_off, left, misses) = if gap < a {
        (false, 0, gap)
    } else {
        let r = (gap - a) % (a + l);
        if r < l {
            (true, l - r, 0)
        } else {
            (false, 0, r - l)
        }
    };
    let effective_streak = if gap == 0 && emp.last_pass_day.is_some() { emp.streak } else { 0 };
    let status = if laid_off {
        EmployeeStatus::LaidOff
    } else if misses > 0 {
        EmployeeStatus::Struggling
    } else {
        EmployeeStatus::Active
    };
    EmployeeState { gap, status, laid_off, layoff_tasks_left: left, misses_in_row: misses, effective_streak }
}

impl Allocation {
    /// §7.3, first half: split the income snapshot. `tier_payable` starts at zero.
    pub fn start(income: u128, cfg: &Config) -> Self {
        let bps = |x: u128, b: u16| mul_div(x, b as u128, BPS).expect("bps ≤ 10000 never overflows");
        let payroll = bps(income, cfg.payroll_bps);
        let jackpot = bps(income, cfg.jackpot_bps);
        let reserve_share = income - payroll - jackpot;
        let buckets = cfg.tier_bucket_bps.map(|b| bps(payroll, b));
        let payroll_dust = payroll - buckets.iter().sum::<u128>();
        Self {
            income,
            payroll,
            jackpot,
            reserve_share,
            buckets,
            payroll_dust,
            tier_payable: [0; 4],
            settlement: None,
        }
    }

    /// `to_reserve` exactly as §7.3 writes it. Equals `income − Σ tier_payable`.
    pub fn to_reserve(&self) -> u128 {
        let unpaid: u128 = self.buckets.iter().zip(&self.tier_payable).map(|(b, p)| b - p).sum();
        self.reserve_share + self.jackpot + self.payroll_dust + unpaid
    }

    pub fn total_payable(&self) -> u128 {
        self.tier_payable.iter().sum()
    }
}

/// D1: `bucket × weight / submitted_weight`, 256-bit product, floor.
pub fn pay_share(bucket: u128, weight: u128, submitted_weight: u128) -> Option<u128> {
    mul_div(bucket, weight, submitted_weight)
}

/// §7.3 runway in tasks; `None` when there is no operating cost.
pub fn runway_tasks(reserve: u128, operating_cost: u128) -> Option<u64> {
    (operating_cost > 0).then(|| u64::try_from(reserve / operating_cost).unwrap_or(u64::MAX))
}
