// B-12 / B-13: the HTTP API. Every route is scanned in every scheduler state for the day secret
// (base64 and hex) and for any wallet's expected answer: none may appear before FINALIZED.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { answerHashBase64, commitHash, deriveCode, fromBase64, solvePuzzle, toBase64, toHex } from "@reorg/core";
import { createApi, validWallet } from "../src/api";
import type { TaskState } from "../src/store";
import { makeWorld, type World } from "./helpers";

let world: World;
let server: Server | undefined;
let base: string;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  world?.close();
});

async function boot(origins: string[] = ["http://localhost:5173"]) {
  world = makeWorld();
  server = createApi({ store: world.store, health: () => world.scheduler.health(), origins, now: world.clock.now, network: "sandbox" });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const json = async (path: string) => JSON.parse((await get(path)).text);

const WALLETS = ["alice.testnet", "bob.testnet", "0xabc", "c001.reorg.testnet"];
const routes = (taskId: number) => [
  "/api/task/current",
  ...WALLETS.map((w) => `/api/puzzle?wallet=${encodeURIComponent(w)}`),
  "/api/feed",
  "/api/feed?since=0&limit=200",
  "/healthz",
  `/api/reveal/${taskId}`,
  `/api/reveal/${taskId}?wallet=alice.testnet`,
  "/api/reveal/999",
];

/** No route may show a non-finalized secret (any slot) or the code it implies for any wallet. */
async function assertNothingLeaks(state: TaskState) {
  const row = world.store.listTasks().find((r) => r.state === state)!;
  expect(row, `a row in ${state}`).toBeTruthy();
  const forbidden: string[] = [];
  for (const r of world.store.listTasks()) {
    if (r.state === "FINALIZED") continue;
    const s = fromBase64(r.secret!);
    forbidden.push(r.secret!, toHex(s), ...WALLETS.map((w) => deriveCode(s, w)));
  }
  for (const path of routes(row.chain_task_id ?? 1)) {
    const body = (await get(path)).text;
    for (const f of forbidden) expect(body.includes(f), `${state} ${path} leaks ${f.slice(0, 12)}…`).toBe(false);
    if (!path.startsWith("/api/reveal/")) expect(body).not.toMatch(/expected_?answer/i);
  }
}

describe("no secret or expected answer before finalize (B-13)", () => {
  it("holds in OPEN, CLOSED and FINALIZING; reveal works once FINALIZED", async () => {
    await boot();
    for (const state of ["OPEN", "CLOSED", "FINALIZING"] as TaskState[]) {
      await world.runUntil(() => world.store.listTasks().some((r) => r.state === state));
      await assertNothingLeaks(state);
    }
    await world.runUntil(() => world.finalizedSlots() === 1);
    const row = world.store.findByChainId(1)!;
    const reveal = await json("/api/reveal/1?wallet=alice.testnet");
    expect(reveal.day_secret).toBe(row.secret);
    expect(toBase64(commitHash(fromBase64(reveal.day_secret)))).toBe(reveal.commit_hash);
    expect(reveal.puzzle.expected_answer).toBe(deriveCode(fromBase64(row.secret!), "alice.testnet"));
    // The next tasks' secrets are still private.
    await assertNothingLeaks("CHECKED");
  });

  it("reveal answers 409 while the task is not finalized, 404 for unknown ids", async () => {
    await boot();
    await world.runUntil(() => world.store.headTask()?.state === "OPEN");
    expect((await get("/api/reveal/1")).status).toBe(409);
    expect((await get("/api/reveal/2")).status).toBe(404);
    expect((await get("/api/reveal/abc")).status).toBe(404);
  });
});

describe("task and puzzle routes (B-12)", () => {
  it("404 before the first task opens", async () => {
    await boot();
    await world.scheduler.tick();
    expect((await get("/api/task/current")).status).toBe(404);
    expect((await get("/api/puzzle?wallet=alice.testnet")).status).toBe(404);
  });

  it("serves the current task and a per-wallet puzzle that the real solver can solve", async () => {
    await boot();
    await world.runUntil(() => world.store.headTask()?.state === "OPEN");
    const task = await json("/api/task/current");
    expect(task).toMatchObject({ task_id: 1, kind: "decode_memo", status: "open", written_by: "template" });
    expect(task.task_text).toMatch(/^Memo #1/);
    const p = await json("/api/puzzle?wallet=alice.testnet");
    expect(p.task_id).toBe(1);
    expect(p.wallet).toBe("alice.testnet");
    // A player solving from display + hint gets exactly one code, and it submits as a pass.
    const answers = solvePuzzle("decode-memo", p.display, p.hint);
    expect(answers).toHaveLength(1);
    expect(world.chain.submit("alice.testnet", 1, answers[0]!)).toBeNull();
    const other = await json("/api/puzzle?wallet=bob.testnet");
    expect(other.display).not.toBe(p.display);
    await world.runUntil(() => world.finalizedSlots() === 1);
    expect(world.chain.subs.get(1)![0]!.hash).toBe(answerHashBase64(answers[0]!, "alice.testnet"));
    expect(world.chain.tasks.get(1)!.passed).toBe(1);
    expect((await json("/api/task/current")).status).toBe("finalized");
  });

  it("refuses puzzles after closes_at and bad wallet strings", async () => {
    await boot();
    await world.runUntil(() => world.store.headTask()?.state === "OPEN");
    expect((await get("/api/puzzle")).status).toBe(400);
    expect((await get("/api/puzzle?wallet=")).status).toBe(400);
    expect((await get(`/api/puzzle?wallet=${"x".repeat(129)}`)).status).toBe(400);
    expect((await get("/api/puzzle?wallet=a%0Ab")).status).toBe(400);
    world.clock.advance(31_000);
    expect((await get("/api/puzzle?wallet=alice.testnet")).status).toBe(409);
    expect((await json("/api/task/current")).status).toBe("closed");
    expect(validWallet("ünï.çødé")).toBe(true);
  });

  it("is read-only", async () => {
    await boot();
    const res = await fetch(base + "/api/task/current", { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
  });
});

describe("feed and SSE (B-12)", () => {
  it("pages the feed by id", async () => {
    await boot();
    await world.runUntil(() => world.finalizedSlots() === 2);
    const all = await json("/api/feed?limit=200");
    expect(all.entries.map((e: { kind: string }) => e.kind)).toEqual(["task_opened", "results", "task_opened", "results"]);
    const page = await json(`/api/feed?since=${all.entries[1].id}&limit=1`);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].id).toBe(all.entries[2].id);
    expect(page.last_id).toBe(all.entries[2].id);
  });

  it("streams the backlog after Last-Event-ID, then live entries", async () => {
    await boot();
    await world.runUntil(() => world.finalizedSlots() === 1);
    const ctrl = new AbortController();
    const res = await fetch(base + "/api/feed/stream", { headers: { "last-event-id": "1" }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const until = async (re: RegExp) => {
      while (!re.test(buf)) buf += decoder.decode((await reader.read()).value, { stream: true });
    };
    await until(/id: 2\n/);
    expect(buf).not.toMatch(/id: 1\n/);
    await world.runUntil(() => world.store.headTask()?.slot === 2 && world.store.headTask()?.state === "OPEN");
    await until(/id: 3\nevent: feed\ndata: \{.*"task_opened"/);
    ctrl.abort();
  });
});

describe("CORS and health (B-12)", () => {
  it("allows only the configured web origin", async () => {
    await boot(["http://localhost:5173"]);
    const ok = await get("/api/feed", { origin: "http://localhost:5173" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const bad = await get("/api/feed", { origin: "https://evil.example" });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(base + "/api/puzzle", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("healthz is 200 while running and 503 when STALLED", async () => {
    await boot();
    await world.scheduler.tick();
    const h = await get("/healthz");
    expect(h.status).toBe(200);
    expect(JSON.parse(h.text)).toMatchObject({ ok: true, status: "RUNNING", network: "sandbox" });
    world.chain.current = 1; // a task this boss doesn't own: stalls at once
    await world.runUntil(() => world.scheduler.health().status === "STALLED", 20);
    const s = await get("/healthz");
    expect(s.status).toBe(503);
    expect(JSON.parse(s.text).stalled.reason).toMatch(/not this boss's/);
    const feed = await json("/api/feed");
    expect(feed.entries.at(-1).kind).toBe("stalled");
  });
});

describe("demo faucet (D-09)", () => {
  async function bootFaucet(perIpPerHour: number, maxAccounts?: number) {
    world = makeWorld();
    const funded: string[] = [];
    server = createApi({
      store: world.store,
      health: () => world.scheduler.health(),
      origins: ["http://localhost:5173"],
      now: world.clock.now,
      faucet: {
        perIpPerHour,
        ...(maxAccounts !== undefined ? { maxAccounts } : {}),
        faucet: {
          async fund(pk) {
            funded.push(pk);
            return { account_id: `p${funded.length}.faucet.test`, tokens: "600", native: "2" };
          },
        },
      },
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return funded;
  }
  const post = (body: string) => fetch(`${base}/api/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("funds a burner, rejects bad input and rate-limits per address (bad requests use quota too)", async () => {
    const funded = await bootFaucet(4);
    const ok = await post(JSON.stringify({ public_key: "ed25519:abc" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ account_id: "p1.faucet.test", tokens: "600", native: "2" });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ public_key: 5 }))).status).toBe(400);
    expect((await post(JSON.stringify({ public_key: "ed25519:def" }))).status).toBe(200);
    expect((await post(JSON.stringify({ public_key: "ed25519:ghi" }))).status).toBe(429);
    world.clock.advance(3_600_001);
    expect((await post(JSON.stringify({ public_key: "ed25519:jkl" }))).status).toBe(200);
    expect(funded).toHaveLength(3);
    expect((await json("/healthz")).faucet).toBe(true);
  });

  it("stops at the lifetime pool cap, counting requests still in flight", async () => {
    const funded = await bootFaucet(10, 3);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => post(JSON.stringify({ public_key: `ed25519:p${i}` }))));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
    expect(funded).toHaveLength(3);
    world.clock.advance(3_600_001);
    expect((await post(JSON.stringify({ public_key: "ed25519:later" }))).status).toBe(429);
  });

  it("takes the quota before any await, so parallel requests cannot beat it", async () => {
    const funded = await bootFaucet(2);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => post(JSON.stringify({ public_key: `ed25519:k${i}` }))));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 429, 429, 429, 429]);
    expect(funded).toHaveLength(2);
  });

  it("is off unless configured", async () => {
    await boot();
    expect((await post(JSON.stringify({ public_key: "ed25519:abc" }))).status).toBe(404);
  });
});
