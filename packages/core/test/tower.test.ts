import { describe, expect, it } from "vitest";
import {
  antidumpAllows,
  antidumpMinimum,
  appearanceOf,
  buildTower,
  decodeTower,
  encodeTower,
  DRAWN_FLOORS,
  DRAWN_VISITORS,
  buildingStateOf,
  layoutTower,
  ROOMS_PER_FLOOR,
  towerCharacters,
  type EmployeeStatus,
  type EmployeeView,
  type SubmissionView,
  type TierIndex,
  type TowerInput,
  type TowerLayout,
} from "../src";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
const CONFIG = {
  tier_thresholds_ppm: [30_000, 10_000, 2_500, 10] as [number, number, number, number],
  excluded_accounts: ["deployer.test", "reorg.test"],
  streak_milestones: [3, 7, 14],
};
/** Balance at `mille`/1000 of a tier's threshold (tier 4 = a visitor at 40% of the Intern threshold). */
const bal = (tier: 0 | 1 | 2 | 3 | 4, mille: number): bigint =>
  (SUPPLY * BigInt([30_000, 10_000, 2_500, 10, 10][tier]!) * BigInt(tier === 4 ? 400 : mille)) / 1_000_000_000n;

function emp(account_id: string, status: EmployeeStatus, last_tier: TierIndex, extra: Partial<EmployeeView> = {}): EmployeeView {
  return {
    account_id,
    joined_after: 0,
    last_pass_day: status === "active" ? 5 : 2,
    stored_streak: 2,
    effective_streak: status === "active" ? 4 : 0,
    gap: status === "active" ? 0 : status === "struggling" ? 1 : 3,
    status,
    misses_in_row: status === "struggling" ? 1 : 0,
    layoff_tasks_left: status === "laid_off" ? 7 : 0,
    last_tier,
    last_balance: "1",
    total_earned: "0",
    badges: 0,
    recent: [],
    ...extra,
  };
}

function sub(account_id: string, task_id: number, passed: boolean, pay = "0"): SubmissionView {
  return {
    task_id,
    account_id,
    answer_hash: "A".repeat(43) + "=",
    balance: "1",
    tier: 3,
    streak_before: 0,
    multiplier_bps: 10000,
    weight: "10000",
    submitted_at: "1",
    reapply: false,
    passed,
    pay,
    claim: "unclaimed",
  };
}

/** A deterministic synthetic company of `n` holders (~10% visitors, mixed statuses). */
function company(n: number): TowerInput {
  const holders: { account_id: string; balance: string }[] = [];
  const employees: EmployeeView[] = [];
  const submissions: SubmissionView[] = [];
  for (let i = 0; i < n; i++) {
    const w = `w${String(i).padStart(3, "0")}.test`;
    const tier = (i % 13 === 12 ? 4 : [3, 3, 3, 2, 3, 2, 1, 3, 2, 0][i % 10]) as 0 | 1 | 2 | 3 | 4;
    holders.push({ account_id: w, balance: bal(tier, 1100 + ((i * 37) % 300)).toString() });
    if (tier === 4) continue;
    if (i % 7 === 3) continue; // new hire
    const status: EmployeeStatus = i % 11 === 4 ? "laid_off" : i % 5 === 2 ? "struggling" : "active";
    employees.push(emp(w, status, tier as TierIndex));
    if (i % 3 !== 0) submissions.push(sub(w, 6, i % 4 !== 1, i % 4 !== 1 ? "1000" : "0"));
  }
  return { config: CONFIG, totalSupply: SUPPLY, holders, employees, task: { id: 6, status: "finalized" }, submissions };
}

/** Compact, human-readable picture of a layout for golden snapshots. */
function picture(l: TowerLayout): string {
  const mark = { new_hire: "N", active: "a", struggling: "s", laid_off: "L", visitor: "v" } as const;
  const lines = [`state=${l.state} employees=${l.employees} tiers=${l.tierCounts.join("/")}`];
  for (const f of l.floors)
    lines.push(`${f.key} ${f.desks.map((d) => (d ? `${d.wallet.slice(0, 4)}${mark[d.status]}${d.result === "pass" ? "+" : d.result === "miss" ? "x" : ""}` : "----")).join(" ")}`);
  lines.push(`bench ${l.bench.map((c) => c.wallet.slice(0, 4)).join(" ")}`);
  lines.push(`queue ${l.visitors.map((c) => c.wallet.slice(0, 4)).join(" ")}`);
  return lines.join("\n");
}

describe("appearanceOf (W-04, design §5.1)", () => {
  // Expected values computed independently with Python's hashlib.
  it.each([
    ["alice.testnet", 2, "bun", 2],
    ["c001.reorg.testnet", 0, "short", 2],
    ["bob.near", 4, "bun", 2],
    ["x", 5, "curly", 4],
    ["f".repeat(64), 7, "bun", 0],
    ["émile.testnet", 0, "curly", 0],
  ] as const)("%s", (wallet, body, hairStyle, hairColor) => {
    expect(appearanceOf(wallet)).toEqual({ body, hairStyle, hairColor });
  });

  it("covers every body color, style and hair color over many wallets", () => {
    const looks = Array.from({ length: 400 }, (_, i) => appearanceOf(`w${i}.test`));
    expect(new Set(looks.map((l) => l.body)).size).toBe(8);
    expect(new Set(looks.map((l) => l.hairStyle)).size).toBe(5);
    expect(new Set(looks.map((l) => l.hairColor)).size).toBe(6);
  });
});

describe("towerCharacters (PROTOCOL §6.5)", () => {
  const base = (over: Partial<TowerInput>): TowerInput => ({
    config: CONFIG,
    totalSupply: SUPPLY,
    holders: [],
    employees: [],
    task: null,
    submissions: [],
    ...over,
  });

  it("drops excluded accounts and zero balances", () => {
    const cs = towerCharacters(
      base({
        holders: [
          { account_id: "deployer.test", balance: SUPPLY.toString() },
          { account_id: "zero.test", balance: "0" },
          { account_id: "a.test", balance: bal(3, 1200).toString() },
        ],
      }),
    );
    expect(cs.map((c) => c.wallet)).toEqual(["a.test"]);
  });

  it("visitor beats employee status; new hire uses the balance tier; employees use last_tier", () => {
    const cs = towerCharacters(
      base({
        holders: [
          { account_id: "sold.test", balance: bal(4, 0).toString() },
          { account_id: "new.test", balance: bal(1, 1200).toString() },
          { account_id: "promo.test", balance: bal(0, 1200).toString() },
        ],
        employees: [emp("sold.test", "laid_off", 2), emp("promo.test", "active", 2)],
      }),
    );
    const by = Object.fromEntries(cs.map((c) => [c.wallet, c]));
    expect(by["sold.test"]).toMatchObject({ status: "visitor", tier: null, balanceTier: null });
    expect(by["new.test"]).toMatchObject({ status: "new_hire", tier: 1, balanceTier: 1, streak: 0 });
    expect(by["promo.test"]).toMatchObject({ status: "active", tier: 2, balanceTier: 0, streak: 4, flames: 1 });
  });

  it("paper while the task is not finalized, dots once it is", () => {
    const holders = [
      { account_id: "p.test", balance: bal(3, 1200).toString() },
      { account_id: "m.test", balance: bal(3, 1300).toString() },
      { account_id: "q.test", balance: bal(3, 1400).toString() },
    ];
    const submissions = [sub("p.test", 4, true, "500"), sub("m.test", 4, false)];
    for (const status of ["open", "closed", "finalizing"] as const) {
      const cs = towerCharacters(base({ holders, submissions, task: { id: 4, status } }));
      expect(cs.map((c) => [c.submitted, c.result])).toEqual([[true, null], [true, null], [false, null]]);
    }
    const done = towerCharacters(base({ holders, submissions, task: { id: 4, status: "finalized" } }));
    expect(done.map((c) => [c.submitted, c.result, c.pay])).toEqual([
      [false, "pass", 500n],
      [false, "miss", 0n],
      [false, null, 0n],
    ]);
  });

  it("marks crowd accounts only through the given predicate", () => {
    const cs = towerCharacters(
      base({
        holders: [{ account_id: "c001.crowd.test", balance: bal(3, 1200).toString() }, { account_id: "me.test", balance: bal(3, 1200).toString() }],
        isCrowd: (w) => w.endsWith(".crowd.test"),
      }),
    );
    expect(cs.map((c) => c.crowd)).toEqual([true, false]);
  });
});

/** Intern rooms per floor. */
const I = ROOMS_PER_FLOOR[3];

describe("layoutTower (W-02, design §4.3)", () => {
  it("an empty company still has one floor per tier", () => {
    const l = buildTower(company(0));
    expect(l.floors.map((f) => f.key)).toEqual(["t0f0", "t1f0", "t2f0", "t3f0"]);
    expect(l.floors.map((f) => f.desks.length)).toEqual([...ROOMS_PER_FLOOR]);
    expect(l.state).toBe("garage");
  });

  it("orders by tier, then balance descending, then account id, filling floors left to right", () => {
    const holders = [
      { account_id: "b.test", balance: bal(3, 1200).toString() },
      { account_id: "a.test", balance: bal(3, 1200).toString() },
      { account_id: "rich.test", balance: bal(3, 1900).toString() },
      { account_id: "boss.test", balance: bal(0, 1100).toString() },
    ];
    const l = buildTower({ config: CONFIG, totalSupply: SUPPLY, holders, employees: [], task: null, submissions: [] });
    expect(l.floors[0]!.desks[0]!.wallet).toBe("boss.test");
    expect(l.floors[3]!.desks.slice(0, 4).map((d) => d?.wallet ?? null)).toEqual(["rich.test", "a.test", "b.test", null]);
    expect(l.desks.get("b.test")).toEqual({ floor: 3, room: 2 });
  });

  it("adds a floor when a tier fills (6/9/12/18 rooms)", () => {
    const holders = Array.from({ length: I + 1 }, (_, i) => ({ account_id: `i${i}.test`, balance: bal(3, 1100 + i).toString() }));
    const l = buildTower({ config: CONFIG, totalSupply: SUPPLY, holders, employees: [], task: null, submissions: [] });
    const interns = l.floors.filter((f) => f.tier === 3);
    expect(interns.map((f) => f.desks.filter(Boolean).length)).toEqual([I, 1]);
  });

  it("is independent of holder order", () => {
    const input = company(60);
    const shuffled = { ...input, holders: [...input.holders].reverse(), employees: [...input.employees].reverse() };
    expect(picture(buildTower(shuffled))).toBe(picture(buildTower(input)));
  });

  it("laid-off employees keep their desk and sit on the bench; visitors queue", () => {
    const l = buildTower(company(24));
    for (const c of l.bench) {
      expect(c.status).toBe("laid_off");
      expect(l.desks.has(c.wallet)).toBe(true);
    }
    expect(l.visitors.every((c) => c.status === "visitor" && !l.desks.has(c.wallet))).toBe(true);
    expect(l.characters.length).toBe(l.employees + l.visitors.length);
  });

  it.each([0, 1, 8, 24, 60, 150])("golden layout with %i holders", (n) => {
    expect(picture(layoutTower(towerCharacters(company(n))))).toMatchSnapshot();
  });
});

describe("buildingStateOf (design §12.2, no hysteresis)", () => {
  it.each([
    [0, "garage"],
    [10, "garage"],
    [11, "office"],
    [50, "office"],
    [51, "tower"],
    [250, "tower"],
    [251, "skyscraper"],
    [1000, "skyscraper"],
    [1001, "megacorp"],
    [5000, "megacorp"],
    [5001, "campus"],
    [25_000, "campus"],
    [25_001, "conglomerate"],
  ] as const)("%i employees → %s", (n, s) => expect(buildingStateOf(n)).toBe(s));
});

describe("folding past DRAWN_FLOORS (design §4.3, §12)", () => {
  /** `n` Interns (I per floor), `v` visitors; every 3rd intern passed, every 5th missed, every 7th laid off. */
  function interns(n: number, v = 0): TowerInput {
    const holders = [];
    const employees: EmployeeView[] = [];
    const submissions: SubmissionView[] = [];
    for (let i = 0; i < n; i++) {
      const w = `i${String(i).padStart(5, "0")}.test`;
      // Strictly descending balances, so desk order is the index order.
      holders.push({ account_id: w, balance: (bal(3, 1000) + BigInt(n - i) * 10n ** 18n).toString() });
      employees.push(emp(w, i % 7 === 0 ? "laid_off" : "active", 3));
      if (i % 3 === 0) submissions.push(sub(w, 6, true, "1000"));
      else if (i % 5 === 0) submissions.push(sub(w, 6, false, "0"));
    }
    for (let i = 0; i < v; i++) holders.push({ account_id: `v${String(i).padStart(5, "0")}.test`, balance: bal(4, 0).toString() });
    return { config: CONFIG, totalSupply: SUPPLY, holders, employees, task: { id: 6, status: "finalized" }, submissions };
  }

  it("draws every floor up to DRAWN_FLOORS per tier", () => {
    const l = buildTower(interns(DRAWN_FLOORS * I));
    expect(l.folds).toEqual([]);
    expect(l.foldedFloors).toBe(0);
    expect(l.floors.filter((f) => f.tier === 3)).toHaveLength(DRAWN_FLOORS);
  });

  it("folds the rest with exact counts, and keeps the totals", () => {
    const n = I * 50 + 5; // 51 Intern floors
    const D = DRAWN_FLOORS;
    const drawn = I * D;
    const l = buildTower(interns(n, 120));
    expect(l.employees).toBe(n);
    expect(l.tierCounts[3]).toBe(n);
    expect(l.floors.filter((f) => f.tier === 3).map((f) => f.index)).toEqual(Array.from({ length: D }, (_, i) => i));
    expect(l.folds).toHaveLength(1);
    const f = l.folds[0]!;
    expect(f).toMatchObject({ key: `t3f${D}-50`, tier: 3, from: D, to: 50, before: l.floors.length });
    expect(l.foldedFloors).toBe(51 - D);
    const tail = Array.from({ length: n - drawn }, (_, j) => j + drawn);
    expect(f.employees).toBe(tail.length);
    expect(f.passed).toBe(tail.filter((i) => i % 3 === 0).length);
    expect(f.missed).toBe(tail.filter((i) => i % 3 !== 0 && i % 5 === 0).length);
    expect(f.laidOff).toBe(tail.filter((i) => i % 7 === 0).length);
    // Only drawn characters reach the renderer; the counts stay whole.
    expect(l.characters).toHaveLength(drawn + DRAWN_VISITORS);
    expect(l.desks.size).toBe(drawn);
    expect(l.visitorCount).toBe(120);
    expect(l.visitors).toHaveLength(DRAWN_VISITORS);
    expect(l.benchCount).toBe(Array.from({ length: n }, (_, i) => i).filter((i) => i % 7 === 0).length);
    expect(l.bench.every((c) => l.desks.has(c.wallet))).toBe(true);
  });

  it("always draws the player's floor, splitting the fold around it", () => {
    const input = interns(I * 50);
    const you = `i${String(I * 45 + 5).padStart(5, "0")}.test`; // floor 45, room 5
    const l = buildTower(input, { you });
    // Floors 0..2 are the empty Director, Manager and Associate floors.
    const yours = 3 + DRAWN_FLOORS;
    expect(l.folds.map((f) => [f.key, f.before])).toEqual([
      [`t3f${DRAWN_FLOORS}-44`, yours],
      ["t3f46-49", yours + 1],
    ]);
    const ref = l.desks.get(you)!;
    expect(ref).toEqual({ floor: yours, room: 5 });
    expect(l.floors[ref.floor]).toMatchObject({ key: "t3f45", index: 45 });
    expect(l.foldedFloors).toBe(50 - DRAWN_FLOORS - 1);
    // A drawn player changes nothing.
    expect(buildTower(input, { you: "i00001.test" }).folds.map((f) => f.key)).toEqual([`t3f${DRAWN_FLOORS}-49`]);
  });

  it("a fold that ends a tier sits before the next tier's first floor", () => {
    const l = layoutTower(towerCharacters(interns(I * 3)), { drawnFloors: 1 });
    expect(l.folds.map((f) => [f.key, f.before])).toEqual([["t3f1-2", l.floors.length]]);
  });
});

describe("anti-dump mirror (PROTOCOL §7.4)", () => {
  it("allows exactly at the threshold and computes the minimum", () => {
    expect(antidumpAllows(900n, 1000n, 9000)).toBe(true);
    expect(antidumpAllows(899n, 1000n, 9000)).toBe(false);
    expect(antidumpMinimum(1000n, 9000)).toBe(900n);
    expect(antidumpMinimum(1001n, 9000)).toBe(901n);
    expect(antidumpAllows(antidumpMinimum(1001n, 9000), 1001n, 9000)).toBe(true);
  });
});

describe("tower wire (boss GET /api/tower)", () => {
  it("round-trips a folded layout through JSON, deriving looks and crowd labels locally", () => {
    const input = company(150);
    const l = layoutTower(towerCharacters({ ...input, isCrowd: (w: string) => w.startsWith("w00") }), { drawnFloors: 2, you: "w140.test" });
    expect(l.folds.length).toBeGreaterThan(0);
    const back = decodeTower(JSON.parse(JSON.stringify(encodeTower(l))), { isCrowd: (w) => w.startsWith("w00") });
    expect(back).toEqual(l);
  });

  it("rejects an unknown payload", () => {
    expect(() => decodeTower({ v: 2 } as never)).toThrow(/unknown payload/);
  });
});
