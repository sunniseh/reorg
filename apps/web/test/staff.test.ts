import { buildTower } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { staffGroups } from "../src/hud/staff";
import { SimSource } from "../src/state/sim";

function layoutOf(size: number) {
  const sim = new SimSource({ size, seed: "staff", epochMs: 60_000, history: 6, firstOpenInMs: 4000, clock: () => 1_700_000_000_000, manual: true });
  const s = sim.snapshot();
  return { s, layout: buildTower({ config: s.config, totalSupply: s.totalSupply, holders: s.holders, employees: s.employees, task: s.task, submissions: s.submissions, isCrowd: s.isCrowd }) };
}

describe("employee list (W-18)", () => {
  it("lists every drawn character once, in building order: tier floors top down, then visitors", () => {
    const { s, layout } = layoutOf(24);
    const groups = staffGroups(layout, { you: null, simulated: true, layoffAfter: s.config.layoff_after });
    const wallets = groups.flatMap((g) => g.rows.map((r) => r.wallet));
    expect(wallets).toEqual(layout.characters.map((c) => c.wallet));
    const order = ["Directors", "Managers", "Associates", "Interns", "Visitors"];
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(order.filter((l) => labels.includes(l)));
    expect(groups.at(-1)!.label).toBe("Visitors");
    // Desk order inside a tier is the layout's (balance descending), never re-sorted here.
    for (const g of groups.slice(0, -1)) {
      const balances = g.rows.map((r) => layout.characters.find((c) => c.wallet === r.wallet)!.balance);
      for (let i = 1; i < balances.length; i++) expect(balances[i - 1]! >= balances[i]!).toBe(true);
    }
  });

  it("marks the player, simulated accounts, the laid off and today's results in text", () => {
    const { s, layout } = layoutOf(24);
    const me = layout.characters[0]!.wallet;
    const rows = staffGroups(layout, { you: me, simulated: true, layoffAfter: s.config.layoff_after }).flatMap((g) => g.rows);
    expect(rows.find((r) => r.wallet === me)!.you).toBe(true);
    expect(rows.every((r) => r.simulated)).toBe(true);
    for (const c of layout.bench) expect(rows.find((r) => r.wallet === c.wallet)!.status).toMatch(/^Laid off: \d+ tasks? left$/);
    for (const c of layout.characters) {
      const r = rows.find((x) => x.wallet === c.wallet)!;
      expect(r.today).toBe(c.submitted ? "Filed" : c.result === "pass" ? "Passed" : c.result === "miss" ? "Missed" : "");
    }
  });

  it("pins the badged-in player's card first, once, and keeps everyone else in building order", () => {
    const { s, layout } = layoutOf(24);
    const me = layout.characters[Math.floor(layout.characters.length / 2)]!.wallet;
    const groups = staffGroups(layout, { you: me, simulated: true, layoffAfter: s.config.layoff_after });
    expect(groups[0]!.label).toBe("You");
    expect(groups[0]!.rows.map((r) => r.wallet)).toEqual([me]);
    const rest = groups.slice(1).flatMap((g) => g.rows.map((r) => r.wallet));
    expect(rest).toEqual(layout.characters.map((c) => c.wallet).filter((w) => w !== me));
    // A wallet that is not drawn (not badged in, or not in this building) pins nothing.
    expect(staffGroups(layout, { you: "nobody.near", simulated: true, layoffAfter: s.config.layoff_after })[0]!.label).not.toBe("You");
  });

  it("is empty when nobody holds a desk", () => {
    const { s, layout } = layoutOf(8);
    const empty = { ...layout, characters: [], visitors: [], bench: [], employees: 0 };
    expect(staffGroups(empty, { you: null, simulated: false, layoffAfter: s.config.layoff_after })).toEqual([]);
  });
});
