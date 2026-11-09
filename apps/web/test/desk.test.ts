import type { EmployeeView, SubmissionView } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { rejectionCopy } from "../src/copy";
import { deskModel } from "../src/state/desk";
import { SimSource } from "../src/state/sim";
import type { PlayerView, Snapshot } from "../src/state/types";

// A real snapshot shape from the sim, then edited per case.
const base = new SimSource({ size: 8, seed: "desk", manual: true, clock: () => 1_700_000_000_000 }).snapshot();
const NOW = 1_700_000_000_000;
const INTERN = (base.totalSupply * 6n) / 10_000n; // 0.06% > 0.05% (5 bps) Intern threshold
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function snap(status: "open" | "finalized" | "finalizing" | null, closesInMs = 30_000): Snapshot {
  if (status === null) return { ...base, task: null, submissions: [] };
  return { ...base, task: { ...base.task!, id: 9, status, closes_at: ns(NOW + closesInMs) } };
}

function emp(over: Partial<EmployeeView> = {}): EmployeeView {
  return {
    account_id: "me.test", joined_after: 0, last_pass_day: 8, stored_streak: 1, effective_streak: 1, gap: 0, status: "active",
    misses_in_row: 0, layoff_tasks_left: 0, last_tier: 3, last_balance: INTERN.toString(), total_earned: "0", badges: 0, recent: [], ...over,
  };
}

function sub(over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    task_id: 9, account_id: "me.test", answer_hash: "x", balance: INTERN.toString(), tier: 3, streak_before: 0, multiplier_bps: 10000,
    weight: "1", submitted_at: "1", reapply: false, passed: false, pay: "0", claim: "unclaimed", ...over,
  };
}

function player(over: Partial<PlayerView> = {}, balance = INTERN): PlayerView {
  return { wallet: "me.test", holder: { balance: balance.toString(), last_received_at: "0" }, employee: emp(), submission: null, claimables: [], ...over };
}

describe("deskModel (design §3.1: one primary button, first match wins)", () => {
  it("not connected → Badge in", () => {
    expect(deskModel(snap("open"), null, NOW)).toMatchObject({ state: "disconnected", primary: { kind: "badge_in" } });
  });

  it("open, laid off, no submission → Reapply with the unpaid note", () => {
    const m = deskModel(snap("open"), player({ employee: emp({ status: "laid_off", layoff_tasks_left: 5 }) }), NOW);
    expect(m).toMatchObject({ state: "reapply", primary: { kind: "reapply" }, showPuzzle: true });
    expect(m.note).toMatch(/unpaid/);
  });

  it("open with a tier → Submit answer, even with salary waiting", () => {
    const claimable = sub({ task_id: 8, passed: true, pay: "100" });
    expect(deskModel(snap("open"), player({ claimables: [claimable] }), NOW)).toMatchObject({ state: "open", primary: { kind: "submit" } });
  });

  it("a new hire can submit too", () => {
    expect(deskModel(snap("open"), player({ employee: null }), NOW).primary?.kind).toBe("submit");
  });

  it("submitted → Claim salary from an earlier day; amount on the button", () => {
    const m = deskModel(snap("open"), player({ submission: sub(), claimables: [sub({ task_id: 8, passed: true, pay: "450000000000000000000000" })] }), NOW);
    expect(m.primary).toMatchObject({ kind: "claim", taskId: 8, label: "Claim 0.45 NEAR" });
  });

  it("never offers a claim that would forfeit (anti-dump)", () => {
    const claimable = sub({ task_id: 8, passed: true, pay: "100", balance: (INTERN * 2n).toString() });
    const m = deskModel(snap("finalized"), player({ claimables: [claimable] }), NOW);
    expect(m.state).toBe("claim_blocked");
    expect(m.primary).toBeNull();
    expect(m.note).toMatch(/90% of what you held/);
  });

  it("offers an older salary the anti-dump rule allows when the newest one is held (§3.1: any task)", () => {
    const blocked = sub({ task_id: 8, passed: true, pay: "100", balance: (INTERN * 2n).toString() });
    const allowed = sub({ task_id: 6, passed: true, pay: "50" });
    const m = deskModel(snap("finalized"), player({ claimables: [blocked, allowed] }), NOW);
    expect(m.primary).toMatchObject({ kind: "claim", taskId: 6 });
  });

  it("visitor → no button, lobby copy", () => {
    expect(deskModel(snap("open"), player({ employee: null }, 1n), NOW)).toMatchObject({ state: "visitor", primary: null });
  });

  it("submitted while open, pending once closed", () => {
    expect(deskModel(snap("open"), player({ submission: sub() }), NOW).state).toBe("submitted");
    expect(deskModel(snap("open"), player({ submission: sub({ reapply: true }) }), NOW).state).toBe("reapply_filed");
    expect(deskModel(snap("open", -1), player({ submission: sub() }), NOW).state).toBe("pending");
    expect(deskModel(snap("finalizing"), player({ submission: sub() }), NOW).state).toBe("pending");
    expect(deskModel(snap("open", -1), player(), NOW).state).toBe("closed");
  });

  it("finalized: passed, failed, laid off, new hire, no task", () => {
    expect(deskModel(snap("finalized"), player({ submission: sub({ passed: true, claim: "claimed" }) }), NOW).line).toMatch(/collected/);
    expect(deskModel(snap("finalized"), player({ submission: sub() }), NOW).state).toBe("failed");
    expect(deskModel(snap("finalized"), player({ employee: emp({ status: "laid_off", layoff_tasks_left: 3 }) }), NOW).note).toMatch(/3 tasks/);
    expect(deskModel(snap("finalized"), player({ employee: null }), NOW).state).toBe("new_hire");
    expect(deskModel(snap(null), player(), NOW).state).toBe("no_task");
  });
});

describe("rejectionCopy (design §13.2)", () => {
  it.each([
    ["tokens received after the task opened (anti-recycling)", /Paperwork for recent transfers/],
    ["balance below the minimum tier (visitor)", /Visitors may wait/],
    ["Smart contract panicked: already submitted for this task", /One per employee/],
    ["submission window is closed", /matter for tomorrow/],
    ["storage float is low: the operator must top up the contract", /filing cabinets/],
    ["something new", /escalated to HR/],
  ])("%s", (reason, re) => {
    const c = rejectionCopy(reason);
    expect(c.text).toMatch(re);
    expect(c.detail).toBe(reason);
  });
});
