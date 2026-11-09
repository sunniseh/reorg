import { buildTower, solvePuzzle, answerHashBase64 } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { SimSource, SIM_PLAYER } from "../src/state/sim";
import { effectiveStatus } from "../src/state/types";

const EPOCH = 60_000;

function makeSim(size = 24, seed = "t") {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const sim = new SimSource({ size, seed, epochMs: EPOCH, history: 6, firstOpenInMs: 4000, clock, manual: true });
  const step = (ms: number) => {
    now += ms;
    sim.advance(now);
  };
  return { sim, step, clock };
}

const big = (s: string) => BigInt(s);

describe("SimSource (W-01)", () => {
  it("loads with history: six finalized days, a tower and a balanced book", () => {
    const { sim } = makeSim();
    const s = sim.snapshot();
    expect(s.lastFinalized).toBe(6);
    expect(s.task?.status).toBe("finalized");
    const l = buildTower({ config: s.config, totalSupply: s.totalSupply, holders: s.holders, employees: s.employees, task: s.task, submissions: s.submissions, isCrowd: s.isCrowd });
    expect(l.employees).toBeGreaterThan(18);
    expect(l.visitors.length).toBeGreaterThan(0);
    expect(sim.feed()[sim.feed().length - 1]!.text).toMatch(/simulated/i);
  });

  it("is deterministic for a seed and clock", () => {
    const a = makeSim(24, "same");
    const b = makeSim(24, "same");
    a.step(30_000);
    b.step(30_000);
    const pick = (s: ReturnType<SimSource["snapshot"]>) => JSON.stringify({ e: s.employees, h: s.holders, t: s.task, sub: s.submissions });
    expect(pick(a.sim.snapshot())).toBe(pick(b.sim.snapshot()));
    expect(pick(makeSim(24, "other").sim.snapshot())).not.toBe(pick(a.sim.snapshot()));
  });

  it("plays open → submissions → results → payday, with events in seq order, and the books balance", () => {
    const { sim, step, clock } = makeSim();
    const events: string[] = [];
    const seqs: number[] = [];
    sim.onEvent((e) => {
      events.push(e.event);
      seqs.push(e.seq);
    });
    step(5_000);
    expect(sim.snapshot().task?.status).toBe("open");
    expect(events[0]).toBe("task_opened");
    step(36_500);
    expect(effectiveStatus(sim.snapshot().task!, clock())).toBe("closed");
    expect(events.filter((e) => e === "submission_received").length).toBeGreaterThan(5);
    step(5_000);
    expect(sim.snapshot().task?.status).toBe("finalized");
    expect(events).toContain("payroll_allocated");
    expect(events).toContain("task_finalized");
    step(15_000);
    expect(events).toContain("salary_paid");
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    for (let i = 0; i < 12; i++) step(EPOCH);
    const t = sim.snapshot().treasury;
    // 6 NEAR opening reserve + all income = reserve + outstanding + accrued + paid + operating costs.
    const lhs = 6n * 10n ** 24n + big(t.total_income);
    const rhs = big(t.reserve) + big(t.outstanding) + big(t.income_accrued) + big(t.total_paid) + big(t.total_operating_cost);
    expect(rhs).toBe(lhs);
    expect(big(t.total_forfeited)).toBeGreaterThan(0n); // the dumper
  });

  it("lays someone off and rehires someone over a long run (D5, D4)", () => {
    const { sim, step } = makeSim(60, "long");
    const seen = new Set<string>();
    sim.onFeed((items) => items.forEach((f) => seen.add(f.kind)));
    const events: string[] = [];
    sim.onEvent((e) => events.push(e.event));
    for (let i = 0; i < 30; i++) step(EPOCH);
    expect(seen.has("layoff")).toBe(true);
    expect(events).toContain("rehired");
    expect(seen.has("rehire")).toBe(true);
    expect(sim.snapshot().employees.some((e) => e.status === "laid_off")).toBe(true);
  });

  it("lets the sim player badge in, solve, get paid and claim", async () => {
    const { sim, step } = makeSim(8, "player");
    const wallet = sim.wallet();
    expect(await wallet.connect()).toBe(SIM_PLAYER);
    step(5_000);
    const p = await sim.puzzle(SIM_PLAYER);
    expect(p).not.toBeNull();
    const answers = solvePuzzle("decode-memo", p!.display, p!.hint);
    expect(answers).toHaveLength(1);
    const out = await wallet.submit(p!.task_id, answerHashBase64(answers[0]!, SIM_PLAYER));
    expect(out).toEqual({ accepted: true, reason: null });
    await expect(wallet.submit(p!.task_id, answerHashBase64(answers[0]!, SIM_PLAYER))).rejects.toThrow(/already submitted/);
    step(45_000);
    const me = await sim.player(SIM_PLAYER);
    expect(me.claimables).toHaveLength(1);
    const claim = await wallet.claimSalary(me.claimables[0]!.task_id);
    expect(claim.status).toBe("paid");
    expect((await sim.player(SIM_PLAYER)).employee?.total_earned).not.toBe("0");
  });

  it("scales to 150 holders (stage 3 preview) and stays quick", () => {
    const t0 = performance.now();
    const { sim, step } = makeSim(150, "big");
    for (let i = 0; i < 3; i++) step(EPOCH);
    expect(sim.snapshot().holders.length).toBeGreaterThanOrEqual(150);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
