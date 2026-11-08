/**
 * Crowd token distribution (roadmap C-02, D13), shared by local-sandbox and testnet seeding.
 * Chain-agnostic: returns names, roles and amounts in token base units; the seeding scripts
 * turn them into accounts and transfers.
 */
import { TIER_NAMES, type TierName, type Tuple4 } from "./abi";
import { BPS } from "./config";
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
  const of = (bps: number, mille: number) => (supply * BigInt(bps) * BigInt(mille)) / (1000n * BigInt(BPS));
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
export function crowdDistribution(size: number, totalSupply: bigint, thresholdsBps: Tuple4<number>): CrowdAccount[] {
  const split = crowdSplit(size);
  const slots = CROWD_ROLES.flatMap((role, r) =>
    Array.from({ length: split[role] }, (_, j) => ({ role, j, n: split[role], r, key: (j + 0.5) / split[role] })),
  ).sort((a, b) => a.key - b.key || a.r - b.r);

  const crowd = slots.map((s, index): CrowdAccount => {
    const amount = amountFor(s.role, s.j, s.n, totalSupply, thresholdsBps);
    const tier = tierOf(amount, totalSupply, thresholdsBps);
    const expected = s.role === "visitor" ? null : TIER_NAMES.indexOf(s.role);
    if (tier !== expected) throw new Error(`crowd: ${s.role} #${s.j} got tier ${tier}; thresholds too close`);
    return { index, name: `c${String(index + 1).padStart(3, "0")}`, role: s.role, amount };
  });
  const total = crowd.reduce((a, c) => a + c.amount, 0n);
  if (total > totalSupply) throw new Error(`crowd needs ${total} tokens, supply is ${totalSupply}`);
  return crowd;
}
