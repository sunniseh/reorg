/**
 * Derived employee state (PROTOCOL.md §6.3–§6.5, D5, D6). Same formulas as `reorg-core`
 * (`rules.rs`); both are tested against the `layoff`, `status`, `multiplier` and `streak_update`
 * sections of protocol/vectors.json. Used by the boss (layoff/rehire notices) and the tower.
 */
import type { EmployeeStatus, TaskId } from "./abi";
import { BPS } from "./config";

export interface LayoffState {
  laid_off: boolean;
  status: EmployeeStatus;
  misses_in_row: number;
  layoff_tasks_left: number;
}

/** §6.3 for a given gap, with A = layoffAfter and L = layoffLen (L = 0 disables layoffs). */
export function layoffState(gap: number, layoffAfter: number, layoffLen: number): LayoffState {
  if (layoffAfter < 1) throw new Error("layoff_after must be ≥ 1");
  let laid_off = false;
  let misses_in_row = 0;
  let layoff_tasks_left = 0;
  if (gap < layoffAfter) {
    misses_in_row = gap;
  } else {
    const r = (gap - layoffAfter) % (layoffAfter + layoffLen);
    if (r < layoffLen) {
      laid_off = true;
      layoff_tasks_left = layoffLen - r;
    } else {
      misses_in_row = r - layoffLen;
    }
  }
  const status: EmployeeStatus = laid_off ? "laid_off" : misses_in_row >= 1 ? "struggling" : "active";
  return { laid_off, status, misses_in_row, layoff_tasks_left };
}

export interface EmployeeRecord {
  joined_after: TaskId;
  last_pass_day: TaskId | null;
  stored_streak: number;
}

export interface EmployeeState extends LayoffState {
  gap: number;
  effective_streak: number;
}

/** §6.3 + §6.4: everything derived from the stored record against `lastFinalized`. */
export function employeeState(
  rec: EmployeeRecord,
  lastFinalized: TaskId,
  layoffAfter: number,
  layoffLen: number,
): EmployeeState {
  const base = rec.last_pass_day ?? rec.joined_after;
  const gap = Math.max(0, lastFinalized - base);
  const effective_streak = gap === 0 && rec.last_pass_day !== null ? rec.stored_streak : 0;
  return { gap, effective_streak, ...layoffState(gap, layoffAfter, layoffLen) };
}

/** §6.4: multiplier in bps for the streak before this task. */
export function multiplierBps(streakBefore: number, streakStepBps: number, streakMaxSteps: number): number {
  return BPS + streakStepBps * Math.min(streakBefore, streakMaxSteps);
}

/** §6.4: stored streak after passing task `taskId`. */
export function streakAfterPass(taskId: TaskId, lastPassDay: TaskId | null, storedStreak: number): number {
  return lastPassDay === taskId - 1 ? storedStreak + 1 : 1;
}
