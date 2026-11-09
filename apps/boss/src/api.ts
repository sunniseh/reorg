// B-12: the boss HTTP API (node:http, read-only). Everything is served from the boss's own
// store, so client traffic never turns into RPC load. B-13: neither the day secret nor any
// expected answer leaves this process before the task is FINALIZED; /api/reveal is the only
// route that returns them, and only afterwards.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CIPHERS, generatePuzzle, fromBase64, type PuzzleParams } from "@reorg/core";
import type { Health } from "./scheduler";
import type { FeedEntry, Store, TaskRow } from "./store";

export interface ApiOptions {
  store: Store;
  health: () => Health;
  /** Allowed CORS origins (WEB_ORIGIN, comma-separated). Empty: no cross-origin access. */
  origins: string[];
  now?: () => number;
  network?: string;
}

const LIVE_STATES = new Set(["OPEN", "CLOSED", "FINALIZING", "FINALIZED"]);
const FEED_PAGE_MAX = 200;
const SSE_HEARTBEAT_MS = 15_000;
const NS_PER_MS = 1_000_000n;

/** Wallet ids are opaque strings (PROTOCOL.md §1); only bound their size and reject control characters. */
export function validWallet(w: string | null): w is string {
  return w !== null && w.length >= 1 && w.length <= 128 && !/[\u0000-\u001f\u007f]/.test(w);
}

function publicTask(row: TaskRow, nowMs: number) {
  const closesMs = row.closes_at ? Number(BigInt(row.closes_at) / NS_PER_MS) : null;
  const status =
    row.state === "FINALIZED"
      ? "finalized"
      : row.state === "FINALIZING"
        ? "finalizing"
        : row.state === "OPEN" && closesMs !== null && nowMs < closesMs
          ? "open"
          : "closed";
  const params = row.params as PuzzleParams;
  return {
    task_id: row.chain_task_id,
    kind: "decode_memo",
    status,
    family: params.family,
    cipher: params.cipher,
    cipher_label: CIPHERS[params.cipher].label,
    level: params.level,
    warmup: row.warmup,
    commit_hash: row.commit,
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    task_text: row.task_text,
    written_by: row.flavor_source,
    submitted: row.submitted,
    passed: row.passed,
  };
}

export function createApi(opts: ApiOptions): Server {
  const now = opts.now ?? Date.now;
  const { store } = opts;

  /** Newest slot that has been opened on chain. */
  const currentRow = (): TaskRow | null => {
    const head = store.headTask();
    if (head && LIVE_STATES.has(head.state)) return head;
    const prev = head ? store.getTask(head.slot - 1) : store.lastTask();
    return prev && LIVE_STATES.has(prev.state) ? prev : null;
  };

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && opts.origins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET, OPTIONS");
      res.setHeader("access-control-allow-headers", "last-event-id, content-type");
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { error });

  /** After finalize only: the secret (anyone can check sha256(secret) == commit) and, per wallet, the puzzle and answer. */
  const reveal = (taskId: number, url: URL, res: ServerResponse) => {
    const row = store.findByChainId(taskId);
    if (!row || !LIVE_STATES.has(row.state)) return fail(res, 404, "unknown task");
    if (row.state !== "FINALIZED") return fail(res, 409, "the secret is revealed after the task is finalized");
    const body: Record<string, unknown> = { ...publicTask(row, now()), day_secret: row.secret };
    const wallet = url.searchParams.get("wallet");
    if (wallet !== null) {
      if (!validWallet(wallet)) return fail(res, 400, "wallet must be 1-128 printable characters");
      const p = generatePuzzle(row.params!, fromBase64(row.secret!), wallet);
      body["puzzle"] = { wallet, display: p.display, hint: p.hint, expected_answer: p.expectedAnswer };
    }
    send(res, 200, body);
  };

  const routes: Record<string, (url: URL, req: IncomingMessage, res: ServerResponse) => void> = {
    "/api/task/current": (_url, _req, res) => {
      const row = currentRow();
      if (!row) return fail(res, 404, "no task has opened yet");
      send(res, 200, publicTask(row, now()));
    },

    "/api/puzzle": (url, _req, res) => {
      const wallet = url.searchParams.get("wallet");
      if (!validWallet(wallet)) return fail(res, 400, "wallet must be 1-128 printable characters");
      const row = store.headTask();
      if (!row || row.state !== "OPEN") return fail(res, 404, "no task is open");
      if (now() >= Number(BigInt(row.closes_at!) / NS_PER_MS)) return fail(res, 409, "the submission window is closed");
      const p = generatePuzzle(row.params!, fromBase64(row.secret!), wallet);
      send(res, 200, {
        task_id: row.chain_task_id,
        wallet,
        display: p.display,
        hint: p.hint,
        answer_format: "8 letters in consonant-vowel pairs, e.g. BADOKIGU",
        cipher_label: CIPHERS[row.params!.cipher].label,
        task_text: row.task_text,
        closes_at: row.closes_at,
      });
    },

    "/api/feed": (url, _req, res) => {
      const since = Math.max(0, Number(url.searchParams.get("since") ?? "0") || 0);
      const limit = Math.min(FEED_PAGE_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
      const entries = store.listFeed(since, limit);
      send(res, 200, { entries, last_id: entries.at(-1)?.id ?? since });
    },

    "/api/feed/stream": (url, req, res) => {
      const header = req.headers["last-event-id"];
      const from = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("since") ?? "0";
      let last = Math.max(0, Number(from) || 0);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const write = (e: FeedEntry) => {
        if (e.id <= last) return;
        last = e.id;
        res.write(`id: ${e.id}\nevent: feed\ndata: ${JSON.stringify(e)}\n\n`);
      };
      for (let page = store.listFeed(last, FEED_PAGE_MAX); page.length > 0; page = store.listFeed(last, FEED_PAGE_MAX)) {
        page.forEach(write);
      }
      store.events.on("feed", write);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), SSE_HEARTBEAT_MS);
      req.on("close", () => {
        clearInterval(beat);
        store.events.off("feed", write);
      });
    },

    "/healthz": (_url, _req, res) => {
      const h = opts.health();
      send(res, h.ok ? 200 : 503, { ...h, network: opts.network ?? null });
    },
  };

  return createServer((req, res) => {
    try {
      cors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== "GET") return fail(res, 405, "method not allowed");
      const url = new URL(req.url ?? "/", "http://boss.local");
      const route = routes[url.pathname];
      if (route) return route(url, req, res);
      const m = /^\/api\/reveal\/(\d{1,15})$/.exec(url.pathname);
      if (m) return reveal(Number(m[1]), url, res);
      fail(res, 404, "not found");
    } catch {
      if (!res.headersSent) fail(res, 500, "internal error");
      else res.end();
    }
  });
}
