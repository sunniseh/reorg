/**
 * Contract configuration (roadmap P-04). Normative source: docs/PROTOCOL.md §10.
 * Defaults live in protocol/config.default.json. The contract's `new` / `update_config`
 * must apply the same validation as ConfigSchema.
 */
import { z } from "zod";

export const BPS = 10_000;

const u128 = z.string().regex(/^(0|[1-9]\d*)$/, "decimal u128 string");
const u64 = z.string().regex(/^(0|[1-9]\d*)$/, "decimal u64 string");
const bps = z.number().int().min(0).max(BPS);
const count = z.number().int().min(0);
const bps4 = z.tuple([bps, bps, bps, bps]);

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const strictlyDescending = (xs: readonly number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! > x);
const strictlyAscending = (xs: readonly number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

const ConfigShape = z.strictObject({
  tier_thresholds_bps: bps4,
  tier_bucket_bps: bps4,
  payroll_bps: bps,
  reserve_bps: bps,
  jackpot_bps: bps,
  streak_step_bps: bps,
  streak_max_steps: count.max(255),
  streak_milestones: z.array(count.min(1)),
  layoff_after: count.min(1),
  layoff_len: count,
  antidump_bps: bps,
  bankruptcy_empty_tasks: count,
  operating_cost: u128,
  reserve_low: u128,
  min_window_ns: u64.refine((s) => s !== "0", "must be > 0"),
  max_passers_per_call: count.min(1),
  excluded_accounts: z.array(z.string().min(1)),
});

export const ConfigSchema = ConfigShape.superRefine((c, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (!c.tier_thresholds_bps.every((t) => t > 0) || !strictlyDescending(c.tier_thresholds_bps)) {
    fail("tier_thresholds_bps", "must be > 0 and strictly descending");
  }
  if (sum(c.tier_bucket_bps) !== BPS) fail("tier_bucket_bps", `must sum to ${BPS}`);
  if (c.payroll_bps + c.reserve_bps + c.jackpot_bps !== BPS) {
    fail("payroll_bps", `payroll_bps + reserve_bps + jackpot_bps must equal ${BPS}`);
  }
  if (!strictlyAscending(c.streak_milestones)) fail("streak_milestones", "must be strictly ascending");
});

export type ContractConfig = z.infer<typeof ConfigShape>;

/** Every config key, for docs and drift checks. */
export const CONFIG_KEYS = Object.keys(ConfigShape.shape) as (keyof ContractConfig)[];
