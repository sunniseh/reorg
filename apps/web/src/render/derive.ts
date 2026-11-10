/**
 * Small pure display rules the renderer and HUD share (design §4.6, §5.8, §17.1). Client display
 * constants live here, never in contract config.
 */
import type { BuildingState, TaskView, TreasuryView } from "@reorg/core";
import { effectiveStatus, nsToMs } from "../state/types";
import { G, RIG } from "./geometry";

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

/**
 * Day and night (design §9, W-15): how dark it is at `nowMs`, 0 (day) to 1 (night). It follows
 * UTC, not the viewer's time zone, so two clients draw the same sky (design §1, principle 7).
 * Dusk 18:00–20:00 UTC and dawn 05:00–07:00 UTC ease between the two.
 */
export function nightness(nowMs: number): number {
  const h = (((nowMs / 3_600_000) % 24) + 24) % 24;
  const ease = (p: number) => p * p * (3 - 2 * p);
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 20) return ease((h - 18) / 2);
  if (h >= 5 && h < 7) return 1 - ease((h - 5) / 2);
  return 1;
}

/** Mixes two 0xRRGGBB colors: t = 0 gives a, 1 gives b. */
export function mixColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
}

/**
 * Annex towers per building state (design §12.2): the towers beside the headquarters where the
 * folded floors work (Megacorp: the twin; Campus: a row; Conglomerate: a skyline). Display
 * constants, not contract config.
 */
export const ANNEX_TOWERS: Record<BuildingState, number> = {
  garage: 0,
  office: 0,
  tower: 0,
  skyscraper: 0,
  megacorp: 2,
  campus: 6,
  conglomerate: 12,
};

/** Annex tower width and the gap between towers (sprite px; RIG.building.surroundings.twin). */
export const ANNEX_W = RIG.building.surroundings.twin.columns * 32;
const ANNEX_GAP = RIG.building.surroundings.twin.gap;

/** Left edge of annex `i`: the twin first (right, with the sky bridge), then left and right in turn. */
export function annexX(i: number): number {
  const k = Math.floor((i + 1) / 2);
  const step = ANNEX_W + ANNEX_GAP;
  return i % 2 === 0 ? G.width + ANNEX_GAP + k * step : -step * k;
}

/** World x range [left, right] of the headquarters and `n` annexes beside it (the overview camera frames it). */
export function skylineSpan(n: number): [number, number] {
  let left = 0;
  let right = G.width;
  for (let i = 0; i < n; i++) {
    const x = annexX(i);
    left = Math.min(left, x);
    right = Math.max(right, x + ANNEX_W);
  }
  return [left, right];
}

export interface Annex {
  /** Folded floors that work in this tower. */
  floors: number;
  /** Floors drawn: at least 2 so it reads as a building, at most as tall as the headquarters. */
  drawn: number;
  /** A, B, C… in the order the floors fill them. */
  name: string;
}

/**
 * The annexes for `folded` floors beside a headquarters of `hq` floor-high bands. Floors split
 * evenly (the first towers take the remainder), so every client draws the same skyline. The twin
 * stands from Megacorp on, even while it is empty; any folded floor gets at least one annex.
 */
export function annexesOf(state: BuildingState, folded: number, hq: number): Annex[] {
  const max = Math.max(ANNEX_TOWERS[state], folded > 0 ? 1 : 0);
  if (max === 0) return [];
  const cap = Math.max(2, hq);
  const n = Math.min(max, Math.max(1, Math.ceil(folded / cap)));
  return Array.from({ length: n }, (_, i) => {
    const floors = Math.floor(folded / n) + (i < folded % n ? 1 : 0);
    return { floors, drawn: Math.min(cap, Math.max(2, floors)), name: String.fromCharCode(65 + i) };
  });
}
