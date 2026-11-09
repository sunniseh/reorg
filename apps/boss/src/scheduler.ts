// B-08 / B-09 / B-11: the boss scheduler. One task slot at a time moves through
//   PICKED → GENERATED → CHECKED → OPENING → OPEN → CLOSED → FINALIZING → FINALIZED
// and every transition is persisted before the side effect it enables. Each tick does at most
// one step and returns how long to wait. Every chain-facing step first reconciles with the chain's
// views, so a crash, a timeout or a lost response at any point resumes without a double open,
// a lost secret or a double-counted passer (B-16 tests every point).
import { randomBytes } from "node:crypto";
import {
  answerHashBase64,
  CIPHERS,
  commitHash,
  deriveCode,
  fromBase64,
  readAll,
  resolveDayParams,
  toBase64,
  type ChainAdapter,
  type ContractConfig,
  type PuzzleParams,
  type ReorgEvent,
  type TaskView,
} from "@reorg/core";
import { formatNear, writeFlavor, type AnnouncementEvent, type FlavorRequest, type FlavorWriter } from "./flavor";
import { diffEmployees, eventNotices } from "./notices";
import { pickParams, type PickContext, type PickerConfig } from "./picker";
import type { FeedKind, NewFeedEntry, Store, TaskRow, TaskState } from "./store";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    }),
};

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}
export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export interface SchedulerConfig {
  /** Time between task openings (EPOCH_SECONDS). */
  epochMs: number;
  /** Share of the epoch the submission window stays open (WINDOW_FRACTION). */
  windowFraction: number;
  /** The first N slots of a fresh boss are warm-up tasks: level 1, short window, back to back (D-03). */
  warmupTasks: number;
  warmupWindowMs: number;
  /** Wait after closes_at before revealing, so in-flight submit callbacks land (B-09). */
  finalityMarginMs: number;
  /** Slots generated and self-checked ahead of time (B-04 look-ahead queue). */
  lookahead: number;
  /** Added to the contract's min_window_ns: opens_at is the block time, a bit after our clock read. */
  openSlackMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Consecutive failures of one step before the scheduler reports STALLED (B-11). */
  stallAfterAttempts: number;
  /** Longest single wait, so /healthz stays fresh. */
  maxWaitMs: number;
  picker: PickerConfig;
}

export interface SchedulerDeps {
  store: Store;
  chain: ChainAdapter;
  clock?: Clock;
  flavor?: FlavorWriter;
  config: SchedulerConfig;
  log?: Logger;
  /** CSPRNG for day secrets; injectable for tests only. */
  randomSecret?: () => Uint8Array;
}

export interface Stall {
  slot: number;
  state: TaskState;
  since: number;
  reason: string;
}

export interface Health {
  ok: boolean;
  status: "RUNNING" | "STALLED";
  head: Pick<TaskRow, "slot" | "state" | "chain_task_id" | "attempts" | "last_error" | "closes_at"> | null;
  stalled: Stall | null;
  last_tick_ms: number | null;
  flavor: "ai" | "template";
  /** Upcoming slots, already generated and self-checked. */
  lookahead: { slot: number; params: PuzzleParams | null; used_fallback: boolean; check_ok: boolean; failures: string[] }[];
}

/** A condition that needs a human (wrong chain state). Retried slowly, reported as STALLED at once. */
export class StallError extends Error {}

const NS_PER_MS = 1_000_000n;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sameParams = (a: PuzzleParams, b: PuzzleParams) => a.family === b.family && a.cipher === b.cipher && a.level === b.level;

export class Scheduler {
  private readonly store: Store;
  private readonly chain: ChainAdapter;
  private readonly clock: Clock;
  private readonly flavor: FlavorWriter | undefined;
  private readonly cfg: SchedulerConfig;
  private readonly log: Logger;
  private readonly randomSecret: () => Uint8Array;
  private contractConfig: { value: ContractConfig; at: number } | null = null;
  private stall: Stall | null = null;
  private lastTickMs: number | null = null;
  private readonly stopper = new AbortController();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.chain = deps.chain;
    this.clock = deps.clock ?? realClock;
    this.flavor = deps.flavor;
    this.cfg = deps.config;
    this.log = deps.log ?? silentLogger;
    this.randomSecret = deps.randomSecret ?? (() => new Uint8Array(randomBytes(32)));
  }

  /** Runs until stop(). Chain and flavor errors are retried, never thrown. */
  async run(): Promise<void> {
    while (!this.stopper.signal.aborted) {
      const wait = await this.tick();
      await this.clock.sleep(wait, this.stopper.signal);
    }
  }

  stop(): void {
    this.stopper.abort();
  }

  /** One step. Returns milliseconds to wait before the next tick. */
  async tick(): Promise<number> {
    this.lastTickMs = this.clock.now();
    this.fillLookahead();
    const head = this.store.headTask();
    if (!head) return this.cfg.maxWaitMs;
    try {
      const wait = await this.step(head);
      if (this.stall?.slot === head.slot) this.recovered(head);
      return Math.max(0, Math.min(wait, this.cfg.maxWaitMs));
    } catch (e) {
      return this.onError(head.slot, e);
    }
  }

  health(): Health {
    const head = this.store.headTask();
    const upcoming = head ? this.store.listTasks(head.slot, this.cfg.lookahead + 1) : [];
    const fresh = this.lastTickMs !== null && this.clock.now() - this.lastTickMs < Math.max(60_000, 4 * this.cfg.maxWaitMs);
    return {
      ok: !this.stall && fresh && upcoming.every((r) => r.state === "PICKED" || r.state === "GENERATED" || r.check_ok),
      status: this.stall ? "STALLED" : "RUNNING",
      head: head
        ? { slot: head.slot, state: head.state, chain_task_id: head.chain_task_id, attempts: head.attempts, last_error: head.last_error, closes_at: head.closes_at }
        : null,
      stalled: this.stall,
      last_tick_ms: this.lastTickMs,
      flavor: this.flavor?.source ?? "template",
      lookahead: upcoming.map((r) => ({
        slot: r.slot,
        params: r.params,
        used_fallback: r.used_fallback,
        check_ok: r.check_ok,
        failures: r.check_failures.slice(0, 5),
      })),
    };
  }

  // ------------------------------------------------------------------ persistence helpers

  /** Persists a successful transition (resets the retry counter). */
  private save(row: TaskRow, patch: Partial<TaskRow>, feed: NewFeedEntry[] = []): TaskRow {
    const next: TaskRow = { ...row, ...patch, attempts: 0, last_error: null };
    this.store.commit({ task: next, feed });
    return next;
  }

  private onError(slot: number, e: unknown): number {
    const row = this.store.getTask(slot);
    if (!row) throw e;
    // An RPC error can echo the call's arguments; the secret must never reach logs or /healthz.
    const raw = errMsg(e);
    const reason = (row.secret ? raw.split(row.secret).join("[secret]") : raw).slice(0, 500);
    const next: TaskRow = { ...row, attempts: row.attempts + 1, last_error: reason };
    this.store.commit({ task: next });
    this.log.warn("scheduler step failed", { slot, state: row.state, attempt: next.attempts, error: reason });
    if (!this.stall && (e instanceof StallError || next.attempts >= this.cfg.stallAfterAttempts)) {
      this.stall = { slot, state: row.state, since: this.clock.now(), reason };
      this.store.commit({
        feed: [
          {
            kind: "stalled",
            task_id: row.chain_task_id,
            text: `The boss is having technical difficulties (${row.state.toLowerCase()}). Operations will resume shortly. Probably.`,
            source: "system",
            data: { slot, state: row.state, reason },
            dedupe: `stalled:${slot}:${row.state}:${this.stall.since}`,
          },
        ],
      });
    }
    return Math.min(this.cfg.retryBaseMs * 2 ** Math.min(next.attempts - 1, 20), this.cfg.retryMaxMs);
  }

  private recovered(head: TaskRow): void {
    const stall = this.stall!;
    this.stall = null;
    this.log.info("scheduler recovered", { slot: head.slot });
    this.store.commit({
      feed: [
        {
          kind: "recovered",
          task_id: head.chain_task_id,
          text: "Systems are back online. Thank you for your patience, which has been noted in your file.",
          source: "system",
          data: { slot: stall.slot, state: stall.state, stalled_ms: this.clock.now() - stall.since },
          dedupe: `recovered:${stall.slot}:${stall.since}`,
        },
      ],
    });
  }

  private async contract(force = false): Promise<ContractConfig> {
    const now = this.clock.now();
    if (force || !this.contractConfig || now - this.contractConfig.at > 60_000) {
      this.contractConfig = { value: await this.chain.getConfig(), at: now };
    }
    return this.contractConfig.value;
  }

  // ------------------------------------------------------------------ look-ahead (PICKED → CHECKED)

  private pickContext(slot: number, previous: TaskRow | null): PickContext {
    return {
      slot,
      warmup: slot <= this.cfg.warmupTasks,
      previous: previous
        ? { params: previous.params ?? previous.requested, submitted: previous.submitted, passed: previous.passed }
        : null,
    };
  }

  /** Keeps `lookahead` slots past the head generated and self-checked. Local work only. */
  private fillLookahead(): void {
    const head = this.store.headTask();
    const last = this.store.lastTask();
    const headSlot = head?.slot ?? (last?.slot ?? 0) + 1;
    for (let slot = (last?.slot ?? 0) + 1; slot <= headSlot + this.cfg.lookahead; slot++) {
      const ctx = this.pickContext(slot, this.store.getTask(slot - 1));
      this.store.insertTask({
        slot,
        state: "PICKED",
        warmup: ctx.warmup,
        requested: pickParams(ctx, this.cfg.picker),
        params: null,
        used_fallback: false,
        check_ok: false,
        check_failures: [],
        secret: null,
        commit: null,
        task_text: null,
        flavor_source: null,
        chain_task_id: null,
        opens_at: null,
        closes_at: null,
        opened_at_ms: null,
        finalized_at_ms: null,
        submitted: null,
        passed: null,
        attempts: 0,
        last_error: null,
        updated_at_ms: 0,
      });
    }
    for (let row of this.store.listTasks(headSlot, this.cfg.lookahead + 1)) {
      if (row.state === "PICKED") {
        // The secret is stored before anything derived from it exists (PROTOCOL.md §3.4).
        const secret = this.randomSecret();
        if (secret.length !== 32) throw new Error("day secret must be 32 bytes");
        row = this.save(row, { state: "GENERATED", secret: toBase64(secret), commit: toBase64(commitHash(secret)) });
      }
      if (row.state === "GENERATED") this.save(row, { state: "CHECKED", ...this.check(row.requested, row.secret!) });
    }
  }

  private check(requested: PuzzleParams, secretB64: string): Pick<TaskRow, "params" | "used_fallback" | "check_ok" | "check_failures"> {
    const day = resolveDayParams(requested, fromBase64(secretB64));
    if (day.usedFallback) {
      this.log.warn("self-check failed, using the fallback", { requested, failures: day.requestedReport.failures.slice(0, 3) });
    }
    return {
      params: day.params,
      used_fallback: day.usedFallback,
      check_ok: day.report.ok,
      check_failures: day.usedFallback ? [...day.requestedReport.failures, ...day.report.failures] : day.report.failures,
    };
  }

  // ------------------------------------------------------------------ the cycle

  private async step(head: TaskRow): Promise<number> {
    switch (head.state) {
      case "PICKED":
      case "GENERATED":
      case "FINALIZED":
        return 0; // fillLookahead advances the first two; FINALIZED is never the head
      case "CHECKED":
        return this.prepareOpen(head);
      case "OPENING":
        return this.open(head);
      case "OPEN":
        return this.waitForClose(head);
      case "CLOSED":
        this.save(head, { state: "FINALIZING" });
        return 0;
      case "FINALIZING":
        return this.finalize(head);
    }
  }

  private dueAt(head: TaskRow, prev: TaskRow | null): number {
    if (!prev) return 0;
    const finalizedAt = prev.finalized_at_ms ?? 0;
    if (head.warmup || prev.warmup) return finalizedAt;
    return Math.max((prev.opened_at_ms ?? 0) + this.cfg.epochMs, finalizedAt);
  }

  private windowMs(row: TaskRow): number {
    return row.warmup ? this.cfg.warmupWindowMs : Math.round(this.cfg.epochMs * this.cfg.windowFraction);
  }

  /** CHECKED → OPENING: wait for the slot's time, re-pick (auto difficulty), write the memo. */
  private async prepareOpen(head: TaskRow): Promise<number> {
    const prev = head.slot > 1 ? this.store.getTask(head.slot - 1) : null;
    const due = this.dueAt(head, prev);
    const now = this.clock.now();
    if (now < due) return due - now;

    let row = head;
    const wanted = pickParams(this.pickContext(row.slot, prev), this.cfg.picker);
    if (!sameParams(wanted, row.requested)) row = this.save(row, { requested: wanted, ...this.check(wanted, row.secret!) });
    if (!row.check_ok) throw new StallError("puzzle self-check failed, even for the fallback");

    const [info, treasury] = await Promise.all([this.chain.getInfo(), this.chain.getTreasury()]);
    const params = row.params!;
    const req: FlavorRequest = {
      seed: row.slot,
      task: { number: info.current_task_id + 1, kind: "decode_memo", cipher: CIPHERS[params.cipher].label, level: params.level, warmup: row.warmup },
      stats: { headcount: info.employees, reserve: formatNear(treasury.reserve), runway_tasks: treasury.runway_tasks },
      yesterday: prev?.chain_task_id != null ? { task_id: prev.chain_task_id, submitted: prev.submitted ?? 0, passed: prev.passed ?? 0 } : null,
      events: [],
    };
    const flavor = await writeFlavor(req, this.flavor);
    if (flavor.fallbackReason) this.log.warn("LLM flavor rejected, using the template", { slot: row.slot, reason: flavor.fallbackReason });
    this.save(row, { state: "OPENING", task_text: flavor.output.task_text, flavor_source: flavor.source });
    return 0;
  }

  /** OPENING → OPEN. Reconciles first: a previous attempt may have landed. */
  private async open(head: TaskRow): Promise<number> {
    let row = head;
    const info = await this.chain.getInfo();
    if (row.chain_task_id === null) {
      if (info.current_task_id !== info.last_finalized) {
        throw new StallError(`chain task ${info.current_task_id} is not finalized and is not this boss's (manual recovery needed)`);
      }
      row = this.save(row, { chain_task_id: info.current_task_id + 1 });
    }
    const id = row.chain_task_id!;
    const existing = await this.chain.getTask(id);
    if (existing) {
      if (existing.commit_hash !== row.commit) throw new StallError(`chain task ${id} exists with a different commit`);
      return this.markOpen(row, existing);
    }
    if (info.current_task_id !== id - 1 || info.last_finalized !== id - 1) {
      throw new StallError(`cannot open chain task ${id}: chain is at task ${info.current_task_id}, last finalized ${info.last_finalized}`);
    }
    const config = await this.contract();
    const minMs = Number(BigInt(config.min_window_ns) / NS_PER_MS);
    const windowMs = Math.max(this.windowMs(row), minMs + this.cfg.openSlackMs);
    const closesAt = (await this.chain.now()) + BigInt(windowMs) * NS_PER_MS;
    row = this.save(row, { closes_at: closesAt.toString() });
    const got = await this.chain.openTask({ kind: "decode_memo", commit_hash: row.commit!, closes_at: closesAt.toString() });
    if (got !== id) throw new Error(`open_task returned task ${got}, expected ${id}`);
    const task = await this.chain.getTask(id);
    if (!task) throw new Error(`task ${id} not visible after open_task`);
    return this.markOpen(row, task);
  }

  private markOpen(row: TaskRow, task: TaskView): number {
    const opened = this.save(
      row,
      { state: "OPEN", opens_at: task.opens_at, closes_at: task.closes_at, opened_at_ms: Number(BigInt(task.opens_at) / NS_PER_MS) },
      [
        {
          kind: "task_opened",
          task_id: task.id,
          text: row.task_text ?? "",
          source: row.flavor_source ?? "template",
          data: { task_id: task.id, params: row.params, warmup: row.warmup, closes_at: task.closes_at, commit_hash: task.commit_hash },
          dedupe: `opened:${row.slot}`,
        },
      ],
    );
    this.log.info("task opened", { slot: opened.slot, task_id: task.id, params: opened.params, closes_at: task.closes_at });
    return 0;
  }

  /** OPEN → CLOSED once chain time passes closes_at + the finality margin. */
  private async waitForClose(row: TaskRow): Promise<number> {
    const target = BigInt(row.closes_at!) + BigInt(this.cfg.finalityMarginMs) * NS_PER_MS;
    const now = await this.chain.now();
    if (now < target) return Number((target - now) / NS_PER_MS) + 1;
    this.save(row, { state: "CLOSED" });
    return 0;
  }

  /**
   * FINALIZING, idempotent from chain state: (1) an empty first call reveals the secret and
   * freezes the submission set (late callbacks are rejected from then on); (2) passers are
   * recomputed from the frozen set minus those already verified and sent in batches of
   * max_passers_per_call, the last batch with `last = true`; (3) once finalized, announce.
   */
  private async finalize(row: TaskRow): Promise<number> {
    const id = row.chain_task_id!;
    const task = await this.chain.getTask(id);
    if (!task) throw new StallError(`chain task ${id} not found`);
    if (task.status === "open") return 1000;
    if (task.status === "closed") {
      await this.chain.finalizeTask({ task_id: id, day_secret: row.secret!, passers: [], last: false });
      return 0;
    }
    if (task.status === "finalizing") {
      const secret = fromBase64(row.secret!);
      const subs = await readAll((from, limit) => this.chain.listSubmissions(id, from, limit));
      const remaining = subs
        .filter((s) => !s.passed && s.answer_hash === answerHashBase64(deriveCode(secret, s.account_id), s.account_id))
        .map((s) => s.account_id);
      const max = (await this.contract()).max_passers_per_call;
      const batch = remaining.slice(0, max);
      await this.chain.finalizeTask({ task_id: id, day_secret: row.secret!, passers: batch, last: remaining.length <= max });
      this.log.info("finalize batch sent", { task_id: id, passers: batch.length, remaining: remaining.length - batch.length });
      return 0;
    }
    await this.complete(row, task);
    return 0;
  }

  /** Results, payday, streaks, low reserve, layoffs and rehires → feed; row → FINALIZED (one transaction). */
  private async complete(row: TaskRow, task: TaskView): Promise<void> {
    const id = task.id;
    const [info, config, treasury] = await Promise.all([this.chain.getInfo(), this.contract(true), this.chain.getTreasury()]);
    let cursor = Number(this.store.getMeta("event_cursor") ?? "0");
    const events: ReorgEvent[] = [];
    while (cursor < info.event_seq) {
      const page = await this.chain.getEvents(cursor, 100);
      if (page.length === 0) break;
      events.push(...page);
      cursor = page[page.length - 1]!.seq;
    }
    const employees = await readAll((from, limit) => this.chain.listEmployees(from, limit));
    const diff = diffEmployees(this.store.employees(), employees, config.layoff_after);
    const announce: AnnouncementEvent[] = [
      { kind: "results", task_id: id, submitted: task.submitted, passed: task.passed },
      ...eventNotices(events, id),
      ...diff.notices,
    ];
    const flavor = await writeFlavor(
      {
        seed: row.slot,
        task: null,
        stats: { headcount: info.employees, reserve: formatNear(treasury.reserve), runway_tasks: treasury.runway_tasks },
        yesterday: { task_id: id, submitted: task.submitted, passed: task.passed },
        events: announce,
      },
      this.flavor,
    );
    if (flavor.fallbackReason) this.log.warn("LLM flavor rejected, using the template", { slot: row.slot, reason: flavor.fallbackReason });
    const feed: NewFeedEntry[] = announce.map((e, i) => ({
      kind: e.kind as FeedKind,
      task_id: id,
      text: flavor.output.announcements[i]!,
      source: flavor.source,
      data: { ...e },
      dedupe: `${e.kind}:${row.slot}:${"account" in e ? e.account : ""}`,
    }));
    this.store.commit({
      task: { ...row, state: "FINALIZED", finalized_at_ms: this.clock.now(), submitted: task.submitted, passed: task.passed, attempts: 0, last_error: null },
      feed,
      employees: diff.snapshot,
      meta: { event_cursor: String(cursor) },
    });
    this.log.info("task finalized", { slot: row.slot, task_id: id, submitted: task.submitted, passed: task.passed, notices: diff.notices.length });
  }
}
