// B-09: what the boss announces after a finalize. Layoff, warning and rehire notices come from
// diffs of the derived employee status (there is no laid_off event, D7); payday, streak and
// low-reserve notices come from the contract's events for that task. Pure functions.
import type { EmployeeView, ReorgEvent } from "@reorg/core";
import { formatNear, type AnnouncementEvent } from "./flavor";
import type { EmployeeSnapshot } from "./store";

export interface Diff {
  notices: AnnouncementEvent[];
  snapshot: EmployeeSnapshot[];
}

/**
 * `prev` is the snapshot taken after the previous finalize. Accounts seen for the first time are
 * recorded without a notice (a new employee is never laid off; a boss restarted against an
 * older chain must not re-announce history).
 */
export function diffEmployees(prev: ReadonlyMap<string, EmployeeSnapshot>, now: readonly EmployeeView[], layoffAfter: number): Diff {
  const notices: AnnouncementEvent[] = [];
  const snapshot: EmployeeSnapshot[] = [];
  const sorted = [...now].sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));
  for (const e of sorted) {
    const before = prev.get(e.account_id);
    snapshot.push({ account: e.account_id, status: e.status, misses_in_row: e.misses_in_row });
    if (!before) continue;
    if (e.status === "laid_off" && before.status !== "laid_off") {
      notices.push({ kind: "layoff", account: e.account_id, tasks_left: e.layoff_tasks_left });
    } else if (e.status !== "laid_off" && before.status === "laid_off") {
      notices.push({ kind: "rehire", account: e.account_id });
    } else if (layoffAfter > 1 && e.misses_in_row === layoffAfter - 1 && before.misses_in_row < layoffAfter - 1) {
      notices.push({ kind: "layoff_warning", account: e.account_id, misses: e.misses_in_row });
    }
  }
  return { notices, snapshot };
}

/** Payday, streak milestones and low reserve for `taskId`, from the contract's events. */
export function eventNotices(events: readonly ReorgEvent[], taskId: number): AnnouncementEvent[] {
  const out: AnnouncementEvent[] = [];
  let passers = 0;
  let runway: number | null = null;
  for (const e of events) {
    if (e.event === "task_finalized" && e.data.task_id === taskId) passers = e.data.passed;
    if (e.event === "payroll_allocated" && e.data.task_id === taskId) runway = e.data.runway_tasks;
  }
  for (const e of events) {
    if (e.event === "payroll_allocated" && e.data.task_id === taskId) {
      const payroll = e.data.tier_payable.reduce((a, b) => a + BigInt(b), 0n);
      if (payroll > 0n) out.push({ kind: "payday", task_id: taskId, passers, payroll: formatNear(payroll.toString()) });
    } else if (e.event === "streak_milestone" && e.data.task_id === taskId) {
      out.push({ kind: "streak", account: e.data.account_id, streak: e.data.streak });
    } else if (e.event === "reserve_low" && e.data.task_id === taskId) {
      out.push({ kind: "reserve_low", reserve: formatNear(e.data.reserve), runway_tasks: runway });
    }
  }
  return out;
}
