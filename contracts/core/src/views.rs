//! View shapes (PROTOCOL.md §6.5, §11; TS `abi.ts`). Hosts fill them from stored records.

use crate::config::Config;
use crate::model::*;
use crate::rules::{employee_state, runway_tasks, EmployeeStatus};
use crate::wire::{b64, b64_opt, dec, dec4, dec_opt};
use crate::TaskId;
use serde::Serialize;

/// How many recent results `EmployeeView.recent` holds.
pub const RECENT_RESULTS: usize = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusView {
    Open,
    Closed,
    Finalizing,
    Finalized,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskView {
    pub id: TaskId,
    pub kind: TaskKind,
    pub status: TaskStatusView,
    #[serde(with = "b64")]
    pub commit_hash: [u8; 32],
    #[serde(with = "dec")]
    pub opens_at: u64,
    #[serde(with = "dec")]
    pub closes_at: u64,
    #[serde(with = "b64_opt")]
    pub day_secret: Option<[u8; 32]>,
    pub submitted: u32,
    pub passed: u32,
    #[serde(with = "dec4")]
    pub tier_submitted_weight: [u128; 4],
    #[serde(with = "dec4")]
    pub tier_passed_weight: [u128; 4],
    pub allocation: Option<Allocation>,
    #[serde(with = "dec_opt")]
    pub finalized_at: Option<u64>,
}

impl TaskView {
    pub fn new(t: &Task, now: u64) -> Self {
        let status = match t.status {
            TaskStatus::Open if now >= t.closes_at => TaskStatusView::Closed,
            TaskStatus::Open => TaskStatusView::Open,
            TaskStatus::Finalizing => TaskStatusView::Finalizing,
            TaskStatus::Finalized => TaskStatusView::Finalized,
        };
        Self {
            id: t.id,
            kind: t.kind,
            status,
            commit_hash: t.commit_hash,
            opens_at: t.opens_at,
            closes_at: t.closes_at,
            day_secret: t.day_secret,
            submitted: t.submitted,
            passed: t.passed,
            tier_submitted_weight: t.tier_submitted_weight,
            tier_passed_weight: t.tier_passed_weight,
            allocation: t.allocation.clone(),
            finalized_at: t.finalized_at,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SubmissionView {
    pub task_id: TaskId,
    pub account_id: String,
    #[serde(with = "b64")]
    pub answer_hash: [u8; 32],
    #[serde(with = "dec")]
    pub balance: u128,
    pub tier: Tier,
    pub streak_before: u32,
    pub multiplier_bps: u32,
    #[serde(with = "dec")]
    pub weight: u128,
    #[serde(with = "dec")]
    pub submitted_at: u64,
    pub reapply: bool,
    pub passed: bool,
    #[serde(with = "dec")]
    pub pay: u128,
    pub claim: ClaimState,
}

impl SubmissionView {
    pub fn new(task_id: TaskId, account_id: String, s: &Submission) -> Self {
        Self {
            task_id,
            account_id,
            answer_hash: s.answer_hash,
            balance: s.balance,
            tier: s.tier,
            streak_before: s.streak_before,
            multiplier_bps: s.multiplier_bps,
            weight: s.weight,
            submitted_at: s.submitted_at,
            reapply: s.reapply,
            passed: s.passed,
            pay: s.pay,
            claim: s.claim,
        }
    }
}

/// What `get_claimable` returns: the pay if it can be claimed right now, else 0.
pub fn claimable(task: &Task, s: &Submission) -> u128 {
    let ok = task.status == TaskStatus::Finalized && s.passed && !s.reapply && s.claim == ClaimState::Unclaimed;
    if ok { s.pay } else { 0 }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskResult {
    Pass,
    Fail,
    Miss,
    Pending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RecentResult {
    pub task_id: TaskId,
    pub result: TaskResult,
}

/// Up to [`RECENT_RESULTS`] results, newest first, from `current_task_id` down to the task the
/// wallet joined during. `lookup(t)` = `Some(passed)` if the wallet submitted to task `t`.
/// The open (unfinalized) task appears only if the wallet already submitted to it.
pub fn recent_results(
    emp: &Employee,
    current_task_id: TaskId,
    last_finalized: TaskId,
    mut lookup: impl FnMut(TaskId) -> Option<bool>,
) -> Vec<RecentResult> {
    let mut out = Vec::with_capacity(RECENT_RESULTS);
    let mut t = current_task_id;
    while t > emp.joined_after && out.len() < RECENT_RESULTS {
        let finalized = t <= last_finalized;
        let result = match lookup(t) {
            Some(true) => Some(TaskResult::Pass),
            Some(false) if finalized => Some(TaskResult::Fail),
            Some(false) => Some(TaskResult::Pending),
            None if finalized => Some(TaskResult::Miss),
            None => None,
        };
        if let Some(result) = result {
            out.push(RecentResult { task_id: t, result });
        }
        t -= 1;
    }
    out
}

#[derive(Clone, Debug, Serialize)]
pub struct EmployeeView {
    pub account_id: String,
    pub joined_after: TaskId,
    pub last_pass_day: Option<TaskId>,
    pub stored_streak: u32,
    pub effective_streak: u32,
    pub gap: u64,
    pub status: EmployeeStatus,
    pub misses_in_row: u64,
    pub layoff_tasks_left: u64,
    pub last_tier: Tier,
    #[serde(with = "dec")]
    pub last_balance: u128,
    #[serde(with = "dec")]
    pub total_earned: u128,
    pub badges: u32,
    pub recent: Vec<RecentResult>,
}

impl EmployeeView {
    pub fn new(account_id: String, e: &Employee, cfg: &Config, last_finalized: TaskId, recent: Vec<RecentResult>) -> Self {
        let st = employee_state(e, last_finalized, cfg.layoff_after, cfg.layoff_len);
        Self {
            account_id,
            joined_after: e.joined_after,
            last_pass_day: e.last_pass_day,
            stored_streak: e.streak,
            effective_streak: st.effective_streak,
            gap: st.gap,
            status: st.status,
            misses_in_row: st.misses_in_row,
            layoff_tasks_left: st.layoff_tasks_left,
            last_tier: e.last_tier,
            last_balance: e.last_balance,
            total_earned: e.total_earned,
            badges: e.badges,
            recent,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct IncomeByTag {
    #[serde(with = "dec")]
    pub client_job: u128,
    #[serde(with = "dec")]
    pub fee_share: u128,
    #[serde(with = "dec")]
    pub seed: u128,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreasuryView {
    #[serde(with = "dec")]
    pub reserve: u128,
    #[serde(with = "dec")]
    pub income_accrued: u128,
    #[serde(with = "dec")]
    pub outstanding: u128,
    #[serde(with = "dec")]
    pub total_income: u128,
    pub income_by_tag: IncomeByTag,
    #[serde(with = "dec")]
    pub total_paid: u128,
    #[serde(with = "dec")]
    pub total_forfeited: u128,
    #[serde(with = "dec")]
    pub total_operating_cost: u128,
    #[serde(with = "dec")]
    pub operating_cost: u128,
    pub runway_tasks: Option<u64>,
}

impl TreasuryView {
    pub fn new(t: &Treasury, cfg: &Config) -> Self {
        Self {
            reserve: t.reserve,
            income_accrued: t.income_accrued,
            outstanding: t.outstanding,
            total_income: t.total_income,
            income_by_tag: IncomeByTag {
                client_job: t.income_by_tag[IncomeTag::ClientJob as usize],
                fee_share: t.income_by_tag[IncomeTag::FeeShare as usize],
                seed: t.income_by_tag[IncomeTag::Seed as usize],
            },
            total_paid: t.total_paid,
            total_forfeited: t.total_forfeited,
            total_operating_cost: t.total_operating_cost,
            operating_cost: cfg.operating_cost,
            runway_tasks: runway_tasks(t.reserve, cfg.operating_cost),
        }
    }
}
