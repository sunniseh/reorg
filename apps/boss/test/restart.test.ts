// B-16: kill the boss at every persisted transition and around every chain call, restart it on
// the same database, and check that it finishes the job: no double open, the secret is never
// lost (sha256(secret) == the on-chain commit), every honest passer is verified exactly once,
// and every announcement is posted exactly once.
import { describe, expect, it } from "vitest";
import { commitHash, fromBase64, toBase64, type FinalizeTaskArgs, type OpenTaskArgs, type TaskId } from "@reorg/core";
import { Scheduler } from "../src/scheduler";
import { SqliteStore, type Store, type StoreChange } from "../src/store";
import { FakeChain } from "./fake-chain";
import { attachPlayers, ManualClock, tempDb, testSchedulerConfig } from "./helpers";

class Killed extends Error {}

/** Shared "the process is dead" flag; `reason` keeps the first kill (later calls only see "dead"). */
interface Dead {
  v: boolean;
  reason: string | null;
}

function kill(dead: Dead, reason: string): never {
  dead.v = true;
  dead.reason ??= reason;
  throw new Killed(reason);
}

/** A store that dies (every call throws) right after its n-th task write for `slot`. */
function mortalStore(inner: SqliteStore, slot: number, killAfter: number | null, dead: Dead): Store {
  let n = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (dead.v) throw new Killed("process is dead");
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        const task = prop === "commit" ? (args[0] as StoreChange).task : prop === "insertTask" ? (args[0] as StoreChange["task"]) : undefined;
        if (task?.slot === slot && ++n === killAfter) kill(dead, `killed after commit #${n} (${task.state})`);
        return out;
      };
    },
  });
}

type ChainPoint = { method: "openTask" | "finalizeTask"; call: number; when: "before" | "after" };

/** Chain wrapper that kills the process before a call is sent, or after it landed (response lost). */
class MortalChain extends FakeChain {
  point: ChainPoint | null = null;
  slotTaskId = 0;
  dead: Dead = { v: false, reason: null };
  private calls = { openTask: 0, finalizeTask: 0 };

  private async around<T>(method: "openTask" | "finalizeTask", taskId: number, run: () => Promise<T>): Promise<T> {
    const p = this.point;
    const hit = p !== null && p.method === method && taskId === this.slotTaskId && ++this.calls[method] === p.call;
    if (hit && p.when === "before") kill(this.dead, `killed before ${method} #${p.call}`);
    const out = await run();
    if (hit && p.when === "after") kill(this.dead, `killed after ${method} #${p.call} landed`);
    return out;
  }

  override openTask(args: OpenTaskArgs): Promise<TaskId> {
    return this.around("openTask", this.current + 1, () => super.openTask(args));
  }

  override finalizeTask(args: FinalizeTaskArgs): Promise<void> {
    return this.around("finalizeTask", args.task_id, () => super.finalizeTask(args));
  }
}

const SLOTS = 3;
const TARGET = 2; // kill while working on the middle task
const PLAYERS = ["a1", "a2", "a3", "bad", "late"];

async function scenario(kill: { commit?: number; chain?: ChainPoint }) {
  const clock = new ManualClock();
  const chain = new MortalChain(clock.now, { max_passers_per_call: 2 });
  chain.slotTaskId = TARGET;
  if (kill.chain) chain.point = kill.chain;
  const db = tempDb();
  const config = testSchedulerConfig();
  let inner = new SqliteStore(db.path, clock.now);
  let store: Store = mortalStore(inner, TARGET, kill.commit ?? null, chain.dead);
  attachPlayers(chain, () => inner, PLAYERS, (a) => (a === "bad" ? "fail" : a === "late" ? "skip" : "pass"));

  let scheduler = new Scheduler({ store, chain, clock, config });
  let killedAt: string | null = null;
  const done = () => inner.listTasks().filter((r) => r.state === "FINALIZED").length >= SLOTS;
  try {
    for (let i = 0; i < 5000 && !done(); i++) {
      try {
        clock.advance(await scheduler.tick());
      } catch (e) {
        if (!(e instanceof Killed) || killedAt !== null) throw e;
        // The process died. Restart: a new connection on the same file and a new scheduler.
        killedAt = chain.dead.reason ?? e.message;
        chain.dead.v = false;
        chain.point = null;
        inner.close();
        inner = new SqliteStore(db.path, clock.now);
        store = inner;
        scheduler = new Scheduler({ store, chain, clock, config });
        clock.advance(1000);
      }
    }
    return { chain, rows: inner.listTasks(1, SLOTS), feed: inner.listFeed(0, 1000), killedAt, health: scheduler.health() };
  } finally {
    inner.close();
    db.cleanup();
  }
}

function assertConsistent(r: Awaited<ReturnType<typeof scenario>>) {
  expect(r.health.status).toBe("RUNNING");
  // No double open: exactly SLOTS chain tasks, each opened once, one per slot.
  expect(r.chain.current).toBe(SLOTS);
  expect(r.chain.applied.filter((c) => c.method === "openTask")).toHaveLength(SLOTS);
  expect(r.rows).toHaveLength(SLOTS);
  for (const row of r.rows) {
    expect(row.state).toBe("FINALIZED");
    const task = r.chain.tasks.get(row.chain_task_id!)!;
    // Secret never lost: what the boss holds still opens the on-chain commitment.
    expect(toBase64(commitHash(fromBase64(row.secret!)))).toBe(task.commit);
    expect(task.secret).toBe(row.secret);
    expect(task.status).toBe("finalized");
    expect(task.submitted).toBe(4);
    expect(task.passed).toBe(3);
    const passed = r.chain.subs.get(task.id)!.filter((s) => s.passed).map((s) => s.account).sort();
    expect(passed).toEqual(["a1", "a2", "a3"]);
  }
  // Each announcement exactly once.
  for (const kind of ["task_opened", "results", "payday"]) {
    expect(r.feed.filter((f) => f.kind === kind).map((f) => f.task_id)).toEqual([1, 2, 3]);
  }
}

const COMMITS = Array.from({ length: 10 }, (_, i) => i + 1);

describe("kill and restart (B-16)", () => {
  it("baseline: no kill", async () => {
    const r = await scenario({});
    expect(r.killedAt).toBeNull();
    assertConsistent(r);
  });

  // Every persisted write of the middle slot: insert (PICKED), GENERATED, CHECKED, OPENING,
  // chain id reserved, closes_at recorded, OPEN, CLOSED, FINALIZING, FINALIZED.
  it.each(COMMITS)("killed right after write #%i of the middle task", async (n) => {
    const r = await scenario({ commit: n });
    expect(r.killedAt).toMatch(new RegExp(`commit #${n} `));
    assertConsistent(r);
  });

  it("those kill points cover every state", async () => {
    const states = new Set<string>();
    for (const n of COMMITS) states.add(/\((\w+)\)/.exec((await scenario({ commit: n })).killedAt!)![1]!);
    expect([...states].sort()).toEqual(["CHECKED", "CLOSED", "FINALIZED", "FINALIZING", "GENERATED", "OPEN", "OPENING", "PICKED"]);
  });

  const chainPoints: ChainPoint[] = [
    { method: "openTask", call: 1, when: "before" },
    { method: "openTask", call: 1, when: "after" },
    // Middle task: freeze, then passers in batches of 2 and 1 (last).
    { method: "finalizeTask", call: 1, when: "before" },
    { method: "finalizeTask", call: 1, when: "after" },
    { method: "finalizeTask", call: 2, when: "before" },
    { method: "finalizeTask", call: 2, when: "after" },
    { method: "finalizeTask", call: 3, when: "before" },
    { method: "finalizeTask", call: 3, when: "after" },
  ];
  it.each(chainPoints)("killed $when $method #$call", async (point) => {
    const r = await scenario({ chain: point });
    expect(r.killedAt).toMatch(new RegExp(`${point.when} ${point.method} #${point.call}`));
    assertConsistent(r);
  });

  it("a lost open_task response (no kill) reconciles instead of opening twice", async () => {
    const clock = new ManualClock();
    const chain = new FakeChain(clock.now);
    const db = tempDb();
    const store = new SqliteStore(db.path, clock.now);
    const scheduler = new Scheduler({ store, chain, clock, config: testSchedulerConfig() });
    chain.fail("openTask", "after", 1, "timeout waiting for the transaction");
    try {
      for (let i = 0; i < 2000 && store.listTasks().filter((r) => r.state === "FINALIZED").length < 2; i++) {
        clock.advance(await scheduler.tick());
      }
      expect(chain.current).toBe(2);
      expect(chain.applied.filter((c) => c.method === "openTask")).toHaveLength(2);
    } finally {
      store.close();
      db.cleanup();
    }
  });
});
