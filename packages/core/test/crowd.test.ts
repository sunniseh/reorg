// C-02: crowd distribution, and the TS tier calc against protocol/vectors.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CROWD_ROLES, crowdDistribution, crowdSplit, tierOf, type Tuple4 } from "../src";

const root = new URL("../../../", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("protocol/vectors.json", root), "utf8"));
const thresholds = vectors.config.tier_thresholds_bps as Tuple4<number>;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

type TierCase = { balance: string; total_supply: string; tier: number | null; note: string };

describe("tierOf (§6.1)", () => {
  it.each(vectors.tier.cases as TierCase[])("$note", (c) => {
    expect(tierOf(BigInt(c.balance), BigInt(c.total_supply), vectors.tier.thresholds_bps)).toBe(c.tier);
  });
  it("zero supply is never a tier", () => expect(tierOf(1n, 0n, thresholds)).toBeNull());
});

describe("crowdSplit", () => {
  it("is exactly D13 at 20", () => {
    expect(crowdSplit(20)).toEqual({ director: 2, manager: 3, associate: 5, intern: 8, visitor: 2 });
  });
  it.each([0, 1, 5, 7, 19, 21, 50, 100, 150])("sums to %i", (n) => {
    const s = crowdSplit(n);
    expect(CROWD_ROLES.reduce((a, r) => a + s[r], 0)).toBe(n);
  });
  it("scales to 100", () => {
    expect(crowdSplit(100)).toEqual({ director: 10, manager: 15, associate: 25, intern: 40, visitor: 10 });
  });
  it("rejects bad sizes", () => {
    expect(() => crowdSplit(-1)).toThrow();
    expect(() => crowdSplit(2.5)).toThrow();
  });
});

describe("crowdDistribution (C-02)", () => {
  it.each([20, 100])("every account lands in its tier, fits the supply (size %i)", (n) => {
    const crowd = crowdDistribution(n, SUPPLY, thresholds);
    expect(crowd).toHaveLength(n);
    for (const c of crowd) {
      const want = c.role === "visitor" ? null : ["director", "manager", "associate", "intern"].indexOf(c.role);
      expect(tierOf(c.amount, SUPPLY, thresholds), c.name).toBe(want);
    }
    expect(crowd.reduce((a, c) => a + c.amount, 0n) <= SUPPLY).toBe(true);
  });

  it("is deterministic, named c001… and interleaves roles", () => {
    const a = crowdDistribution(20, SUPPLY, thresholds);
    expect(crowdDistribution(20, SUPPLY, thresholds)).toEqual(a);
    expect(a.map((c) => c.name)).toEqual(Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(3, "0")}`));
    // Each 10-account half has every role, so index-based profiles spread across floors.
    for (const half of [a.slice(0, 10), a.slice(10)]) {
      expect(new Set(half.map((c) => c.role))).toEqual(new Set(CROWD_ROLES));
    }
  });

  it("keeps a margin above the tier floor (a 10% sale keeps the tier)", () => {
    for (const c of crowdDistribution(20, SUPPLY, thresholds)) {
      if (c.role === "visitor") continue;
      expect(tierOf((c.amount * 9n) / 10n, SUPPLY, thresholds)).toBe(tierOf(c.amount, SUPPLY, thresholds));
    }
  });

  it("throws when the supply can't hold the crowd or thresholds are too close", () => {
    expect(() => crowdDistribution(400, SUPPLY, [3000, 1000, 250, 50])).toThrow(/supply/);
    expect(() => crowdDistribution(20, SUPPLY, [300, 290, 25, 5])).toThrow(/thresholds too close/);
  });
});
