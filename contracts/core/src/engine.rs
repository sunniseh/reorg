//! State transitions (PROTOCOL.md §2-§7, §8 `prove_pass`).
//!
//! Every function takes the records it needs, validates *before* mutating, and returns the
//! events to publish. A host adapter only loads/stores records, performs transfers and reads
//! balances. On `Err` the host must abort the whole call (or, inside an async callback, undo
//! its own marker and report the error), so no partial state is ever kept.

use crate::config::Config;
use crate::crypto::{commit_matches, expected_answer_hash, Sha256, DAY_SECRET_LEN};
use crate::events::Event;
use crate::model::*;
use crate::rules::*;
use crate::TaskId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    PreviousTaskNotFinalized,
    WindowTooShort,
    TaskNotFound,
    TaskNotOpen,
    WindowClosed,
    Excluded,
    AlreadySubmitted,
    RecycledTokens,
    Visitor,
    NoTotalSupply,
    TaskStillOpen,
    BadSecret,
    SecretMismatch,
    AlreadyFinalized,
    NotFinalizing,
    TooManyPassers,
    NoSubmission,
    DuplicatePasser,
    WrongAnswer,
    NotFinalized,
    NotAPasser,
    NothingToClaim,
    AlreadyClaimed,
    ClaimNotPending,
    ZeroDeposit,
    ProveWindowClosed,
    Overflow,
    InsufficientBooks,
}

impl Error {
    pub const fn as_str(self) -> &'static str {
        match self {
            Error::PreviousTaskNotFinalized => "previous task is not finalized",
            Error::WindowTooShort => "closes_at is too soon (min_window_ns)",
            Error::TaskNotFound => "task not found",
            Error::TaskNotOpen => "task is not open",
            Error::WindowClosed => "submission window is closed",
            Error::Excluded => "account is excluded",
            Error::AlreadySubmitted => "already submitted for this task",
            Error::RecycledTokens => "tokens received after the task opened (anti-recycling)",
            Error::Visitor => "balance below the minimum tier (visitor)",
            Error::NoTotalSupply => "total supply is zero",
            Error::TaskStillOpen => "task window has not closed yet",
            Error::BadSecret => "day_secret does not match the commit",
            Error::SecretMismatch => "day_secret differs from the revealed secret",
            Error::AlreadyFinalized => "task already finalized",
            Error::NotFinalizing => "task is not finalizing",
            Error::TooManyPassers => "too many passers in one call (max_passers_per_call)",
            Error::NoSubmission => "no submission for this account",
            Error::DuplicatePasser => "passer already verified",
            Error::WrongAnswer => "answer hash does not match",
            Error::NotFinalized => "task is not finalized",
            Error::NotAPasser => "not a paid passer of this task",
            Error::NothingToClaim => "nothing to claim",
            Error::AlreadyClaimed => "already claimed, pending or forfeited",
            Error::ClaimNotPending => "claim is not pending",
            Error::ZeroDeposit => "deposit must be positive",
            Error::ProveWindowClosed => "prove_pass window is closed",
            Error::Overflow => "arithmetic overflow",
            Error::InsufficientBooks => "treasury books cannot cover this",
        }
    }
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub type Result<T> = core::result::Result<T, Error>;

fn add(a: u128, b: u128) -> Result<u128> {
    a.checked_add(b).ok_or(Error::Overflow)
}
fn sub(a: u128, b: u128) -> Result<u128> {
    a.checked_sub(b).ok_or(Error::InsufficientBooks)
}

// ------------------------------------------------------------------ open (§2, §3)

/// Opens task `current_task_id + 1`. The previous task must be finalized.
pub fn open_task(
    cfg: &Config,
    current_task_id: TaskId,
    last_finalized: TaskId,
    kind: TaskKind,
    commit_hash: [u8; 32],
    closes_at: u64,
    now: u64,
) -> Result<(Task, Event)> {
    if current_task_id != last_finalized {
        return Err(Error::PreviousTaskNotFinalized);
    }
    if closes_at <= now || closes_at - now < cfg.min_window_ns {
        return Err(Error::WindowTooShort);
    }
    let id = current_task_id + 1;
    let task = Task {
        id,
        kind,
        commit_hash,
        opens_at: now,
        closes_at,
        status: TaskStatus::Open,
        day_secret: None,
        submitted: 0,
        passed: 0,
        tier_submitted_weight: [0; 4],
        tier_passed_weight: [0; 4],
        allocation: None,
        finalized_at: None,
    };
    let event = Event::TaskOpened { task_id: id, kind, commit_hash, opens_at: now, closes_at };
    Ok((task, event))
}

// ------------------------------------------------------------------ submit (§7.1)

/// Synchronous checks before the host reads the wallet's balance (rules 1-3).
/// `already` = the wallet has a submission or a pending submission for this task.
pub fn precheck_submission(cfg: &Config, task: &Task, wallet: &str, now: u64, already: bool) -> Result<()> {
    if task.status != TaskStatus::Open {
        return Err(Error::TaskNotOpen);
    }
    if now >= task.closes_at {
        return Err(Error::WindowClosed);
    }
    if cfg.is_excluded(wallet) {
        return Err(Error::Excluded);
    }
    if already {
        return Err(Error::AlreadySubmitted);
    }
    Ok(())
}

pub struct Accepted {
    pub submission: Submission,
    pub employee: Employee,
    pub is_new_employee: bool,
    pub event: Event,
}

/// After the balance read (rules 4-5, §6.6). The window may have closed while the read was in
/// flight; the submission still counts as long as finalization has not started.
#[allow(clippy::too_many_arguments)]
pub fn accept_submission(
    cfg: &Config,
    task: &mut Task,
    last_finalized: TaskId,
    wallet: &str,
    employee: Option<Employee>,
    answer_hash: [u8; 32],
    holder: HolderInfo,
    total_supply: u128,
    now: u64,
) -> Result<Accepted> {
    if task.status != TaskStatus::Open {
        return Err(Error::TaskNotOpen);
    }
    if cfg.is_excluded(wallet) {
        return Err(Error::Excluded);
    }
    if !received_before(holder.last_received_at, task.opens_at) {
        return Err(Error::RecycledTokens);
    }
    if total_supply == 0 {
        return Err(Error::NoTotalSupply);
    }
    let tier = tier_of(holder.balance, total_supply, &cfg.tier_thresholds_ppm).ok_or(Error::Visitor)?;

    let is_new_employee = employee.is_none();
    let mut employee = employee.unwrap_or_else(|| Employee::new(last_finalized));
    let state = employee_state(&employee, last_finalized, cfg.layoff_after, cfg.layoff_len);
    let reapply = state.laid_off;
    let streak_before = state.effective_streak;
    let multiplier = multiplier_bps(streak_before, cfg);
    let weight = holder.balance.checked_mul(multiplier as u128).ok_or(Error::Overflow)?;

    let t = tier as usize;
    let tier_weight = if reapply { task.tier_submitted_weight[t] } else { add(task.tier_submitted_weight[t], weight)? };
    let submitted = task.submitted.checked_add(1).ok_or(Error::Overflow)?;
    task.tier_submitted_weight[t] = tier_weight;
    task.submitted = submitted;

    employee.last_tier = tier;
    employee.last_balance = holder.balance;

    let submission = Submission {
        answer_hash,
        balance: holder.balance,
        tier,
        streak_before,
        multiplier_bps: multiplier,
        weight,
        submitted_at: now,
        reapply,
        passed: false,
        pay: 0,
        claim: ClaimState::Unclaimed,
    };
    let event = Event::SubmissionReceived {
        task_id: task.id,
        account_id: wallet.into(),
        tier,
        balance: holder.balance,
        weight,
        reapply,
    };
    Ok(Accepted { submission, employee, is_new_employee, event })
}

// ------------------------------------------------------------------ finalize (§7.2, §7.3)

/// Checks the batch size of one finalize call.
pub fn check_batch(cfg: &Config, passers: usize) -> Result<()> {
    if passers > cfg.max_passers_per_call as usize {
        return Err(Error::TooManyPassers);
    }
    Ok(())
}

/// First call: verify the reveal, snapshot `income_accrued`, status → Finalizing.
/// Later calls: the secret must equal the one already revealed.
pub fn begin_finalize<H: Sha256 + ?Sized>(
    h: &H,
    cfg: &Config,
    task: &mut Task,
    treasury: &mut Treasury,
    day_secret: &[u8],
    now: u64,
) -> Result<()> {
    match task.status {
        TaskStatus::Finalized => Err(Error::AlreadyFinalized),
        TaskStatus::Finalizing => match &task.day_secret {
            Some(s) if s.as_slice() == day_secret => Ok(()),
            _ => Err(Error::SecretMismatch),
        },
        TaskStatus::Open => {
            if now < task.closes_at {
                return Err(Error::TaskStillOpen);
            }
            if !commit_matches(h, day_secret, &task.commit_hash) {
                return Err(Error::BadSecret);
            }
            let mut secret = [0u8; DAY_SECRET_LEN];
            secret.copy_from_slice(day_secret);
            task.day_secret = Some(secret);
            task.status = TaskStatus::Finalizing;
            task.allocation = Some(Allocation::start(core::mem::take(&mut treasury.income_accrued), cfg));
            Ok(())
        }
    }
}

/// Verifies one listed passer and books their pay (D1) and streak (§6.4, §6.6).
pub fn verify_passer<H: Sha256 + ?Sized>(
    h: &H,
    cfg: &Config,
    task: &mut Task,
    wallet: &str,
    submission: &mut Submission,
    employee: &mut Employee,
    events: &mut Vec<Event>,
) -> Result<()> {
    if task.status != TaskStatus::Finalizing {
        return Err(Error::NotFinalizing);
    }
    record_pass(h, cfg, task, wallet, submission, employee, events)?;
    Ok(())
}

/// Shared by `verify_passer` and `prove_pass`. Returns the pay booked for this pass.
fn record_pass<H: Sha256 + ?Sized>(
    h: &H,
    cfg: &Config,
    task: &mut Task,
    wallet: &str,
    submission: &mut Submission,
    employee: &mut Employee,
    events: &mut Vec<Event>,
) -> Result<u128> {
    let secret = task.day_secret.ok_or(Error::NotFinalizing)?;
    if submission.passed {
        return Err(Error::DuplicatePasser);
    }
    if submission.answer_hash != expected_answer_hash(h, &secret, wallet) {
        return Err(Error::WrongAnswer);
    }
    let alloc = task.allocation.as_mut().ok_or(Error::NotFinalizing)?;
    let t = submission.tier as usize;

    // Compute everything fallible first.
    let (pay, payable, passed_w) = if submission.reapply {
        (0, alloc.tier_payable[t], task.tier_passed_weight[t])
    } else {
        let pay = pay_share(alloc.buckets[t], submission.weight, task.tier_submitted_weight[t]).ok_or(Error::Overflow)?;
        (pay, add(alloc.tier_payable[t], pay)?, add(task.tier_passed_weight[t], submission.weight)?)
    };
    let passed = task.passed.checked_add(1).ok_or(Error::Overflow)?;

    alloc.tier_payable[t] = payable;
    task.tier_passed_weight[t] = passed_w;
    task.passed = passed;
    submission.passed = true;
    submission.pay = pay;

    // A later task may already be recorded as passed (prove_pass while N+1 is finalizing):
    // never move last_pass_day backwards.
    if employee.last_pass_day.is_none_or(|d| d < task.id) {
        let streak = streak_after_pass(task.id, employee.last_pass_day, employee.streak);
        employee.streak = streak;
        employee.last_pass_day = Some(task.id);
        if cfg.streak_milestones.contains(&streak) {
            events.push(Event::StreakMilestone { task_id: task.id, account_id: wallet.into(), streak });
        }
    }
    if submission.reapply {
        employee.badges |= BADGE_REHIRED;
        events.push(Event::Rehired { task_id: task.id, account_id: wallet.into() });
    }
    Ok(pay)
}

/// Last finalize call: settle the books (§7.3), status → Finalized.
/// Returns the operating cost the host must send to the operator (D10).
pub fn settle(cfg: &Config, task: &mut Task, treasury: &mut Treasury, now: u64, events: &mut Vec<Event>) -> Result<u128> {
    if task.status != TaskStatus::Finalizing {
        return Err(Error::NotFinalizing);
    }
    let secret = task.day_secret.ok_or(Error::NotFinalizing)?;
    let alloc = task.allocation.as_mut().ok_or(Error::NotFinalizing)?;
    let to_reserve = alloc.to_reserve();
    let payable = alloc.total_payable();
    debug_assert_eq!(to_reserve + payable, alloc.income);

    let reserve_mid = add(treasury.reserve, to_reserve)?;
    let outstanding = add(treasury.outstanding, payable)?;
    let op_paid = cfg.operating_cost.min(reserve_mid);
    let reserve_after = reserve_mid - op_paid;
    let total_op = add(treasury.total_operating_cost, op_paid)?;
    let runway = runway_tasks(reserve_after, cfg.operating_cost);

    treasury.reserve = reserve_after;
    treasury.outstanding = outstanding;
    treasury.total_operating_cost = total_op;
    alloc.settlement = Some(Settlement { to_reserve, operating_cost_paid: op_paid, reserve_after, runway_tasks: runway });
    task.status = TaskStatus::Finalized;
    task.finalized_at = Some(now);

    events.push(Event::PayrollAllocated {
        task_id: task.id,
        income: alloc.income,
        payroll: alloc.payroll,
        jackpot: alloc.jackpot,
        reserve_share: alloc.reserve_share,
        buckets: alloc.buckets,
        tier_payable: alloc.tier_payable,
        to_reserve,
        operating_cost_paid: op_paid,
        reserve_after,
        runway_tasks: runway,
    });
    events.push(Event::TaskFinalized { task_id: task.id, day_secret: secret, submitted: task.submitted, passed: task.passed });
    if reserve_after < cfg.reserve_low {
        events.push(Event::ReserveLow { task_id: task.id, reserve: reserve_after, threshold: cfg.reserve_low });
    }
    Ok(op_paid)
}

/// The operating-cost transfer failed: put the amount back into the reserve.
pub fn rollback_operating_cost(treasury: &mut Treasury, amount: u128) -> Result<()> {
    treasury.total_operating_cost = sub(treasury.total_operating_cost, amount)?;
    treasury.reserve = add(treasury.reserve, amount)?;
    Ok(())
}

// ------------------------------------------------------------------ prove_pass (§8, D17)

/// A submitter proves their own pass after the reveal, while task N+1 is not yet finalized
/// (`last_finalized == task.id`). Their share moves reserve → outstanding.
#[allow(clippy::too_many_arguments)]
pub fn prove_pass<H: Sha256 + ?Sized>(
    h: &H,
    cfg: &Config,
    task: &mut Task,
    last_finalized: TaskId,
    treasury: &mut Treasury,
    wallet: &str,
    submission: &mut Submission,
    employee: &mut Employee,
    events: &mut Vec<Event>,
) -> Result<u128> {
    if task.status != TaskStatus::Finalized {
        return Err(Error::NotFinalized);
    }
    if last_finalized != task.id {
        return Err(Error::ProveWindowClosed);
    }
    // Check the books before touching anything.
    let pay = if submission.reapply || submission.passed {
        0
    } else {
        let alloc = task.allocation.as_ref().ok_or(Error::NotFinalized)?;
        let t = submission.tier as usize;
        pay_share(alloc.buckets[t], submission.weight, task.tier_submitted_weight[t]).ok_or(Error::Overflow)?
    };
    let reserve = sub(treasury.reserve, pay)?;
    let outstanding = add(treasury.outstanding, pay)?;

    let booked = record_pass(h, cfg, task, wallet, submission, employee, events)?;
    debug_assert_eq!(booked, pay);
    treasury.reserve = reserve;
    treasury.outstanding = outstanding;
    if let Some(s) = task.allocation.as_mut().and_then(|a| a.settlement.as_mut()) {
        s.to_reserve -= pay;
    }
    Ok(pay)
}

// ------------------------------------------------------------------ claims (§7.4)

/// Marks the claim pending before the async balance read. Returns the amount at stake.
pub fn begin_claim(task: &Task, submission: &mut Submission) -> Result<u128> {
    if task.status != TaskStatus::Finalized {
        return Err(Error::NotFinalized);
    }
    if !submission.passed || submission.reapply {
        return Err(Error::NotAPasser);
    }
    if submission.pay == 0 {
        return Err(Error::NothingToClaim);
    }
    if submission.claim != ClaimState::Unclaimed {
        return Err(Error::AlreadyClaimed);
    }
    submission.claim = ClaimState::Pending;
    Ok(submission.pay)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimResolution {
    /// Host must transfer this amount, then call `confirm_salary` or `rollback_salary`.
    Pay(u128),
    /// Anti-dump failed; the share went to the reserve.
    Forfeited(u128),
    /// The balance read failed; the claim is unclaimed again.
    Retry,
}

/// After the balance read. `current_balance = None` means the read failed.
pub fn resolve_claim(
    cfg: &Config,
    treasury: &mut Treasury,
    task_id: TaskId,
    wallet: &str,
    submission: &mut Submission,
    current_balance: Option<u128>,
    events: &mut Vec<Event>,
) -> Result<ClaimResolution> {
    if submission.claim != ClaimState::Pending {
        return Err(Error::ClaimNotPending);
    }
    let Some(current) = current_balance else {
        submission.claim = ClaimState::Unclaimed;
        return Ok(ClaimResolution::Retry);
    };
    let pay = submission.pay;
    let outstanding = sub(treasury.outstanding, pay)?;
    if claim_allowed(current, submission.balance, cfg.antidump_bps) {
        let total_paid = add(treasury.total_paid, pay)?;
        treasury.outstanding = outstanding;
        treasury.total_paid = total_paid;
        submission.claim = ClaimState::Claimed;
        Ok(ClaimResolution::Pay(pay))
    } else {
        let reserve = add(treasury.reserve, pay)?;
        let forfeited = add(treasury.total_forfeited, pay)?;
        treasury.outstanding = outstanding;
        treasury.reserve = reserve;
        treasury.total_forfeited = forfeited;
        submission.claim = ClaimState::Forfeited;
        events.push(Event::SalaryForfeited {
            task_id,
            account_id: wallet.into(),
            amount: pay,
            snapshot_balance: submission.balance,
            current_balance: current,
        });
        Ok(ClaimResolution::Forfeited(pay))
    }
}

/// The salary transfer succeeded.
pub fn confirm_salary(employee: &mut Employee, task_id: TaskId, wallet: &str, amount: u128, events: &mut Vec<Event>) {
    employee.total_earned = employee.total_earned.saturating_add(amount);
    events.push(Event::SalaryPaid { task_id, account_id: wallet.into(), amount });
}

/// The salary transfer failed: the money is back, so is the claim.
pub fn rollback_salary(treasury: &mut Treasury, submission: &mut Submission, amount: u128) -> Result<()> {
    treasury.total_paid = sub(treasury.total_paid, amount)?;
    treasury.outstanding = add(treasury.outstanding, amount)?;
    submission.claim = ClaimState::Unclaimed;
    Ok(())
}

// ------------------------------------------------------------------ income (§7.5)

pub fn deposit_income(treasury: &mut Treasury, from: &str, amount: u128, tag: IncomeTag) -> Result<Event> {
    if amount == 0 {
        return Err(Error::ZeroDeposit);
    }
    let accrued = add(treasury.income_accrued, amount)?;
    let total = add(treasury.total_income, amount)?;
    let by_tag = add(treasury.income_by_tag[tag as usize], amount)?;
    treasury.income_accrued = accrued;
    treasury.total_income = total;
    treasury.income_by_tag[tag as usize] = by_tag;
    Ok(Event::IncomeDeposited { from: from.into(), amount, tag })
}
