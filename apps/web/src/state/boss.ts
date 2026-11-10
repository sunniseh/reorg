/**
 * Client for the boss service's read-only HTTP API (apps/boss/README.md): the current task's
 * flavor text, the player's puzzle, the announcement feed (SSE with a polling fallback) and
 * /healthz (STALLED, the boss clock). The boss never sees an answer.
 */
import type { TaskId, TowerWire } from "@reorg/core";
import type { BossTask, FeedItem, FeedKind, Puzzle } from "./types";

export interface BossFeedEntry {
  id: number;
  at: number;
  kind: string;
  task_id: TaskId | null;
  text: string;
  source: "ai" | "template" | "system";
}

export interface BossHealth {
  status: "RUNNING" | "STALLED";
  now_ms?: number;
  faucet?: boolean;
}

const KIND: Record<string, FeedKind> = {
  task_opened: "task",
  results: "results",
  payday: "payroll",
  streak: "streak",
  reserve_low: "system",
  layoff_warning: "warning",
  layoff: "layoff",
  rehire: "rehire",
  stalled: "system",
  recovered: "system",
};

export function feedItemOf(e: BossFeedEntry): FeedItem {
  return {
    id: `boss${e.id}`,
    at: e.at,
    kind: KIND[e.kind] ?? "system",
    text: e.text,
    source: e.source,
    ...(e.task_id !== null ? { taskId: e.task_id } : {}),
  };
}

export class BossClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<{ status: number; body: T | null }> {
    const res = await this.doFetch(this.base + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, body };
  }

  async currentTask(): Promise<BossTask | null> {
    const r = await this.get<BossTask>("/api/task/current");
    return r.status === 200 ? r.body : null;
  }

  /** The wallet's puzzle while a task is open; null when none is open or the window closed. */
  async puzzle(wallet: string): Promise<Puzzle | null> {
    const r = await this.get<Puzzle & { error?: string }>(`/api/puzzle?wallet=${encodeURIComponent(wallet)}`);
    if (r.status === 404 || r.status === 409) return null;
    if (r.status !== 200 || !r.body) throw new Error(r.body?.error ?? `boss returned ${r.status}`);
    return r.body;
  }

  /** The big-company tower as `you` sees it; null when the route is off or not read yet. */
  async tower(you: string | null): Promise<{ at: number; task_id: number; tower: TowerWire } | null> {
    const r = await this.get<{ at: number; task_id: number; tower: TowerWire }>(`/api/tower${you ? `?you=${encodeURIComponent(you)}` : ""}`);
    return r.status === 200 ? r.body : null;
  }

  async feed(since = 0, limit = 50): Promise<BossFeedEntry[]> {
    const r = await this.get<{ entries: BossFeedEntry[] }>(`/api/feed?since=${since}&limit=${limit}`);
    return r.body?.entries ?? [];
  }

  async health(): Promise<BossHealth | null> {
    try {
      const r = await this.get<BossHealth>("/healthz");
      return r.body;
    } catch {
      return null;
    }
  }

  /** Server-sent feed entries after `since`; the browser reconnects with Last-Event-ID. */
  stream(since: number, onEntry: (e: BossFeedEntry) => void): () => void {
    if (typeof EventSource === "undefined") return () => undefined;
    const es = new EventSource(`${this.base}/api/feed/stream?since=${since}`);
    es.addEventListener("feed", (ev) => {
      try {
        onEntry(JSON.parse((ev as MessageEvent<string>).data) as BossFeedEntry);
      } catch {
        /* ignore a malformed entry */
      }
    });
    return () => es.close();
  }
}
