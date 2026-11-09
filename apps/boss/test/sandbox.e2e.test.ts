// The boss end to end on near-sandbox with the real token and contract: scheduler + API +
// NearChainAdapter. Bots fetch their puzzle over HTTP, solve it from display + hint with the
// real solver, and submit on chain. Wallet F plays the demo story (pass, miss ×3 → laid off,
// pass as reapplication → rehired). Slow (~2 min): runs only with REORG_SANDBOX=1.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerHashBase64, commitHash, fromBase64, solvePuzzle, toBase64 } from "@reorg/core";
import { NearChainAdapter } from "@reorg/chain-near";
import { ONE_TOKEN, startSandbox, type SandboxEnv } from "@reorg/chain-near/sandbox";
import { createApi } from "../src/api";
import { Scheduler } from "../src/scheduler";
import { SqliteStore } from "../src/store";
import { tempDb, testSchedulerConfig } from "./helpers";

const RUN = process.env["REORG_SANDBOX"] === "1";
const TASKS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("boss on near-sandbox (end to end)", () => {
  let env: SandboxEnv;
  const db = tempDb();
  let store: SqliteStore;
  let scheduler: Scheduler;
  let chain: NearChainAdapter;
  let server: ReturnType<typeof createApi>;
  let base = "";
  const players: Record<string, string> = {};

  beforeAll(async () => {
    env = await startSandbox({ config: { min_window_ns: "1000000000" } });
    // 3.5% = Director, 0.3% = Associate, 0.1% = Intern (of a 1e9 supply).
    players["dir"] = await env.createPlayer("dir", 35_000_000n * ONE_TOKEN);
    players["assoc"] = await env.createPlayer("assoc", 3_000_000n * ONE_TOKEN);
    players["wrong"] = await env.createPlayer("wrong", 1_000_000n * ONE_TOKEN);
    players["f"] = await env.createPlayer("f", 1_000_000n * ONE_TOKEN);
    await env.depositIncome(5n * 10n ** 24n);

    store = new SqliteStore(db.path);
    chain = new NearChainAdapter({ rpcUrl: env.rpcUrl, contractId: env.contractId, bossId: env.bossId, bossKey: env.key });
    scheduler = new Scheduler({
      store,
      chain,
      config: testSchedulerConfig({ warmupTasks: TASKS, warmupWindowMs: 10_000, finalityMarginMs: 2000, maxWaitMs: 1000, lookahead: 2 }),
    });
    server = createApi({ store, health: () => scheduler.health(), origins: [] });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 300_000);

  afterAll(async () => {
    scheduler?.stop();
    server?.closeAllConnections();
    server?.close();
    store?.close();
    db.cleanup();
    await env?.tearDown();
  });

  it(`runs ${TASKS} tasks: bots solve over HTTP, the boss finalizes, F is laid off and rehired`, async () => {
    const running = scheduler.run();
    const script = (who: string, taskId: number): "pass" | "fail" | "skip" =>
      who === "wrong" ? "fail" : who === "f" ? (taskId === 1 || taskId === TASKS ? "pass" : "skip") : "pass";
    const handled = new Set<number>();
    const deadline = Date.now() + 240_000;

    while (Date.now() < deadline) {
      if (store.listTasks().filter((r) => r.state === "FINALIZED").length >= TASKS) break;
      expect(scheduler.health().status, JSON.stringify(scheduler.health().stalled)).toBe("RUNNING");
      const res = await fetch(`${base}/api/task/current`);
      if (res.status === 200) {
        const task = (await res.json()) as { task_id: number; status: string };
        if (task.status === "open" && !handled.has(task.task_id)) {
          handled.add(task.task_id);
          await Promise.all(
            Object.entries(players).map(async ([who, account]) => {
              const b = script(who, task.task_id);
              if (b === "skip") return;
              const p = (await (await fetch(`${base}/api/puzzle?wallet=${encodeURIComponent(account)}`)).json()) as {
                display: string;
                hint: string;
                task_id: number;
              };
              const answers = solvePuzzle("decode-memo", p.display, p.hint);
              expect(answers).toHaveLength(1);
              const answer = b === "pass" ? answers[0]! : "WRONGANS";
              const out = await env.submit(account, p.task_id, answerHashBase64(answer, account));
              expect(out, `${who} task ${p.task_id}`).toEqual({ accepted: true, reason: null });
            }),
          );
        }
      }
      await sleep(500);
    }
    scheduler.stop();
    await running;

    const info = await chain.getInfo();
    expect(info.last_finalized).toBe(TASKS);
    for (let id = 1; id <= TASKS; id++) {
      const t = (await chain.getTask(id))!;
      const row = store.findByChainId(id)!;
      expect(t.status).toBe("finalized");
      expect(t.day_secret).toBe(row.secret);
      expect(toBase64(commitHash(fromBase64(row.secret!)))).toBe(t.commit_hash);
      const fPlays = id === 1 || id === TASKS;
      expect(t.submitted, `task ${id} submitted`).toBe(fPlays ? 4 : 3);
      expect(t.passed, `task ${id} passed`).toBe(fPlays ? 3 : 2);
      const reveal = (await (await fetch(`${base}/api/reveal/${id}`)).json()) as { day_secret: string };
      expect(reveal.day_secret).toBe(row.secret);
    }

    const f = (await chain.listSubmissions(TASKS, 0, 100)).find((s) => s.account_id === players["f"]);
    expect(f?.reapply).toBe(true);
    expect(f?.passed).toBe(true);
    // The boss may already have opened task TASKS + 1 before it was stopped.
    const feed = store.listFeed(0, 500).filter((e) => e.task_id === null || e.task_id <= TASKS);
    const kinds = (k: string) => feed.filter((e) => e.kind === k);
    expect(kinds("task_opened")).toHaveLength(TASKS);
    expect(kinds("results")).toHaveLength(TASKS);
    expect(kinds("payday").length).toBeGreaterThanOrEqual(1);
    // A failed submission is a miss (D5): "wrong" (joined at task 1, never passes) is warned after
    // task 2 and laid off after task 3; F (last pass task 1) after tasks 3 and 4.
    expect(kinds("layoff_warning").map((e) => [e.task_id, e.data["account"]])).toEqual([
      [2, players["wrong"]],
      [3, players["f"]],
    ]);
    expect(kinds("layoff").map((e) => [e.task_id, e.data["account"]])).toEqual([
      [3, players["wrong"]],
      [4, players["f"]],
    ]);
    expect(kinds("rehire").map((e) => [e.task_id, e.data["account"]])).toEqual([[5, players["f"]]]);
    expect(kinds("streak").map((e) => e.data["account"]).sort()).toEqual([players["assoc"], players["dir"]].sort());
    expect(kinds("stalled")).toHaveLength(0);
    // Print the feed so a human can read the boss's voice in the test log.
    for (const e of feed) console.log(`[${e.kind}] ${e.text}`);
  }, 300_000);
});
