/**
 * The my-desk dock's model (design §3.1, §15.2 `RgTaskPanel`; roadmap W-10). Pure: given the
 * snapshot, the player's view and the clock, it picks exactly one primary button (or none) and
 * the status line. The first matching row of §3.1 wins. The client never sends a claim that
 * would forfeit.
 */
import { antidumpAllows, antidumpMinimum, tierOf, type SubmissionView, type TaskStatus } from "@reorg/core";
import { COPY } from "../copy";
import { payout, tokens } from "../format";
import { effectiveStatus, type PlayerView, type Snapshot } from "./types";

export type DeskPrimary =
  | { kind: "badge_in"; label: string }
  | { kind: "reapply"; label: string }
  | { kind: "submit"; label: string }
  | { kind: "claim"; label: string; taskId: number; amount: bigint };

export type DeskState =
  | "disconnected"
  | "excluded"
  | "visitor"
  | "reapply"
  | "open"
  | "claimable"
  | "claim_blocked"
  | "submitted"
  | "reapply_filed"
  | "closed"
  | "pending"
  | "passed"
  | "failed"
  | "laid_off"
  | "new_hire"
  | "no_task"
  | "idle";

export interface DeskModel {
  state: DeskState;
  primary: DeskPrimary | null;
  /** One status line in voice (shown in the collapsed pill too). */
  line: string;
  /** An extra explanation under the line (claim blocked, reapplication note). */
  note: string | null;
  /** Show the puzzle and the answer input. */
  showPuzzle: boolean;
  taskStatus: TaskStatus | null;
}

export function deskModel(snap: Snapshot, player: PlayerView | null, nowMs: number): DeskModel {
  const task = snap.task;
  const status = task ? effectiveStatus(task, nowMs) : null;
  const base = { taskStatus: status, note: null, showPuzzle: false, primary: null };
  if (!player) return { ...base, state: "disconnected", line: COPY.badgeIn, primary: { kind: "badge_in", label: "Badge in" } };
  if (snap.config.excluded_accounts.includes(player.wallet)) return { ...base, state: "excluded", line: COPY.excluded };

  const balance = BigInt(player.holder.balance);
  const tier = tierOf(balance, snap.totalSupply, snap.config.tier_thresholds_ppm);
  const emp = player.employee;
  const sub = player.submission && task && player.submission.task_id === task.id ? player.submission : null;
  const open = status === "open";

  if (open && !sub && tier !== null && emp?.status === "laid_off")
    return { ...base, state: "reapply", line: COPY.laidOff, note: COPY.reapplyNote, showPuzzle: true, primary: { kind: "reapply", label: "Reapply" } };
  if (open && !sub && tier !== null) return { ...base, state: "open", line: `Day ${task!.id} is open. Decode the memo.`, showPuzzle: true, primary: { kind: "submit", label: "Submit answer" } };

  // §3.1: claimable on *any* finalized task where the anti-dump rule holds; only when none holds
  // does the dock explain the block (using the newest held salary).
  const open_ = openClaims(player.claimables);
  const allowed = open_.find((s) => antidumpAllows(balance, BigInt(s.balance), snap.config.antidump_bps));
  const claim = allowed ?? open_[0] ?? null;
  if (claim) {
    const snapshotBal = BigInt(claim.balance);
    const amount = BigInt(claim.pay);
    if (allowed) {
      const more = open_.length - 1;
      return {
        ...base,
        state: "claimable",
        line: `Salary for day ${claim.task_id} is ready.${more > 0 ? ` ${more} more after this one.` : ""}`,
        primary: { kind: "claim", label: `Claim ${payout(amount)}`, taskId: claim.task_id, amount },
      };
    }
    const pct = (snap.config.antidump_bps / 100).toString();
    return {
      ...base,
      state: "claim_blocked",
      line: `Salary for day ${claim.task_id} is on hold.`,
      note: COPY.claimBlocked(tokens(antidumpMinimum(snapshotBal, snap.config.antidump_bps)), pct),
    };
  }

  if (tier === null) return { ...base, state: "visitor", line: COPY.visitor };
  if (!task) return { ...base, state: "no_task", line: COPY.noTask };
  if (sub && (status === "open" || status === "closed" || status === "finalizing")) {
    if (status === "open") return { ...base, state: sub.reapply ? "reapply_filed" : "submitted", line: sub.reapply ? COPY.reapplyFiled : COPY.submitted };
    return { ...base, state: "pending", line: COPY.resultsPending };
  }
  if (status === "closed" || status === "finalizing") return { ...base, state: "closed", line: COPY.taskClosed };
  // Finalized.
  if (emp?.status === "laid_off") {
    const left = emp.layoff_tasks_left;
    return { ...base, state: "laid_off", line: COPY.laidOff, note: left > 0 ? `Layoff ends on its own in ${left} ${left === 1 ? "task" : "tasks"}, or sooner if you pass a reapplication.` : null };
  }
  if (sub?.passed) {
    if (sub.reapply) return { ...base, state: "passed", line: `Reapplication passed. ${COPY.rehired}` };
    return { ...base, state: "passed", line: sub.claim === "claimed" ? `You passed day ${task.id}. Salary collected.` : `You passed day ${task.id}.` };
  }
  if (sub) return { ...base, state: "failed", line: `Day ${task.id}: your answer did not match the memo.` };
  if (!emp) return { ...base, state: "new_hire", line: COPY.newHire };
  return { ...base, state: "idle", line: COPY.between };
}

/** Unclaimed paid salaries, newest first. */
function openClaims(cs: readonly SubmissionView[]): SubmissionView[] {
  return cs.filter((c) => c.claim === "unclaimed" && BigInt(c.pay) > 0n && !c.reapply).sort((a, b) => b.task_id - a.task_id);
}
