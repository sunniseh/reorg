/**
 * Crowd token distribution (roadmap C-02, D13), shared by local-sandbox and testnet seeding,
 * and the crowd's behavior profiles (D-02). Chain-agnostic: returns names, roles, amounts in
 * token base units and per-task decisions; the seeding scripts and the crowd runner turn them
 * into accounts and transactions. Everything here is labeled SIMULATED wherever it shows.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { TIER_NAMES, type TaskId, type TierName, type Tuple4 } from "./abi";
import { PPM } from "./config";
import { tierOf } from "./tier";

export type CrowdRole = TierName | "visitor";
export const CROWD_ROLES: readonly CrowdRole[] = [...TIER_NAMES, "visitor"];

/** D13 split for a 20-account crowd. Other sizes scale proportionally. */
export const D13_SPLIT: Readonly<Record<CrowdRole, number>> = {
  director: 2,
  manager: 3,
  associate: 5,
  intern: 8,
  visitor: 2,
};
const D13_SIZE = 20;

export interface CrowdAccount {
  /** 0-based; behavior profiles (D-02) are keyed by this index. */
  index: number;
  /** Account name prefix, e.g. `c001` (the seeding script appends `.<root>`). */
  name: string;
  role: CrowdRole;
  /** Token base units to transfer. */
  amount: bigint;
}

/** Role counts for `size` accounts: D13 proportions, largest remainder, sums to `size`. */
export function crowdSplit(size: number): Record<CrowdRole, number> {
  if (!Number.isInteger(size) || size < 0) throw new Error(`crowd size must be a non-negative integer, got ${size}`);
  const exact = CROWD_ROLES.map((r) => (D13_SPLIT[r] * size) / D13_SIZE);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let left = size - counts.reduce((a, b) => a + b, 0), k = 0; left > 0; left--, k++) {
    counts[order[k]!.i]! += 1;
  }
  return Object.fromEntries(CROWD_ROLES.map((r, i) => [r, counts[i]!])) as Record<CrowdRole, number>;
}

/**
 * Amount for member `j` of `n` in `role`: from 1.15× to 1.45× the tier's lower threshold
 * (so a small sale doesn't drop the tier), capped at 90% of the next threshold up.
 * Visitors hold 40-50% of the Intern threshold.
 */
function amountFor(role: CrowdRole, j: number, n: number, supply: bigint, th: Tuple4<number>): bigint {
  const of = (ppm: number, mille: number) => (supply * BigInt(ppm) * BigInt(mille)) / (1000n * BigInt(PPM));
  const spread = n > 1 ? Math.floor((300 * j) / (n - 1)) : 150;
  if (role === "visitor") return of(th[3], 400 + Math.floor(spread / 3));
  const k = TIER_NAMES.indexOf(role);
  const amount = of(th[k]!, 1150 + spread);
  if (k === 0) return amount;
  const cap = of(th[k - 1]!, 900);
  return amount < cap ? amount : cap;
}

/**
 * The whole crowd, ordered by index. Roles are interleaved so that index-based behavior
 * profiles land on every floor. Throws if the amounts don't fit the supply or a computed
 * amount misses its tier (only possible with thresholds closer than 1.15 / 0.9 apart).
 */
export function crowdDistribution(size: number, totalSupply: bigint, thresholdsPpm: Tuple4<number>): CrowdAccount[] {
  const split = crowdSplit(size);
  const slots = CROWD_ROLES.flatMap((role, r) =>
    Array.from({ length: split[role] }, (_, j) => ({ role, j, n: split[role], r, key: (j + 0.5) / split[role] })),
  ).sort((a, b) => a.key - b.key || a.r - b.r);

  const crowd = slots.map((s, index): CrowdAccount => {
    const amount = amountFor(s.role, s.j, s.n, totalSupply, thresholdsPpm);
    const tier = tierOf(amount, totalSupply, thresholdsPpm);
    const expected = s.role === "visitor" ? null : TIER_NAMES.indexOf(s.role);
    if (tier !== expected) throw new Error(`crowd: ${s.role} #${s.j} got tier ${tier}; thresholds too close`);
    return { index, name: `c${String(index + 1).padStart(3, "0")}`, role: s.role, amount };
  });
  const total = crowd.reduce((a, c) => a + c.amount, 0n);
  if (total > totalSupply) throw new Error(`crowd needs ${total} tokens, supply is ${totalSupply}`);
  return crowd;
}

// ------------------------------------------------------------------ behavior profiles (D-02)

/**
 * - `reliable`: passes 95% of tasks.
 * - `flaky`: passes 70%; otherwise a wrong answer or no submission.
 * - `slacker`: plays in runs and skips in runs of 4, so layoffs (and rehires) happen naturally.
 * - `dumper`: passes, then on even-numbered live tasks sells 12% of its tokens before claiming, so
 *   the claim forfeits under the anti-dump rule (§7.4) and shows in the ledger; buys back after.
 * - `scripted`: wallet "F", an Intern on a fixed five-task loop (pass, miss three, reapply): laid
 *   off at the finalize of task 4, rehired at task 5, again at 9 and 10, and so on.
 * - `visitor`: never eligible, never submits.
 */
export type CrowdProfile = "reliable" | "flaky" | "slacker" | "dumper" | "scripted" | "visitor";

export interface CrowdMember extends CrowdAccount {
  profile: CrowdProfile;
  /** Slackers: 0, 1, … in index order (each has its own run pattern). */
  variant: number;
}

/** Per-role profile pattern by rank within the role. At 20 this is the D-02 split: 8/6/2/1/1 + 2 visitors. */
const ROLE_PATTERN: Readonly<Record<TierName, readonly CrowdProfile[]>> = {
  director: ["reliable", "flaky"],
  manager: ["reliable", "dumper", "flaky"],
  associate: ["reliable", "flaky", "slacker", "reliable", "flaky"],
  intern: ["reliable", "flaky", "slacker", "reliable", "flaky", "reliable", "reliable"],
};

/**
 * Profiles for a distribution, spread so every floor has a mix. The last Intern is the scripted
 * wallet F; there is one dumper at most (the second Manager).
 */
export function crowdProfiles(crowd: readonly CrowdAccount[]): CrowdMember[] {
  const lastIntern = crowd.reduce((last, c) => (c.role === "intern" ? c.index : last), -1);
  const rank = new Map<CrowdRole, number>();
  let slackers = 0;
  return crowd.map((c) => {
    const j = rank.get(c.role) ?? 0;
    rank.set(c.role, j + 1);
    let profile: CrowdProfile;
    if (c.role === "visitor") profile = "visitor";
    else if (c.index === lastIntern) profile = "scripted";
    else {
      const pattern = ROLE_PATTERN[c.role];
      profile = pattern[j % pattern.length]!;
      if (profile === "dumper" && j !== 1) profile = "reliable";
    }
    return { ...c, profile, variant: profile === "slacker" ? slackers++ : 0 };
  });
}

export type CrowdAction = "pass" | "fail" | "skip";

export interface CrowdDecision {
  /** Submit the right answer, a wrong one, or nothing. */
  action: CrowdAction;
  /** When to submit, as a fraction of the window (0.05–0.7). */
  at: number;
  /** Dumper only: sell part of the balance after submitting, so the claim forfeits. */
  dump: boolean;
}

/** Uniform in [0, 1) from `(seed, index, taskId, salt)`: the same inputs give the same run. */
export function crowdRandom(seed: string, index: number, taskId: TaskId, salt: string): number {
  const h = sha256(utf8ToBytes(`reorg-crowd|${seed}|${index}|${taskId}|${salt}`));
  return (((h[0]! << 24) >>> 0) + (h[1]! << 16) + (h[2]! << 8) + h[3]!) / 2 ** 32;
}

/** Scripted wallet F: pass on tasks 1, 5, 6, 10, 11, …; miss the three in between. */
export function scriptedPasses(taskId: TaskId): boolean {
  return taskId % 5 === 0 || taskId % 5 === 1;
}

/** Slacker `variant` v plays runs of 5 + (v mod 2) tasks, then skips 4: laid off at the 3rd skip. */
export function slackerPlays(variant: number, taskId: TaskId): boolean {
  const on = 5 + (variant % 2);
  return (taskId - 1 + 2 * Math.floor(variant / 2)) % (on + 4) < on;
}

/** What crowd member `m` does on task `taskId`. Deterministic in `(seed, m.index, taskId, warmup)`. */
export function crowdDecision(m: CrowdMember, taskId: TaskId, seed: string, warmup: boolean): CrowdDecision {
  const r = (salt: string) => crowdRandom(seed, m.index, taskId, salt);
  const at = 0.05 + 0.65 * r("at");
  const u = r("act");
  const odds = (pass: number, fail: number): CrowdAction => (u < pass ? "pass" : u < pass + fail ? "fail" : "skip");
  switch (m.profile) {
    case "visitor":
      return { action: "skip", at, dump: false };
    case "scripted":
      return { action: scriptedPasses(taskId) ? "pass" : "skip", at: Math.min(at, 0.5), dump: false };
    case "reliable":
      return { action: odds(0.95, 0.025), at, dump: false };
    case "flaky":
      return { action: odds(0.7, 0.15), at, dump: false };
    case "slacker":
      return { action: slackerPlays(m.variant, taskId) ? odds(0.9, 0.1) : "skip", at, dump: false };
    case "dumper": {
      const action = odds(0.95, 0.025);
      return { action, at, dump: action === "pass" && !warmup && taskId % 2 === 0 };
    }
  }
}
