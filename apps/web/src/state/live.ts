/**
 * LiveSource (roadmap W-12): the building from the chain. Paged contract and token views, events
 * polled from the contract's ring buffer (`get_events`, D8), the boss service's flavor text and
 * feed. Reads are coalesced (one refresh in flight, events debounce into one re-read) to stay
 * inside public RPC rate limits (R-12). If reads keep failing the snapshot is marked stale. The
 * clock is corrected from the latest block timestamp (design §5.6).
 */
import {
  decodeTower,
  MAX_HOLDER_PAGE,
  readAll,
  type ContractConfig,
  type ContractInfo,
  type ReorgEvent,
  type SubmissionView,
  type TaskView,
  type TowerLayout,
  type TowerReader,
  type WalletAdapter,
  type WalletId,
} from "@reorg/core";
import type { BossClient } from "./boss";
import { feedItemOf } from "./boss";
import { FeedLog, feedFromEvent } from "./feed";
import type { FeedItem, LedgerRow, PlayerView, Puzzle, Snapshot, StateSource, Unsubscribe } from "./types";
import { nsToMs } from "./types";

export interface LiveOptions {
  reader: TowerReader;
  boss: BossClient | null;
  network: string;
  /** Crowd accounts are `<name>.<crowdRoot>` (deployment config, design §12.5). */
  crowdRoot: string | null;
  /** Income tags deposited by our own bots, marked "simulated" in the ledger (D-08). */
  simulatedIncomeTags?: readonly string[];
  pollMs?: number;
  fullRefreshMs?: number;
  staleAfterMs?: number;
}

const HISTORY_EVENTS = 60;
/**
 * Up to this many holders every client reads the chain itself (trustless, as before); past it,
 * the tower comes from the boss service's one shared read (`GET /api/tower`, design §12), while
 * the player's own balance, record and submission are still read from the chain (`player()`).
 */
export const FULL_READ_MAX = 2000;

export class LiveSource implements StateSource {
  readonly kind = "live" as const;
  private readonly reader: TowerReader;
  private readonly boss: BossClient | null;
  private readonly pollMs: number;
  private readonly fullMs: number;
  private readonly staleMs: number;
  private readonly simTags: Set<string>;
  private offset = 0;
  private lastSeq = 0;
  private snap: Snapshot | null = null;
  private config: ContractConfig | null = null;
  private configAt = 0;
  private stalled = false;
  private bossTask: Snapshot["boss"] = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopFeed: (() => void) | null = null;
  /** Last successful full read (polls do not count: a broken view must still show as stale). */
  private lastOk = 0;
  private running = false;
  private polling = false;
  private seqKnown = false;
  private bootGen = 0;
  private readonly feedLog = new FeedLog();
  private readonly ledgerRows: LedgerRow[] = [];
  private readonly snapListeners = new Set<(s: Snapshot) => void>();
  private readonly eventListeners = new Set<(e: ReorgEvent) => void>();
  private readonly isCrowd: (w: WalletId) => boolean;
  private you: WalletId | null = null;
  /** The last read was a big company's (the boss's tower). */
  private big = false;

  constructor(opts: LiveOptions) {
    this.reader = opts.reader;
    this.boss = opts.boss;
    this.pollMs = opts.pollMs ?? 2000;
    this.fullMs = opts.fullRefreshMs ?? 15_000;
    this.staleMs = opts.staleAfterMs ?? 12_000;
    this.simTags = new Set(opts.simulatedIncomeTags ?? ["client_job"]);
    const root = opts.crowdRoot;
    this.isCrowd = root ? (w) => w.endsWith(`.${root}`) : () => false;
    this.network = opts.network;
  }
  private readonly network: string;

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.boot();
  }

  stop(): void {
    this.running = false;
    this.bootGen++;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.stopFeed?.();
    this.stopFeed = null;
    if (this.debounce) clearTimeout(this.debounce);
  }

  private async boot(): Promise<void> {
    // A stop() → start() while this boot is still awaiting starts a new generation; the old one quits.
    const gen = ++this.bootGen;
    const live = () => this.running && gen === this.bootGen;
    await this.syncClock();
    // Only events after this seq animate (design §14.1 rule 3); poll() waits until it is known.
    for (let attempt = 0; live() && !this.seqKnown; attempt++) {
      try {
        const info = await this.reader.getInfo();
        this.lastSeq = info.event_seq;
        this.seqKnown = true;
        await this.loadHistory(info).catch(() => undefined);
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** attempt)));
      }
    }
    if (!live()) return;
    await this.loadBossFeed();
    if (!live()) {
      this.stopFeed?.();
      this.stopFeed = null;
      return;
    }
    this.refresh();
    this.timers.push(
      setInterval(() => void this.poll(), this.pollMs),
      setInterval(() => this.refresh(), this.fullMs),
      setInterval(() => void this.syncClock(), 30_000),
      setInterval(() => void this.checkBoss(), 15_000),
    );
    void this.checkBoss();
  }

  /** Recent chain events become feed and ledger history; they do not animate (design §14.1 rule 3). */
  private async loadHistory(info: ContractInfo): Promise<void> {
    if (info.event_seq === 0) return;
    const events = await this.reader.getEvents(Math.max(0, info.event_seq - HISTORY_EVENTS), HISTORY_EVENTS);
    for (const e of events) this.book(e, false);
  }

  private async loadBossFeed(): Promise<void> {
    if (!this.boss) return;
    let since = 0;
    try {
      for (let page = 0; page < 20; page++) {
        const entries = await this.boss.feed(since, 200);
        this.feedLog.add(...entries.map(feedItemOf));
        if (entries.length < 200) break;
        since = entries[entries.length - 1]!.id;
      }
      const last = this.feedLog.list().find((f) => f.id.startsWith("boss"));
      since = last ? Number(last.id.slice(4)) : since;
    } catch {
      /* the boss may be down; the chain still draws the building */
    }
    this.stopFeed = this.boss.stream(since, (e) => this.feedLog.add(feedItemOf(e)));
  }

  private async syncClock(): Promise<void> {
    try {
      const t0 = Date.now();
      const chainNs = await this.reader.now();
      const t1 = Date.now();
      this.offset = nsToMs(chainNs) - (t0 + t1) / 2;
    } catch {
      /* keep the last offset */
    }
  }

  private async checkBoss(): Promise<void> {
    if (!this.boss) return;
    const h = await this.boss.health();
    const stalled = h?.status === "STALLED";
    if (stalled !== this.stalled) {
      this.stalled = stalled;
      this.refresh();
    }
  }

  // ------------------------------------------------------------------ events

  private async poll(): Promise<void> {
    // One poll at a time: overlapping polls would book the same events twice.
    if (!this.running || !this.seqKnown || this.polling) return;
    this.polling = true;
    try {
      for (;;) {
        const events = await this.reader.getEvents(this.lastSeq, 100);
        for (const e of events) {
          this.lastSeq = Math.max(this.lastSeq, e.seq);
          this.book(e, true);
        }
        if (events.length) this.refreshSoon();
        if (events.length < 100) break;
      }
    } catch {
      this.markStale();
    } finally {
      this.polling = false;
    }
  }

  /** Feed line, ledger row and listeners for one event. */
  private book(e: ReorgEvent, live: boolean): void {
    const f = feedFromEvent(e, { bossCovers: !!this.boss });
    if (f) this.feedLog.add(f);
    const at = nsToMs(e.at);
    switch (e.event) {
      case "income_deposited":
        this.bookLedger(at, { kind: "income", amount: BigInt(e.data.amount), tag: e.data.tag, simulated: this.simTags.has(e.data.tag) });
        break;
      case "salary_paid":
        this.bookLedger(at, { kind: "salary", amount: BigInt(e.data.amount), wallet: e.data.account_id, taskId: e.data.task_id, simulated: false });
        break;
      case "salary_forfeited":
        this.bookLedger(at, { kind: "forfeit", amount: BigInt(e.data.amount), wallet: e.data.account_id, taskId: e.data.task_id, simulated: false });
        break;
      case "payroll_allocated":
        if (BigInt(e.data.operating_cost_paid) > 0n) this.bookLedger(at, { kind: "operating", amount: BigInt(e.data.operating_cost_paid), taskId: e.data.task_id, simulated: false });
        break;
      default:
        break;
    }
    if (live) for (const fn of this.eventListeners) fn(e);
  }

  private bookLedger(at: number, row: Omit<LedgerRow, "at">): void {
    this.ledgerRows.unshift({ at, ...row });
    this.ledgerRows.sort((a, b) => b.at - a.at);
    if (this.ledgerRows.length > 200) this.ledgerRows.length = 200;
  }

  // ------------------------------------------------------------------ reads

  private refreshSoon(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 300);
  }

  /** One full re-read; calls during a read coalesce into one more read after it. */
  refresh(): void {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = this.read()
      .catch(() => this.markStale())
      .finally(() => {
        this.refreshing = null;
        if (this.again && this.running) {
          this.again = false;
          this.refresh();
        }
      });
  }

  private markStale(): void {
    if (this.snap && !this.snap.stale && Date.now() - this.lastOk > this.staleMs) {
      this.snap = { ...this.snap, stale: true };
      this.emitSnap();
    }
  }

  private async read(): Promise<void> {
    const r = this.reader;
    if (!this.config || Date.now() - this.configAt > 60_000) {
      this.config = await r.getConfig();
      this.configAt = Date.now();
    }
    const info = await r.getInfo();
    // A big company: the boss's shared tower, or (boss down or too old) the full read anyway.
    const count = this.boss ? await r.holdersCount().catch(() => 0) : 0;
    const tower = count > FULL_READ_MAX ? await this.bossTower() : null;
    this.big = tower !== null;
    const [task, holders, employees, treasury] = await Promise.all([
      info.current_task_id > 0 ? r.getTask(info.current_task_id) : Promise.resolve(null),
      tower ? Promise.resolve([]) : readAll((from, limit) => r.listHolders(from, limit), MAX_HOLDER_PAGE),
      tower ? Promise.resolve([]) : readAll((from, limit) => r.listEmployees(from, limit)),
      r.getTreasury(),
    ]);
    const [submissions, lastFinalizedTask, bossTask] = await Promise.all([
      task && !tower ? readAll((from, limit) => r.listSubmissions(task.id, from, limit)) : Promise.resolve([] as SubmissionView[]),
      info.last_finalized === 0
        ? Promise.resolve(null)
        : task && task.id === info.last_finalized
          ? Promise.resolve(task)
          : r.getTask(info.last_finalized),
      this.boss ? this.boss.currentTask().catch(() => null) : Promise.resolve(null),
    ]);
    if (bossTask && task && bossTask.task_id === task.id) this.bossTask = bossTask;
    this.snap = {
      kind: "live",
      network: this.network,
      config: this.config,
      totalSupply: BigInt(info.total_supply),
      lastFinalized: info.last_finalized,
      task,
      submissions,
      lastFinalizedTask: lastFinalizedTask as TaskView | null,
      holders,
      employees,
      treasury,
      boss: this.bossTask && task && this.bossTask.task_id === task.id ? this.bossTask : null,
      stalled: this.stalled,
      isCrowd: this.isCrowd,
      stale: false,
      nextOpenAt: null,
      ...(tower ? { tower } : {}),
    };
    this.lastOk = Date.now();
    this.emitSnap();
  }

  private async bossTower(): Promise<TowerLayout | null> {
    try {
      const t = await this.boss!.tower(this.you);
      return t ? decodeTower(t.tower, { isCrowd: this.isCrowd }) : null;
    } catch {
      return null;
    }
  }

  focus(wallet: WalletId | null): void {
    if (wallet === this.you) return;
    this.you = wallet;
    // Only a big company's picture depends on who is looking (their floor unfolds).
    if (this.big) this.refresh();
  }

  private emitSnap(): void {
    if (!this.snap) return;
    for (const fn of this.snapListeners) fn(this.snap);
  }

  // ------------------------------------------------------------------ StateSource

  now(): number {
    return Date.now() + this.offset;
  }

  snapshot(): Snapshot | null {
    return this.snap;
  }

  onSnapshot(fn: (s: Snapshot) => void): Unsubscribe {
    this.snapListeners.add(fn);
    return () => this.snapListeners.delete(fn);
  }

  onEvent(fn: (e: ReorgEvent) => void): Unsubscribe {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onFeed(fn: (items: readonly FeedItem[]) => void): Unsubscribe {
    return this.feedLog.on(fn);
  }

  feed(): readonly FeedItem[] {
    return this.feedLog.list();
  }

  ledger(): readonly LedgerRow[] {
    return this.ledgerRows;
  }

  wallet(): WalletAdapter | null {
    return null;
  }

  async player(wallet: WalletId): Promise<PlayerView> {
    const r = this.reader;
    const snap = this.snap;
    const [holder, employee] = await Promise.all([r.holderInfo(wallet), r.getEmployee(wallet)]);
    const task = snap?.task ?? null;
    const lastFinalized = snap?.lastFinalized ?? 0;
    // Salary waits on any passed, finalized day in the recent window (the view keeps 7).
    const passedDays = (employee?.recent ?? []).filter((x) => x.result === "pass" && x.task_id <= lastFinalized).map((x) => x.task_id);
    const ids = [...new Set([...(task ? [task.id] : []), ...passedDays])];
    const subs = await Promise.all(ids.map((id) => r.getSubmission(id, wallet)));
    const byId = new Map(ids.map((id, i) => [id, subs[i] ?? null]));
    const claimables = passedDays
      .map((id) => byId.get(id))
      .filter((s): s is SubmissionView => !!s && s.passed && !s.reapply && BigInt(s.pay) > 0n && s.claim === "unclaimed")
      .sort((a, b) => b.task_id - a.task_id);
    return { wallet, holder, employee, submission: task ? byId.get(task.id) ?? null : null, claimables };
  }

  async puzzle(wallet: WalletId): Promise<Puzzle | null> {
    return this.boss ? this.boss.puzzle(wallet) : null;
  }
}
