// B-10: which puzzle each task slot uses. Deterministic in (slot, previous task, config), so a
// demo schedule is reproducible. Only one family ships (Decode the Memo, spec §15.3), so the
// "never the same type as yesterday" rule is applied to the cipher; with more families the same
// rotation applies to the family first.
import { LEVEL_CIPHERS, type CipherId, type Level, type PuzzleParams } from "@reorg/core";

export type LevelMode = "schedule" | "auto";

export interface PickerConfig {
  /** `schedule`: level from `levelSchedule`. `auto`: spec §4.4 self-adjusting difficulty. */
  levelMode: LevelMode;
  /** Level per slot, cycling (a weekly rhythm with 7 entries). Also the start level in auto mode. */
  levelSchedule: Level[];
  /** auto mode: pass rate above `autoUp` → +1, below `autoDown` → −1, clamped to 1..5. */
  autoUp: number;
  autoDown: number;
  /** Fixed per-slot params (demo), cycling. Overrides everything else when non-empty. */
  fixedSchedule: PuzzleParams[];
}

export const DEFAULT_PICKER: PickerConfig = {
  levelMode: "schedule",
  levelSchedule: [1, 2, 3, 2, 3, 4, 2],
  autoUp: 0.9,
  autoDown: 0.5,
  fixedSchedule: [],
};

export interface PickContext {
  slot: number;
  warmup: boolean;
  /** The previous slot's params and, once finalized, its results. */
  previous: { params: PuzzleParams; submitted: number | null; passed: number | null } | null;
}

const clampLevel = (n: number): Level => Math.min(5, Math.max(1, n)) as Level;

export function pickLevel(ctx: PickContext, cfg: PickerConfig): Level {
  if (ctx.warmup) return 1;
  const scheduled = cfg.levelSchedule[(ctx.slot - 1) % cfg.levelSchedule.length] ?? 1;
  if (cfg.levelMode === "schedule") return scheduled;
  const prev = ctx.previous;
  if (!prev) return cfg.levelSchedule[0] ?? 1;
  if (prev.submitted === null || prev.passed === null || prev.submitted === 0) return prev.params.level;
  const rate = prev.passed / prev.submitted;
  if (rate > cfg.autoUp) return clampLevel(prev.params.level + 1);
  if (rate < cfg.autoDown) return clampLevel(prev.params.level - 1);
  return prev.params.level;
}

export function pickParams(ctx: PickContext, cfg: PickerConfig): PuzzleParams {
  if (cfg.fixedSchedule.length > 0) return cfg.fixedSchedule[(ctx.slot - 1) % cfg.fixedSchedule.length]!;
  const level = pickLevel(ctx, cfg);
  const ciphers = LEVEL_CIPHERS[level];
  let i = (ctx.slot - 1) % ciphers.length;
  if (ciphers.length > 1 && ciphers[i] === ctx.previous?.params.cipher) i = (i + 1) % ciphers.length;
  return { family: "decode-memo", cipher: ciphers[i]!, level };
}

/** Parses `PUZZLE_SCHEDULE`, e.g. "caesar:1,atbash:1,a1z26:2". Rejects combinations that don't ship. */
export function parseFixedSchedule(spec: string): PuzzleParams[] {
  if (!spec.trim()) return [];
  return spec.split(",").map((item) => {
    const [cipher, lvl] = item.trim().split(":");
    const level = Number(lvl) as Level;
    if (!LEVEL_CIPHERS[level]?.includes(cipher as CipherId)) {
      throw new Error(`PUZZLE_SCHEDULE: "${item.trim()}" is not a shipped cipher:level`);
    }
    return { family: "decode-memo", cipher: cipher as CipherId, level };
  });
}

export function parseLevelSchedule(spec: string): Level[] {
  const levels = spec.split(",").map((s) => Number(s.trim()));
  if (levels.length === 0 || levels.some((l) => !Number.isInteger(l) || l < 1 || l > 5)) {
    throw new Error(`LEVEL_SCHEDULE: "${spec}" must be a comma list of levels 1-5`);
  }
  return levels as Level[];
}
