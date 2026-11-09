// Shared test scaffolding: a manual clock, temp stores, a scheduler on the fake chain, and a
// crowd of players whose behaviour per task is scripted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskView } from "@reorg/core";
import { DEFAULT_PICKER } from "../src/picker";
import { Scheduler, type Clock, type SchedulerConfig } from "../src/scheduler";
import { SqliteStore, type Store } from "../src/store";
import type { FlavorWriter } from "../src/flavor";
import { FakeChain } from "./fake-chain";

export const START_MS = Date.UTC(2026, 10, 9, 12, 0, 0);

export class ManualClock implements Clock {
  constructor(public ms = START_MS) {}
  now = () => this.ms;
  sleep = async (ms: number) => {
    this.ms += ms;
  };
  advance(ms: number) {
    this.ms += ms;
  }
}

export function testSchedulerConfig(over: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    epochMs: 60_000,
    windowFraction: 0.5,
    warmupTasks: 0,
    warmupWindowMs: 10_000,
    finalityMarginMs: 2000,
    lookahead: 3,
    openSlackMs: 1000,
    retryBaseMs: 1000,
    retryMaxMs: 8000,
    stallAfterAttempts: 3,
    maxWaitMs: 5000,
    picker: DEFAULT_PICKER,
    ...over,
  };
}

export function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reorg-boss-"));
  return { path: join(dir, "boss.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Behaviour = "pass" | "fail" | "skip";
export type Script = (account: string, taskId: number) => Behaviour;

/** Players act when a task opens, reading the day secret the way a real player can't: from the boss DB. */
export function attachPlayers(chain: FakeChain, store: () => Store, accounts: string[], script: Script): void {
  chain.onOpen = (task: TaskView) => {
    const row = store().listTasks().find((r) => r.commit === task.commit_hash);
    if (!row?.secret) throw new Error("secret was not persisted before open_task");
    for (const a of accounts) {
      const b = script(a, task.id);
      if (b === "skip") continue;
      const answer = b === "pass" ? FakeChain.codeFor(row.secret, a) : "WRONGANS";
      const err = chain.submit(a, task.id, answer);
      if (err) throw new Error(`${a}: ${err}`);
    }
  };
}

export interface World {
  clock: ManualClock;
  chain: FakeChain;
  store: SqliteStore;
  scheduler: Scheduler;
  db: { path: string; cleanup: () => void };
  /** Ticks (advancing the clock by each returned wait) until `done()` or the tick budget runs out. */
  runUntil(done: () => boolean, maxTicks?: number): Promise<void>;
  finalizedSlots(): number;
  close(): void;
}

export interface WorldOptions {
  config?: Partial<SchedulerConfig>;
  chain?: ConstructorParameters<typeof FakeChain>[1];
  flavor?: FlavorWriter;
}

export function makeWorld(opts: WorldOptions = {}): World {
  const clock = new ManualClock();
  const chain = new FakeChain(clock.now, opts.chain);
  const db = tempDb();
  const store = new SqliteStore(db.path, clock.now);
  const scheduler = new Scheduler({
    store,
    chain,
    clock,
    config: testSchedulerConfig(opts.config),
    ...(opts.flavor ? { flavor: opts.flavor } : {}),
  });
  const world: World = {
    clock,
    chain,
    store,
    scheduler,
    db,
    async runUntil(done, maxTicks = 5000) {
      for (let i = 0; i < maxTicks; i++) {
        if (done()) return;
        clock.advance(await world.scheduler.tick());
      }
      throw new Error("runUntil: tick budget exhausted");
    },
    finalizedSlots: () => store.listTasks().filter((r) => r.state === "FINALIZED").length,
    close() {
      store.close();
      db.cleanup();
    },
  };
  return world;
}
