// NearChainAdapter against the real contracts on a local near-sandbox. Slow (~1 min), so it
// runs only with REORG_SANDBOX=1 (`npm run boss:sandbox` from the root sets it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerHashBase64, commitHash, deriveCode, toBase64 } from "@reorg/core";
import { NearChainAdapter } from "../src";
import { ONE_TOKEN, startSandbox, type SandboxEnv } from "../src/sandbox";

const RUN = process.env["REORG_SANDBOX"] === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("NearChainAdapter on near-sandbox", () => {
  let env: SandboxEnv;
  let chain: NearChainAdapter;

  beforeAll(async () => {
    env = await startSandbox({ config: { min_window_ns: "1000000000", operating_cost: "0" } });
    chain = new NearChainAdapter({ rpcUrl: env.rpcUrl, contractId: env.contractId, bossId: env.bossId, bossKey: env.key });
  }, 240_000);
  afterAll(async () => {
    await env?.tearDown();
  });

  it("opens, accepts a submission, finalizes in two calls, and reports events", async () => {
    const alice = await env.createPlayer("alice", 1_000_000n * ONE_TOKEN); // 0.1% of supply: Intern
    const bob = await env.createPlayer("bob", 1_000_000n * ONE_TOKEN);
    await env.depositIncome(10n ** 24n);

    const info = await chain.getInfo();
    expect(info.boss).toBe(env.bossId);
    expect(info.current_task_id).toBe(0);
    expect((await chain.getConfig()).min_window_ns).toBe("1000000000");

    const secret = crypto.getRandomValues(new Uint8Array(32));
    const now = await chain.now();
    const closesAt = now + 8_000_000_000n;
    const id = await chain.openTask({ kind: "decode_memo", commit_hash: toBase64(commitHash(secret)), closes_at: closesAt.toString() });
    expect(id).toBe(1);
    const task = await chain.getTask(1);
    expect(task?.status).toBe("open");
    expect(task?.closes_at).toBe(closesAt.toString());
    expect(await chain.getTask(2)).toBeNull();

    expect(await env.submit(alice, 1, answerHashBase64(deriveCode(secret, alice), alice))).toEqual({ accepted: true, reason: null });
    expect((await env.submit(bob, 1, answerHashBase64("WRONGANS", bob))).accepted).toBe(true);

    const subs = await chain.listSubmissions(1, 0, 100);
    expect(subs.map((s) => s.account_id).sort()).toEqual([alice, bob].sort());

    // Closing before closes_at is refused by the contract and surfaces as a thrown error.
    await expect(chain.finalizeTask({ task_id: 1, day_secret: toBase64(secret), passers: [], last: false })).rejects.toThrow(
      /not closed yet/,
    );
    while ((await chain.now()) < closesAt) await sleep(500);

    await chain.finalizeTask({ task_id: 1, day_secret: toBase64(secret), passers: [], last: false });
    expect((await chain.getTask(1))?.status).toBe("finalizing");
    await chain.finalizeTask({ task_id: 1, day_secret: toBase64(secret), passers: [alice], last: true });
    const done = await chain.getTask(1);
    expect(done?.status).toBe("finalized");
    expect(done?.passed).toBe(1);

    const emps = await chain.listEmployees(0, 100);
    expect(emps.map((e) => e.account_id).sort()).toEqual([alice, bob].sort());
    const events = await chain.getEvents(0, 100);
    expect(events.map((e) => e.event)).toContain("task_finalized");
    expect(events.map((e) => e.event)).toContain("payroll_allocated");
    expect(BigInt((await chain.getTreasury()).outstanding)).toBeGreaterThan(0n);
  }, 120_000);
});
