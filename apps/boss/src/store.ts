// B-08: the boss's durable state (SQLite via node:sqlite, no native build). One row per task
// slot holds the state machine and everything needed to resume it, including the day secret,
// which is written (fsync'd: WAL + synchronous=FULL) before its commit is ever published.
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { EmployeeStatus, PuzzleParams } from "@reorg/core";

export const TASK_STATES = [
  "PICKED", //      params chosen
  "GENERATED", //   day secret drawn and stored
  "CHECKED", //     self-check passed (or the fallback was applied)
  "OPENING", //     flavor written, chain task id reserved, open_task may be in flight
  "OPEN", //        task is open on chain, announced
  "CLOSED", //      closes_at + finality margin has passed
  "FINALIZING", //  reveal in progress (freeze call, passer batches)
  "FINALIZED", //   finalized on chain and results announced
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type FlavorSource = "ai" | "template";

export interface TaskRow {
  slot: number;
  state: TaskState;
  warmup: boolean;
  /** What the picker asked for. */
  requested: PuzzleParams;
  /** What the day uses after the self-check (the fallback if `requested` failed). */
  params: PuzzleParams | null;
  used_fallback: boolean;
  /** False if even the fallback failed the self-check (never opens; /healthz alarms). */
  check_ok: boolean;
  check_failures: string[];
  /** base64, 32 bytes. Set at GENERATED and never cleared. */
  secret: string | null;
  commit: string | null;
  task_text: string | null;
  flavor_source: FlavorSource | null;
  chain_task_id: number | null;
  /** ns decimal strings (chain time). */
  opens_at: string | null;
  closes_at: string | null;
  /** Local epoch milliseconds. */
  opened_at_ms: number | null;
  finalized_at_ms: number | null;
  submitted: number | null;
  passed: number | null;
  attempts: number;
  last_error: string | null;
  updated_at_ms: number;
}

export type FeedKind =
  | "task_opened"
  | "results"
  | "payday"
  | "layoff"
  | "layoff_warning"
  | "rehire"
  | "streak"
  | "reserve_low"
  | "stalled"
  | "recovered";

export type FeedSource = FlavorSource | "system";

export interface FeedEntry {
  id: number;
  at: number;
  kind: FeedKind;
  task_id: number | null;
  text: string;
  source: FeedSource;
  /** Code-generated facts (accounts, counts, amounts). The text is flavor; this is the record. */
  data: Record<string, unknown>;
}

export type NewFeedEntry = Omit<FeedEntry, "id" | "at"> & { dedupe: string };

export interface EmployeeSnapshot {
  account: string;
  status: EmployeeStatus;
  misses_in_row: number;
}

export interface StoreChange {
  task?: TaskRow;
  feed?: NewFeedEntry[];
  employees?: EmployeeSnapshot[];
  meta?: Record<string, string>;
}

export interface Store {
  readonly events: EventEmitter<{ feed: [FeedEntry] }>;
  getTask(slot: number): TaskRow | null;
  /** Lowest slot that is not FINALIZED. */
  headTask(): TaskRow | null;
  lastTask(): TaskRow | null;
  /** Rows in slot order, starting at `fromSlot`. */
  listTasks(fromSlot?: number, limit?: number): TaskRow[];
  findByChainId(chainTaskId: number): TaskRow | null;
  insertTask(row: TaskRow): void;
  /** Applies everything atomically. Feed entries whose dedupe key exists are skipped. */
  commit(change: StoreChange): void;
  listFeed(sinceId: number, limit: number): FeedEntry[];
  employees(): Map<string, EmployeeSnapshot>;
  getMeta(key: string): string | null;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (slot INTEGER PRIMARY KEY, state TEXT NOT NULL, chain_task_id INTEGER, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_chain ON tasks (chain_task_id);
CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, task_id INTEGER,
  text TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS employees (account TEXT PRIMARY KEY, status TEXT NOT NULL, misses_in_row INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;
const toTask = (r: unknown): TaskRow | null => (r ? (JSON.parse((r as Row)["data"] as string) as TaskRow) : null);

export class SqliteStore implements Store {
  readonly events = new EventEmitter<{ feed: [FeedEntry] }>();
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.events.setMaxListeners(1000); // one per SSE client
  }

  getTask(slot: number): TaskRow | null {
    return toTask(this.db.prepare("SELECT data FROM tasks WHERE slot = ?").get(slot));
  }

  headTask(): TaskRow | null {
    return toTask(this.db.prepare("SELECT data FROM tasks WHERE state != 'FINALIZED' ORDER BY slot LIMIT 1").get());
  }

  lastTask(): TaskRow | null {
    return toTask(this.db.prepare("SELECT data FROM tasks ORDER BY slot DESC LIMIT 1").get());
  }

  listTasks(fromSlot = 0, limit = 1000): TaskRow[] {
    const rows = this.db.prepare("SELECT data FROM tasks WHERE slot >= ? ORDER BY slot LIMIT ?").all(fromSlot, limit);
    return rows.map((r) => toTask(r) as TaskRow);
  }

  findByChainId(chainTaskId: number): TaskRow | null {
    return toTask(this.db.prepare("SELECT data FROM tasks WHERE chain_task_id = ? ORDER BY slot DESC LIMIT 1").get(chainTaskId));
  }

  insertTask(row: TaskRow): void {
    const r = { ...row, updated_at_ms: this.nowMs() };
    this.db
      .prepare("INSERT INTO tasks (slot, state, chain_task_id, data) VALUES (?, ?, ?, ?)")
      .run(r.slot, r.state, r.chain_task_id, JSON.stringify(r));
  }

  commit(change: StoreChange): void {
    const inserted: FeedEntry[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (change.task) {
        const r = { ...change.task, updated_at_ms: this.nowMs() };
        const res = this.db
          .prepare("UPDATE tasks SET state = ?, chain_task_id = ?, data = ? WHERE slot = ?")
          .run(r.state, r.chain_task_id, JSON.stringify(r), r.slot);
        if (Number(res.changes) !== 1) throw new Error(`task slot ${r.slot} does not exist`);
      }
      const at = this.nowMs();
      for (const f of change.feed ?? []) {
        const res = this.db
          .prepare("INSERT OR IGNORE INTO feed (at_ms, kind, task_id, text, source, data, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(at, f.kind, f.task_id, f.text, f.source, JSON.stringify(f.data), f.dedupe);
        if (Number(res.changes) === 1) {
          const { dedupe: _dedupe, ...entry } = f;
          inserted.push({ ...entry, id: Number(res.lastInsertRowid), at });
        }
      }
      for (const e of change.employees ?? []) {
        this.db
          .prepare(
            "INSERT INTO employees (account, status, misses_in_row) VALUES (?, ?, ?) " +
              "ON CONFLICT(account) DO UPDATE SET status = excluded.status, misses_in_row = excluded.misses_in_row",
          )
          .run(e.account, e.status, e.misses_in_row);
      }
      for (const [k, v] of Object.entries(change.meta ?? {})) {
        this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const f of inserted) this.events.emit("feed", f);
  }

  listFeed(sinceId: number, limit: number): FeedEntry[] {
    const rows = this.db.prepare("SELECT * FROM feed WHERE id > ? ORDER BY id LIMIT ?").all(sinceId, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      at: Number(r["at_ms"]),
      kind: r["kind"] as FeedKind,
      task_id: r["task_id"] === null ? null : Number(r["task_id"]),
      text: r["text"] as string,
      source: r["source"] as FeedSource,
      data: JSON.parse(r["data"] as string) as Record<string, unknown>,
    }));
  }

  employees(): Map<string, EmployeeSnapshot> {
    const rows = this.db.prepare("SELECT account, status, misses_in_row FROM employees").all() as Row[];
    return new Map(
      rows.map((r) => {
        const e: EmployeeSnapshot = {
          account: r["account"] as string,
          status: r["status"] as EmployeeStatus,
          misses_in_row: Number(r["misses_in_row"]),
        };
        return [e.account, e];
      }),
    );
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? (r["value"] as string) : null;
  }

  close(): void {
    this.db.close();
  }
}
