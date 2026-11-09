/**
 * Small pure display rules the renderer and HUD share (design §4.6, §5.8, §17.1). Client display
 * constants live here, never in contract config.
 */
import type { TaskView, TreasuryView } from "@reorg/core";
import { effectiveStatus, nsToMs } from "../state/types";

/** Runway (in tasks) that fills the vault bar (design §4.6). */
export const VAULT_FULL_RUNWAY = 30;

export type BossFace = "boss.smug" | "boss.smile" | "boss.twitchy";

/**
 * §17.1, from the latest finalized task: smug at ≥ 90%, a forced smile 50–89%, twitchy below 50%
 * or when nobody submitted. Before the first result the boss smiles (nothing to judge yet).
 */
export function bossFace(lastFinalized: Pick<TaskView, "submitted" | "passed"> | null): BossFace {
  if (!lastFinalized) return "boss.smile";
  if (lastFinalized.submitted === 0) return "boss.twitchy";
  const rate = lastFinalized.passed / lastFinalized.submitted;
  return rate >= 0.9 ? "boss.smug" : rate >= 0.5 ? "boss.smile" : "boss.twitchy";
}

/** Clock hand 0..7: the share of the window that has passed (0 = full window left). */
export function clockHand(task: Pick<TaskView, "status" | "opens_at" | "closes_at"> | null, nowMs: number): number {
  if (!task || effectiveStatus(task, nowMs) !== "open") return 0;
  const a = nsToMs(task.opens_at);
  const b = nsToMs(task.closes_at);
  const f = b > a ? (nowMs - a) / (b - a) : 1;
  return Math.max(0, Math.min(7, Math.floor(f * 8)));
}

export interface VaultModel {
  /** 0..1 */
  fill: number;
  low: boolean;
  reserve: bigint;
  runway: number | null;
  noCosts: boolean;
}

export function vaultModel(t: TreasuryView, reserveLow: string): VaultModel {
  const reserve = BigInt(t.reserve);
  const noCosts = BigInt(t.operating_cost) === 0n;
  const runway = t.runway_tasks;
  const fill = noCosts ? 1 : Math.min(1, (runway ?? 0) / VAULT_FULL_RUNWAY);
  return { fill, low: reserve < BigInt(reserveLow), reserve, runway, noCosts };
}

/** The boss's latest pass rate as text for the HUD and the aria summary. */
export function passRateText(task: Pick<TaskView, "submitted" | "passed"> | null): string {
  if (!task || task.submitted === 0) return "nobody filed";
  return `${task.passed} of ${task.submitted} passed`;
}
