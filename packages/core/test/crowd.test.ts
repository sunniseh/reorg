// C-02: crowd distribution, and the TS tier calc against protocol/vectors.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CROWD_ROLES,
  crowdDecision,
  crowdDistribution,
  crowdProfiles,
  crowdSplit,
  employeeState,
  tierOf,
  type CrowdMember,
  type Tuple4,
} from "../src";

const root = new URL("../../../", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("protocol/vectors.json", root), "utf8"));
const thresholds = vectors.config.tier_thresholds_ppm as Tuple4<number>;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

type TierCase = { balance: string; total_supply: string; tier: number | null; note: string };

describe("tierOf (§6.1)", () => {
  it.each(vectors.tier.cases as TierCase[])("$note", (c) => {
    expect(tierOf(BigInt(c.balance), BigInt(c.total_supply), vectors.tier.thresholds_ppm)).toBe(c.tier);
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

  it("keeps the tier after the dumper's 12% sale", () => {
    for (const c of crowdDistribution(20, SUPPLY, thresholds)) {
      if (c.role === "visitor") continue;
      expect(tierOf((c.amount * 88n) / 100n, SUPPLY, thresholds)).toBe(tierOf(c.amount, SUPPLY, thresholds));
    }
  });

  it("throws when the supply can't hold the crowd or thresholds are too close", () => {
    expect(() => crowdDistribution(400, SUPPLY, [300_000, 100_000, 25_000, 5_000])).toThrow(/supply/);
    expect(() => crowdDistribution(20, SUPPLY, [30_000, 29_000, 2_500, 10])).toThrow(/thresholds too close/);
  });
});

describe("crowd profiles (D-02)", () => {
  const crowd = crowdProfiles(crowdDistribution(20, SUPPLY, thresholds));
  const count = (p: string) => crowd.filter((m) => m.profile === p).length;
  const F = crowd.find((m) => m.profile === "scripted")!;

  it("is the D-02 split at 20, with F an Intern and every tier mixed", () => {
    expect([count("reliable"), count("flaky"), count("slacker"), count("dumper"), count("scripted"), count("visitor")]).toEqual([8, 6, 2, 1, 1, 2]);
    expect(F.role).toBe("intern");
    for (const role of ["director", "manager", "associate", "intern"]) {
      expect(new Set(crowd.filter((m) => m.role === role).map((m) => m.profile)).size, role).toBeGreaterThan(1);
    }
    expect(crowd.filter((m) => m.role === "visitor").every((m) => m.profile === "visitor")).toBe(true);
  });

  it("decides deterministically from (seed, index, task)", () => {
    for (const m of crowd) {
      for (let t = 1; t <= 10; t++) {
        expect(crowdDecision(m, t, "s", false)).toEqual(crowdDecision(m, t, "s", false));
        const d = crowdDecision(m, t, "s", false);
        expect(d.at).toBeGreaterThanOrEqual(0.05);
        expect(d.at).toBeLessThan(0.7);
      }
    }
    const runs = (seed: string) => crowd.flatMap((m) => [1, 2, 3, 4, 5, 6].map((t) => crowdDecision(m, t, seed, false).action)).join();
    expect(runs("a")).not.toBe(runs("b"));
  });

  it("never submits for visitors; the dumper dumps only on live tasks it passes", () => {
    const dumper = crowd.find((m) => m.profile === "dumper")!;
    const live = Array.from({ length: 40 }, (_, i) => crowdDecision(dumper, i + 1, "s", false));
    expect(live.some((d) => d.dump)).toBe(true);
    expect(live.every((d) => !d.dump || d.action === "pass")).toBe(true);
    for (let t = 1; t <= 40; t++) expect(crowdDecision(dumper, t, "s", true).dump).toBe(false);
    for (const v of crowd.filter((m) => m.profile === "visitor")) expect(crowdDecision(v, 3, "s", false).action).toBe("skip");
  });

  /** Plays the D5 formulas over tasks 1..n for one member; returns its status after each finalize. */
  function story(m: CrowdMember, n: number) {
    let joined: number | null = null;
    let lastPass: number | null = null;
    const out: { task: number; status: string; reapply: boolean }[] = [];
    for (let t = 1; t <= n; t++) {
      const d = crowdDecision(m, t, "seed", t <= 3);
      const before = joined === null ? null : employeeState({ joined_after: joined, last_pass_day: lastPass, stored_streak: 0 }, t - 1, 3, 7);
      if (d.action !== "skip" && joined === null) joined = t - 1;
      if (d.action === "pass") lastPass = t;
      const after = joined === null ? "none" : employeeState({ joined_after: joined, last_pass_day: lastPass, stored_streak: 0 }, t, 3, 7).status;
      out.push({ task: t, status: after, reapply: d.action === "pass" && before?.status === "laid_off" });
    }
    return out;
  }

  it("F is laid off at task 4 and rehired at 5, then again at 9 and 10", () => {
    const s = story(F, 10);
    expect(s.filter((x) => x.status === "laid_off").map((x) => x.task)).toEqual([4, 9]);
    expect(s.filter((x) => x.reapply).map((x) => x.task)).toEqual([5, 10]);
  });

  it("slackers get laid off naturally, but not before F's story (task 5)", () => {
    for (const m of crowd.filter((x) => x.profile === "slacker")) {
      const s = story(m, 14);
      const first = s.find((x) => x.status === "laid_off")?.task;
      expect(first, m.name).toBeGreaterThan(5);
      expect(first, m.name).toBeLessThanOrEqual(12);
    }
  });
});
