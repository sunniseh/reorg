// B-08 … B-11: the scheduler cycle on the in-memory chain with a manual clock.
import { afterEach, describe, expect, it } from "vitest";
import { commitHash, fromBase64, toBase64, type FinalizeTaskArgs, type OpenTaskArgs } from "@reorg/core";
import { attachPlayers, makeWorld, type World } from "./helpers";

let world: World;
afterEach(() => world?.close());

const opens = (w: World) => w.chain.applied.filter((c) => c.method === "openTask").map((c) => c.args as OpenTaskArgs);
const finals = (w: World) => w.chain.applied.filter((c) => c.method === "finalizeTask").map((c) => c.args as FinalizeTaskArgs);
const feedOf = (w: World, kind: string) => w.store.listFeed(0, 1000).filter((f) => f.kind === kind);

describe("one full cycle (B-09)", () => {
  it("opens, waits, reveals, verifies passers and announces, three tasks in a row", async () => {
    world = makeWorld();
    attachPlayers(world.chain, () => world.store, ["alice", "bob", "carol"], (a) => (a === "alice" ? "pass" : a === "bob" ? "fail" : "skip"));
    await world.runUntil(() => world.finalizedSlots() === 3);

    expect(world.chain.current).toBe(3);
    expect(world.chain.lastFinalized).toBe(3);
    expect(opens(world)).toHaveLength(3);
    for (const id of [1, 2, 3]) {
      const t = world.chain.tasks.get(id)!;
      expect(t.status).toBe("finalized");
      expect(t.submitted).toBe(2);
      expect(t.passed).toBe(1);
      const row = world.store.findByChainId(id)!;
      expect(row.state).toBe("FINALIZED");
      expect(toBase64(commitHash(fromBase64(row.secret!)))).toBe(t.commit);
      expect(row.submitted).toBe(2);
      expect(row.passed).toBe(1);
      expect(row.flavor_source).toBe("template");
    }
    expect(world.chain.subs.get(1)!.find((s) => s.account === "alice")!.passed).toBe(true);
    expect(world.chain.subs.get(1)!.find((s) => s.account === "bob")!.passed).toBe(false);
    expect(feedOf(world, "task_opened")).toHaveLength(3);
    expect(feedOf(world, "results")).toHaveLength(3);
    expect(feedOf(world, "payday")).toHaveLength(3);
    expect(feedOf(world, "results")[0]!.data).toMatchObject({ task_id: 1, submitted: 2, passed: 1 });
  });

  it("freezes first, then sends passers in batches of max_passers_per_call with `last` on the final one", async () => {
    world = makeWorld({ chain: { max_passers_per_call: 2 } });
    const players = ["p1", "p2", "p3", "p4", "p5", "x"];
    attachPlayers(world.chain, () => world.store, players, (a) => (a === "x" ? "fail" : "pass"));
    await world.runUntil(() => world.finalizedSlots() === 1);
    const calls = finals(world);
    expect(calls.map((c) => [c.passers.length, c.last])).toEqual([
      [0, false],
      [2, false],
      [2, false],
      [1, true],
    ]);
    expect(calls.flatMap((c) => c.passers).sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("finalizes a task with no submissions", async () => {
    world = makeWorld();
    await world.runUntil(() => world.finalizedSlots() === 1);
    expect(finals(world).map((c) => [c.passers.length, c.last])).toEqual([
      [0, false],
      [0, true],
    ]);
    expect(feedOf(world, "results")[0]!.text).toMatch(/zero submissions/);
    expect(feedOf(world, "payday")).toHaveLength(0);
  });

  it("respects the epoch and the window (EPOCH_SECONDS, WINDOW_FRACTION, finality margin)", async () => {
    world = makeWorld({ config: { epochMs: 60_000, windowFraction: 0.5, finalityMarginMs: 2000 } });
    await world.runUntil(() => world.finalizedSlots() === 2);
    const [t1, t2] = [world.chain.tasks.get(1)!, world.chain.tasks.get(2)!];
    expect(Number(t1.closes_at - t1.opens_at) / 1e6).toBe(30_000);
    expect(Number(t2.opens_at - t1.opens_at) / 1e6).toBeGreaterThanOrEqual(60_000);
    expect(Number(t2.opens_at - t1.opens_at) / 1e6).toBeLessThan(61_000);
    // Revealed no earlier than closes_at + margin.
    expect(Number(t1.finalized_at! - t1.closes_at) / 1e6).toBeGreaterThanOrEqual(2000);
  });

  it("never opens a window shorter than min_window_ns plus slack", async () => {
    world = makeWorld({ config: { epochMs: 4000, windowFraction: 0.5 }, chain: { min_window_ns: "5000000000" } });
    await world.runUntil(() => world.finalizedSlots() === 1);
    const t = world.chain.tasks.get(1)!;
    expect(Number(t.closes_at - t.opens_at) / 1e6).toBe(6000);
  });

  it("warm-up: level 1, short windows, back to back (D-03)", async () => {
    world = makeWorld({ config: { warmupTasks: 2, warmupWindowMs: 10_000, epochMs: 600_000 } });
    await world.runUntil(() => world.finalizedSlots() === 3);
    const rows = world.store.listTasks(1, 3);
    expect(rows.map((r) => r.warmup)).toEqual([true, true, false]);
    expect(rows.slice(0, 2).every((r) => r.params!.level === 1)).toBe(true);
    const [t1, t2, t3] = [1, 2, 3].map((i) => world.chain.tasks.get(i)!);
    expect(Number(t1!.closes_at - t1!.opens_at) / 1e6).toBe(10_000);
    // Task 2 opens right after task 1 finalized; task 3 (normal) right after task 2.
    expect(Number(t2!.opens_at - t1!.finalized_at!) / 1e6).toBeLessThan(1000);
    expect(Number(t3!.closes_at - t3!.opens_at) / 1e6).toBe(300_000);
    expect(world.store.listFeed(0, 100).find((f) => f.kind === "task_opened")!.text).toMatch(/^Orientation exercise/);
  });
});

describe("look-ahead queue and secrets (B-04, B-08)", () => {
  it("keeps the next slots generated and self-checked, each with its own secret", async () => {
    world = makeWorld({ config: { lookahead: 4 } });
    await world.scheduler.tick();
    const rows = world.store.listTasks();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.secret && r.commit && r.params && r.check_ok)).toBe(true);
    expect(new Set(rows.map((r) => r.secret)).size).toBe(5);
    const h = world.scheduler.health();
    expect(h.ok).toBe(true);
    expect(h.lookahead).toHaveLength(5);
  });

  it("persists the secret before open_task (the player hook checks the store at open time)", async () => {
    world = makeWorld();
    attachPlayers(world.chain, () => world.store, ["alice"], () => "pass");
    await world.runUntil(() => world.finalizedSlots() === 1);
    expect(world.chain.tasks.get(1)!.passed).toBe(1);
  });

  it("never repeats yesterday's cipher", async () => {
    world = makeWorld({ config: { lookahead: 10 } });
    await world.scheduler.tick();
    const ciphers = world.store.listTasks().map((r) => r.requested.cipher);
    for (let i = 1; i < ciphers.length; i++) expect(ciphers[i]).not.toBe(ciphers[i - 1]);
  });
});

describe("notices from status diffs and events (B-09)", () => {
  it("warns, lays off and rehires wallet F; announces streaks", async () => {
    world = makeWorld({ config: { epochMs: 20_000 } });
    // F passes task 1, misses 2-4 (laid off after task 4), passes task 5 as reapplication.
    attachPlayers(world.chain, () => world.store, ["alice", "f"], (a, id) => (a === "alice" ? "pass" : id === 1 || id === 5 ? "pass" : "skip"));
    await world.runUntil(() => world.finalizedSlots() === 5);

    const notice = (kind: string) => feedOf(world, kind).map((f) => [f.task_id, f.data["account"]]);
    expect(notice("layoff_warning")).toEqual([[3, "f"]]);
    expect(notice("layoff")).toEqual([[4, "f"]]);
    expect(notice("rehire")).toEqual([[5, "f"]]);
    expect(notice("streak")).toEqual([[3, "alice"]]);
    expect(world.chain.subs.get(5)!.find((s) => s.account === "f")!.reapply).toBe(true);
    expect(world.chain.employeeView("f").status).toBe("active");
    expect(feedOf(world, "layoff")[0]!.text).toContain("f");
  });
});

describe("retries and STALLED (B-11)", () => {
  it("retries a failing RPC with backoff and carries on", async () => {
    world = makeWorld();
    world.chain.fail("getInfo", "before", 2);
    await world.runUntil(() => world.finalizedSlots() === 1);
    expect(world.scheduler.health().status).toBe("RUNNING");
    expect(feedOf(world, "stalled")).toHaveLength(0);
  });

  it("reports STALLED after repeated failures, then recovers", async () => {
    world = makeWorld({ config: { stallAfterAttempts: 3 } });
    world.chain.fail("finalizeTask", "before", 4, "RPC timeout");
    await world.runUntil(() => world.scheduler.health().status === "STALLED");
    const h = world.scheduler.health();
    expect(h.ok).toBe(false);
    expect(h.stalled).toMatchObject({ slot: 1, state: "FINALIZING" });
    expect(h.head?.last_error).toMatch(/RPC timeout/);
    expect(feedOf(world, "stalled")).toHaveLength(1);
    await world.runUntil(() => world.finalizedSlots() === 1);
    expect(world.scheduler.health().status).toBe("RUNNING");
    expect(feedOf(world, "recovered")).toHaveLength(1);
  });

  it("stalls at once when the chain has a task this boss does not own", async () => {
    world = makeWorld();
    world.chain.current = 1; // someone else's unfinalized task 1
    await world.runUntil(() => world.scheduler.health().status === "STALLED", 20);
    expect(world.scheduler.health().stalled!.reason).toMatch(/not this boss's/);
    expect(opens(world)).toHaveLength(0);
  });

  it("stalls (never re-opens) if its reserved task id exists with a different commit", async () => {
    world = makeWorld();
    await world.runUntil(() => world.store.headTask()?.state === "OPEN");
    const row = world.store.findByChainId(1)!;
    world.chain.tasks.get(1)!.commit = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    world.store.commit({ task: { ...row, state: "OPENING" } });
    await world.scheduler.tick();
    expect(world.scheduler.health().stalled!.reason).toMatch(/different commit/);
    expect(opens(world)).toHaveLength(1);
  });

  it("redacts the day secret from errors that echo call arguments", async () => {
    world = makeWorld({ config: { stallAfterAttempts: 1 } });
    await world.runUntil(() => world.store.headTask()?.state === "FINALIZING");
    const secret = world.store.headTask()!.secret!;
    world.chain.fail("finalizeTask", "before", 1, `tx failed: {"day_secret":"${secret}"}`);
    await world.scheduler.tick();
    const h = world.scheduler.health();
    expect(JSON.stringify(h)).not.toContain(secret);
    expect(h.head?.last_error).toContain("[secret]");
    expect(JSON.stringify(world.store.listFeed(0, 100))).not.toContain(secret);
  });
});

describe("difficulty (B-10)", () => {
  it("auto mode: >90% passed → next task one level harder; <50% → easier", async () => {
    world = makeWorld({ config: { picker: { levelMode: "auto", levelSchedule: [2], autoUp: 0.9, autoDown: 0.5, fixedSchedule: [] } } });
    let mode: "pass" | "fail" = "pass";
    attachPlayers(world.chain, () => world.store, ["a", "b"], () => mode);
    await world.runUntil(() => world.finalizedSlots() === 1);
    mode = "fail";
    await world.runUntil(() => world.finalizedSlots() === 3);
    const levels = world.store.listTasks(1, 3).map((r) => r.params!.level);
    expect(levels).toEqual([2, 3, 2]);
  });

  it("a fixed demo schedule is followed exactly", async () => {
    world = makeWorld({
      config: {
        picker: {
          levelMode: "schedule",
          levelSchedule: [1],
          autoUp: 0.9,
          autoDown: 0.5,
          fixedSchedule: [
            { family: "decode-memo", cipher: "atbash", level: 1 },
            { family: "decode-memo", cipher: "a1z26", level: 2 },
          ],
        },
      },
    });
    await world.runUntil(() => world.finalizedSlots() === 3);
    expect(world.store.listTasks(1, 3).map((r) => r.params!.cipher)).toEqual(["atbash", "a1z26", "atbash"]);
  });
});
