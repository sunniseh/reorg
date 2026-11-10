/**
 * SimSource (roadmap W-01, W-13, D18): a seeded, simulated company that runs in the browser.
 *
 * It mirrors the contract's rules with the same `@reorg/core` functions the boss and the tests use
 * (tiers, D5 layoffs, D6 streak multiplier, D1 pay, anti-dump, commit–reveal codes), and plays a
 * whole day on a timer: the task opens, bots file answers across the window, the window closes,
 * results, payday, claims, layoffs and rehires. It powers the growth preview (stages 1–3) and lets
 * the visual work run without a chain. Everything it shows is SIMULATED and labeled as such.
 */
import {
  BPS,
  PPM,
  ConfigSchema,
  LEVEL_CIPHERS,
  answerHashBase64,
  antidumpAllows,
  commitHash,
  deriveCode,
  employeeState,
  generatePuzzle,
  multiplierBps,
  resolveDayParams,
  sha256Bytes,
  streakAfterPass,
  tierOf,
  toBase64,
  type ClaimOutcome,
  type ContractConfig,
  type EmployeeView,
  type HolderEntry,
  type IncomeTag,
  type Level,
  type PuzzleParams,
  type RecentResult,
  type ReorgEvent,
  type SubmissionView,
  type SubmitOutcome,
  type TaskId,
  type TaskView,
  type TierIndex,
  type TreasuryView,
  type Tuple4,
  type WalletAdapter,
  type WalletId,
} from "@reorg/core";
import defaultConfig from "../../../../protocol/config.default.json";
import { payout, plural, shortName } from "../format";
import { FeedLog, feedFromEvent } from "./feed";
import { hash32, unit } from "./rng";
import {
  msToNs,
  nsToMs,
  type BossTask,
  type FeedItem,
  type LedgerRow,
  type PlayerView,
  type Puzzle,
  type Snapshot,
  type StateSource,
  type Unsubscribe,
} from "./types";

const TOKEN = 10n ** 18n;
const NEAR = 10n ** 24n;
const SUPPLY = 1_000_000_000n * TOKEN;
export const SIM_PLAYER = "you.sim";
const MARKET = "market.sim";

export interface SimOptions {
  /** Holders, including ~10% visitors. The top bar offers one size per building state (8 … 50,000, D22); `?size=` reaches 100,000. */
  size: number;
  seed?: string;
  /** Task epoch (ms). The window is 60% of it; results land 2.5 s after it closes. */
  epochMs?: number;
  /** Finalized tasks already in the books when the preview opens. */
  history?: number;
  /** Delay before the first live task opens, so the rush plays soon after load. */
  firstOpenInMs?: number;
  /** Wall clock (tests pass a manual one). */
  clock?: () => number;
  /** Drive time with `advance()` instead of a timer (tests). */
  manual?: boolean;
}

type Profile = "reliable" | "flaky" | "slacker" | "dumper" | "newcomer" | "visitor" | "cycler";

/**
 * The scripted wallet of the demo (ROADMAP D-02, wallet F), on a loop: pass, miss three (laid off
 * at the third finalize), reapply and pass (rehired), pass. Six tasks per cycle, so the preview
 * shows a layoff walk-out and a rehire walk-in every few minutes (design §12.4).
 */
const CYCLE: readonly ("pass" | "skip")[] = ["pass", "skip", "skip", "skip", "pass", "pass"];

interface Bot {
  wallet: WalletId;
  profile: Profile;
  /** First task this bot works on (newcomers show the NEW chip until then). */
  startsAt: TaskId;
  /** Cyclers: phase offset into CYCLE. */
  offset?: number;
}

interface Holder {
  balance: bigint;
  lastReceivedAt: number;
}

interface Employee {
  joined_after: TaskId;
  last_pass_day: TaskId | null;
  streak: number;
  last_tier: TierIndex;
  last_balance: bigint;
  total_earned: bigint;
  badges: number;
}

interface Sub {
  account_id: WalletId;
  answer_hash: string;
  balance: bigint;
  tier: TierIndex;
  streak_before: number;
  multiplier_bps: number;
  weight: bigint;
  submitted_at: number;
  reapply: boolean;
  passed: boolean;
  pay: bigint;
  claim: SubmissionView["claim"];
}

interface Task {
  id: TaskId;
  secret: Uint8Array;
  params: PuzzleParams;
  text: string;
  status: "open" | "finalizing" | "finalized";
  opensAt: number;
  closesAt: number;
  subs: Map<WalletId, Sub>;
  order: WalletId[];
  submittedW: Tuple4<bigint>;
  passedW: Tuple4<bigint>;
  passed: number;
  alloc: TaskView["allocation"];
  finalizedAt: number | null;
}

type Action =
  | { t: number; n: number; kind: "open"; task: TaskId }
  | { t: number; n: number; kind: "submit"; task: TaskId; wallet: WalletId; pass: boolean }
  | { t: number; n: number; kind: "finalize"; task: TaskId }
  | { t: number; n: number; kind: "claim"; task: TaskId; wallet: WalletId }
  | { t: number; n: number; kind: "trade"; wallet: WalletId; balance: bigint }
  | { t: number; n: number; kind: "income"; amount: bigint };
type NewAction = Action extends infer A ? (A extends Action ? Omit<A, "n"> : never) : never;

const NAMES = [
  "ava", "ben", "cleo", "dev", "eli", "fay", "gus", "hana", "ivo", "jun", "kai", "lena", "milo", "nia", "omar", "pia",
  "quin", "rosa", "sam", "tara", "uma", "vik", "wren", "xia", "yuri", "zoe", "ada", "bo", "cyd", "dax", "edie", "finn",
  "gia", "hal", "iris", "jax", "kit", "lou", "max", "nell", "otto", "pax", "rae", "sol", "ted", "una", "val", "wes",
  "yara", "zed",
];
const LEVELS: Level[] = [1, 2, 3, 2, 3, 4, 2];

const OPEN_LINES = [
  "Per my last memo: decode today’s word before close of business.",
  "A memo has been encrypted for your convenience. Please action it.",
  "Today’s deliverable is one word. Circle back when it is decoded.",
  "Quick ask: decode the memo. Not urgent, but due today.",
  "Leadership has prepared a memo. Leadership has also encrypted it.",
];

/** Bot behavior: chance to file an answer, chance that it is right. */
const BEHAVIOR: Record<Exclude<Profile, "visitor" | "cycler">, { submit: number; pass: number }> = {
  reliable: { submit: 0.95, pass: 0.96 },
  flaky: { submit: 0.72, pass: 0.78 },
  slacker: { submit: 0.3, pass: 0.75 },
  dumper: { submit: 0.92, pass: 0.95 },
  newcomer: { submit: 0.9, pass: 0.85 },
};

export class SimSource implements StateSource {
  readonly kind = "sim" as const;
  readonly size: number;
  private readonly seed: string;
  private readonly epoch: number;
  private readonly window: number;
  /** Finalized tasks replayed before load (the cyclers are phased from it). */
  private historyTasks = 6;
  private readonly clock: () => number;
  private readonly manual: boolean;
  private readonly config: ContractConfig;

  private bots: Bot[] = [];
  /** Bots by wallet (finalize looks one up per passer). */
  private botOf = new Map<WalletId, Bot>();
  private holders = new Map<WalletId, Holder>();
  private employees = new Map<WalletId, Employee>();
  private tasks = new Map<TaskId, Task>();
  private current: TaskId = 0;
  private lastFinalized: TaskId = 0;
  private treasury = {
    reserve: 0n,
    income_accrued: 0n,
    outstanding: 0n,
    total_income: 0n,
    income_by_tag: { client_job: 0n, fee_share: 0n, seed: 0n } as Record<IncomeTag, bigint>,
    total_paid: 0n,
    total_forfeited: 0n,
    total_operating_cost: 0n,
  };
  /** A binary min-heap on (t, n): a big preview schedules a submission per holder per task. */
  private queue: Action[] = [];
  /** Snapshots of a big company are built at most this often (ms), so the client keeps its frame rate. */
  private readonly snapEvery: number;
  private lastSnapAt = -Infinity;
  private pendingSnap = false;
  /** Event feed lines wait here and join the feed once per tick (a busy window is thousands). */
  private feedBuf: FeedItem[] = [];
  private seqN = 0;
  private eventSeq = 0;
  private replaying = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cached: Snapshot | null = null;
  private dirty = true;
  private ledgerRows: LedgerRow[] = [];
  private feedLog = new FeedLog();
  private snapListeners = new Set<(s: Snapshot) => void>();
  private eventListeners = new Set<(e: ReorgEvent) => void>();
  private playerJoined = false;
  private simWallet: SimWallet;

  constructor(opts: SimOptions) {
    this.size = Math.max(1, Math.floor(opts.size));
    this.snapEvery = this.size > 20_000 ? 2000 : this.size > 2000 ? 1000 : 0;
    this.seed = opts.seed ?? "reorg-preview";
    this.epoch = opts.epochMs ?? 60_000;
    this.window = Math.round(this.epoch * 0.6);
    this.clock = opts.clock ?? (() => Date.now());
    this.manual = opts.manual ?? false;
    this.config = ConfigSchema.parse({ ...defaultConfig, min_window_ns: "1000000000", excluded_accounts: [MARKET] });
    this.simWallet = new SimWallet(this);

    const now = this.clock();
    // A huge preview replays fewer days, so it opens in seconds (each day verifies every answer).
    const history = opts.history ?? (this.size > 20_000 ? 2 : this.size > 2000 ? 4 : 6);
    this.historyTasks = history;
    const firstLive = opts.firstOpenInMs ?? 4000;
    const origin = now + firstLive - history * this.epoch;
    this.seedCompany(origin - 10_000);
    this.treasury.reserve = 6n * NEAR;
    this.push({ t: origin, kind: "open", task: 1 });
    this.push({ t: origin - 5_000, kind: "income", amount: this.incomePerTask() });
    this.feedLog.add({
      id: "sim-intro",
      at: origin - 20_000,
      kind: "system",
      source: "system",
      pinned: true,
      text: "This is a simulated company: bots, made-up income, no chain. Records before you arrived were generated by the simulation.",
    });
    // Replay the history silently: it is the state a late joiner sees (design §14.1 rule 3).
    this.advance(now);
    this.replaying = false;
  }

  // ------------------------------------------------------------------ StateSource

  start(): void {
    if (this.manual || this.timer) return;
    this.timer = setInterval(() => this.advance(this.clock()), 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  now(): number {
    return this.clock();
  }

  snapshot(): Snapshot {
    if (!this.cached || this.dirty) {
      this.cached = this.buildSnapshot();
      this.dirty = false;
    }
    return this.cached;
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
    this.flushFeed();
    return this.feedLog.list();
  }

  refresh(): void {
    this.advance(this.clock());
  }

  ledger(): readonly LedgerRow[] {
    return this.ledgerRows;
  }

  wallet(): WalletAdapter {
    return this.simWallet;
  }

  async player(wallet: WalletId): Promise<PlayerView> {
    const h = this.holders.get(wallet);
    const task = this.tasks.get(this.current);
    const claimables: SubmissionView[] = [];
    for (let t = this.lastFinalized; t > Math.max(0, this.lastFinalized - 7); t--) {
      const task = this.tasks.get(t)!;
      const s = task.subs.get(wallet);
      if (s && s.passed && !s.reapply && s.pay > 0n && s.claim === "unclaimed") claimables.push(this.subView(t, s));
    }
    const s = task?.subs.get(wallet);
    return {
      wallet,
      holder: { balance: (h?.balance ?? 0n).toString(), last_received_at: msToNs(h?.lastReceivedAt ?? 0) },
      employee: this.employees.has(wallet) ? this.employeeView(wallet) : null,
      submission: task && s ? this.subView(task.id, s) : null,
      claimables,
    };
  }

  async puzzle(wallet: WalletId): Promise<Puzzle | null> {
    const task = this.tasks.get(this.current);
    if (!task || task.status !== "open" || this.clock() >= task.closesAt) return null;
    const p = generatePuzzle(task.params, task.secret, wallet);
    return { task_id: task.id, display: p.display, hint: p.hint, answer_format: "8 letters", task_text: task.text, closes_at: msToNs(task.closesAt) };
  }

  // ------------------------------------------------------------------ the player (SimWallet)

  joinPlayer(): WalletId {
    if (!this.playerJoined) {
      this.playerJoined = true;
      // Held since before the preview started, so the anti-recycling rule (D15) lets them play now.
      this.holders.set(SIM_PLAYER, { balance: this.amountFor(3, 0.4), lastReceivedAt: 0 });
      this.feedLog.add({ id: "sim-you", at: this.clock(), kind: "new_hire", source: "system", wallet: SIM_PLAYER, text: "You badged in as a simulated Intern. Your desk is ready." });
      this.changed();
    }
    return SIM_PLAYER;
  }

  submitAs(wallet: WalletId, taskId: TaskId, answerHash: string): SubmitOutcome {
    this.advance(this.clock());
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    const now = this.clock();
    if (task.status !== "open") throw new Error("task is not open");
    if (now >= task.closesAt) throw new Error("submission window is closed");
    if (task.subs.has(wallet)) throw new Error("already submitted for this task");
    const out = this.acceptSubmission(task, wallet, answerHash, now);
    this.changed();
    return out;
  }

  claimAs(wallet: WalletId, taskId: TaskId): ClaimOutcome {
    this.advance(this.clock());
    const out = this.claim(taskId, wallet);
    this.changed();
    return out;
  }

  // ------------------------------------------------------------------ time

  /** Runs every scheduled action up to `to` (ms). */
  advance(to: number): void {
    while (this.queue.length && this.queue[0]!.t <= to) {
      this.run(this.pop());
      this.pendingSnap = true;
    }
    this.flushFeed();
    // A big company publishes on a slower beat; the scheduled moments still run on time.
    if (this.pendingSnap && (this.replaying || to - this.lastSnapAt >= this.snapEvery)) {
      this.pendingSnap = false;
      this.lastSnapAt = to;
      this.changed();
    }
  }

  private static before(a: Action, b: Action): boolean {
    return a.t < b.t || (a.t === b.t && a.n < b.n);
  }

  private push(a: NewAction): void {
    const q = this.queue;
    const action = { ...a, n: this.seqN++ } as Action;
    let i = q.push(action) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!SimSource.before(action, q[up]!)) break;
      q[i] = q[up]!;
      i = up;
    }
    q[i] = action;
  }

  private pop(): Action {
    const q = this.queue;
    const top = q[0]!;
    const last = q.pop()!;
    if (q.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= q.length) break;
        const r = l + 1;
        const c = r < q.length && SimSource.before(q[r]!, q[l]!) ? r : l;
        if (!SimSource.before(q[c]!, last)) break;
        q[i] = q[c]!;
        i = c;
      }
      q[i] = last;
    }
    return top;
  }

  private run(a: Action): void {
    switch (a.kind) {
      case "open":
        return this.openTask(a.task, a.t);
      case "submit": {
        const task = this.tasks.get(a.task)!;
        if (task.status !== "open" || task.subs.has(a.wallet)) return;
        const code = deriveCode(task.secret, a.wallet);
        const answer = a.pass ? code : code.slice(0, 7) + (code[7] === "A" ? "E" : "A");
        this.acceptSubmission(task, a.wallet, answerHashBase64(answer, a.wallet), a.t);
        return;
      }
      case "finalize":
        return this.finalize(a.task, a.t);
      case "claim":
        this.claim(a.task, a.wallet, a.t);
        return;
      case "trade": {
        const h = this.holders.get(a.wallet);
        if (!h) return;
        if (a.balance > h.balance) h.lastReceivedAt = a.t;
        h.balance = a.balance;
        return;
      }
      case "income":
        return this.deposit(a.amount, "client_job", a.t);
    }
  }

  // ------------------------------------------------------------------ the company

  private amountFor(tier: 0 | 1 | 2 | 3, u: number): bigint {
    const th = BigInt(this.config.tier_thresholds_ppm[tier]);
    const mille = BigInt(Math.round((tier === 0 ? 1.02 + 0.2 * u : 1.05 + 0.55 * u) * 1000));
    return (SUPPLY * th * mille) / (BigInt(PPM) * 1000n);
  }

  private incomePerTask(): bigint {
    return (BigInt(Math.max(8, this.size)) * NEAR) / 12n;
  }

  private seedCompany(at: number): void {
    const n = this.size;
    const visitors = Math.max(1, Math.round(n * 0.1));
    // Small previews show every tier well; a big one looks like a real token: the upper tiers are
    // capped near what the supply allows (Directors ≤ 33 at 3%), so almost everyone is an Intern.
    const directors = Math.max(1, Math.min(20, Math.round(n * 0.08)));
    const managers = Math.max(1, Math.min(60, Math.round(n * 0.12)));
    const associates = Math.max(1, Math.min(320, Math.round(n * 0.25)));
    const interns = Math.max(1, n - visitors - directors - managers - associates);
    const roles: (0 | 1 | 2 | 3 | "v")[] = [];
    const counts: [0 | 1 | 2 | 3 | "v", number][] = [[0, directors], [1, managers], [2, associates], [3, interns], ["v", visitors]];
    // Interleave so behavior profiles (by index) land on every floor.
    const total = counts.reduce((a, [, c]) => a + c, 0);
    const slots = counts.flatMap(([r, c]) => Array.from({ length: c }, (_, j) => ({ r, key: (j + 0.5) / c })));
    slots.sort((a, b) => a.key - b.key || String(a.r).localeCompare(String(b.r)));
    for (const s of slots.slice(0, total)) roles.push(s.r);

    roles.forEach((role, i) => {
      const name = NAMES[i % NAMES.length]! + (i >= NAMES.length ? String(Math.floor(i / NAMES.length) + 1) : "");
      const wallet = `${name}.sim`;
      const u = unit(this.seed, wallet, "balance");
      const balance = role === "v" ? (this.amountFor(3, 0) * BigInt(30 + Math.floor(u * 50))) / 100n : this.amountFor(role, u);
      this.holders.set(wallet, { balance, lastReceivedAt: at });
      let profile: Profile = role === "v" ? "visitor" : (["reliable", "reliable", "flaky", "reliable", "flaky", "slacker", "reliable", "dumper"] as const)[i % 8]!;
      if (profile === "dumper" && i % 16 !== 7) profile = "flaky";
      if (role !== "v" && i % 12 === 11) profile = "newcomer";
      const startsAt = profile === "newcomer" ? 8 + (i % 3) : 1;
      const bot: Bot = { wallet, profile, startsAt };
      this.bots.push(bot);
      this.botOf.set(wallet, bot);
    });
    // Guarantee the cast every mechanic needs: at least one slacker (layoffs) and one dumper
    // (anti-dump forfeits), about one of each per 16 holders.
    const want = Math.max(1, Math.floor(n / 16));
    for (const p of ["dumper", "slacker"] as const) {
      let have = this.bots.filter((b) => b.profile === p).length;
      for (let i = this.bots.length - 1; i >= 0 && have < want; i--) {
        if (this.bots[i]!.profile === "flaky" || (p === "slacker" && this.bots[i]!.profile === "reliable")) {
          this.bots[i]!.profile = p;
          have++;
        }
      }
    }
    // The cyclers: one per 12 holders (at most 3), all Interns like wallet F, phased so the first
    // live finalize after the history lays the first one off and the next one rehires them.
    const history = this.historyTasks;
    const pool = this.bots.filter((b, i) => roles[i] === 3 && b.profile !== "dumper" && b.profile !== "newcomer");
    const cyclers = Math.min(3, Math.max(1, Math.floor(n / 12)), pool.length);
    for (let k = 0; k < cyclers; k++) {
      const bot = pool[pool.length - 1 - k * 2] ?? pool[k]!;
      bot.profile = "cycler";
      // Layoff at the finalize of task `history + 1 + 3k`: its phase is the third miss (index 3).
      bot.offset = (((3 - (history + 1 + 3 * k)) % CYCLE.length) + CYCLE.length) % CYCLE.length;
    }
    this.holders.set(MARKET, { balance: SUPPLY / 10n, lastReceivedAt: at });
  }

  private openTask(id: TaskId, at: number): void {
    const secret = sha256Bytes(new TextEncoder().encode(`${this.seed}:day:${id}`));
    const level = LEVELS[(id - 1) % LEVELS.length]!;
    const ciphers = LEVEL_CIPHERS[level];
    const wanted: PuzzleParams = { family: "decode-memo", cipher: ciphers[hash32(this.seed, id) % ciphers.length]!, level };
    const params = resolveDayParams(wanted, secret).params;
    const task: Task = {
      id,
      secret,
      params,
      text: OPEN_LINES[hash32(this.seed, "line", id) % OPEN_LINES.length]!,
      status: "open",
      opensAt: at,
      closesAt: at + this.window,
      subs: new Map(),
      order: [],
      submittedW: [0n, 0n, 0n, 0n],
      passedW: [0n, 0n, 0n, 0n],
      passed: 0,
      alloc: null,
      finalizedAt: null,
    };
    this.tasks.set(id, task);
    this.current = id;
    this.emit("task_opened", at, {
      task_id: id,
      kind: "decode_memo",
      commit_hash: toBase64(commitHash(secret)),
      opens_at: msToNs(at),
      closes_at: msToNs(task.closesAt),
    });
    this.feedLog.add({ id: `sim-open-${id}`, at, kind: "task", source: "template", taskId: id, text: `Day ${id}. ${task.text}` });

    // Bots decide, per (seed, wallet, day), whether and when to file and whether they are right.
    for (const bot of this.bots) {
      if (bot.profile === "visitor" || id < bot.startsAt) continue;
      if (bot.profile === "cycler") {
        if (CYCLE[(id + bot.offset!) % CYCLE.length] === "pass") {
          const when = at + this.window * (0.1 + 0.5 * unit(this.seed, bot.wallet, id, "when"));
          this.push({ t: when, kind: "submit", task: id, wallet: bot.wallet, pass: true });
        }
        continue;
      }
      const b = BEHAVIOR[bot.profile];
      const laidOff = this.statusOf(bot.wallet) === "laid_off";
      const pSubmit = laidOff ? (bot.profile === "slacker" ? 0.45 : 0.6) : b.submit;
      if (unit(this.seed, bot.wallet, id, "submit") >= pSubmit) continue;
      const when = at + this.window * (0.06 + 0.86 * unit(this.seed, bot.wallet, id, "when"));
      this.push({ t: when, kind: "submit", task: id, wallet: bot.wallet, pass: unit(this.seed, bot.wallet, id, "pass") < b.pass });
    }
    this.push({ t: task.closesAt + 2500, kind: "finalize", task: id });
    this.push({ t: at + this.epoch, kind: "open", task: id + 1 });
    this.push({ t: at + this.epoch * 0.85, kind: "income", amount: this.incomePerTask() });
    // Now and then a visitor buys in and arrives as a new hire (before the next opening).
    if (id % 4 === 0) {
      const visitor = this.bots.find((b) => b.profile === "visitor" && (this.holders.get(b.wallet)?.balance ?? 0n) < this.amountFor(3, 0));
      if (visitor) {
        visitor.profile = "newcomer";
        visitor.startsAt = id + 2;
        this.push({ t: at + this.epoch * 0.9, kind: "trade", wallet: visitor.wallet, balance: this.amountFor(3, unit(this.seed, visitor.wallet)) });
      }
    }
  }

  private acceptSubmission(task: Task, wallet: WalletId, answerHash: string, at: number): SubmitOutcome {
    const h = this.holders.get(wallet);
    const balance = h?.balance ?? 0n;
    if (h && h.lastReceivedAt >= task.opensAt) return { accepted: false, reason: "tokens received after the task opened (anti-recycling)" };
    const tier = tierOf(balance, SUPPLY, this.config.tier_thresholds_ppm);
    if (tier === null) return { accepted: false, reason: "balance below the minimum tier (visitor)" };
    let emp = this.employees.get(wallet);
    if (!emp) {
      emp = { joined_after: this.lastFinalized, last_pass_day: null, streak: 0, last_tier: tier, last_balance: balance, total_earned: 0n, badges: 0 };
      this.employees.set(wallet, emp);
    }
    const st = employeeState({ joined_after: emp.joined_after, last_pass_day: emp.last_pass_day, stored_streak: emp.streak }, this.lastFinalized, this.config.layoff_after, this.config.layoff_len);
    const reapply = st.laid_off;
    const mult = multiplierBps(st.effective_streak, this.config.streak_step_bps, this.config.streak_max_steps);
    const weight = balance * BigInt(mult);
    const sub: Sub = {
      account_id: wallet,
      answer_hash: answerHash,
      balance,
      tier,
      streak_before: st.effective_streak,
      multiplier_bps: mult,
      weight,
      submitted_at: at,
      reapply,
      passed: false,
      pay: 0n,
      claim: "unclaimed",
    };
    task.subs.set(wallet, sub);
    task.order.push(wallet);
    if (!reapply) task.submittedW[tier] += weight;
    emp.last_tier = tier;
    emp.last_balance = balance;
    this.emit("submission_received", at, { task_id: task.id, account_id: wallet, tier, balance: balance.toString(), weight: weight.toString(), reapply });
    return { accepted: true, reason: null };
  }

  private finalize(id: TaskId, at: number): void {
    const task = this.tasks.get(id)!;
    if (task.status !== "open") return;
    const before = new Map([...this.employees.keys()].map((w) => [w, this.statusOf(w)]));
    task.status = "finalizing";
    const c = this.config;
    const income = this.treasury.income_accrued;
    this.treasury.income_accrued = 0n;
    const payroll = (income * BigInt(c.payroll_bps)) / BigInt(BPS);
    const jackpot = (income * BigInt(c.jackpot_bps)) / BigInt(BPS);
    const buckets = c.tier_bucket_bps.map((b) => (payroll * BigInt(b)) / BigInt(BPS)) as Tuple4<bigint>;
    const payable: Tuple4<bigint> = [0n, 0n, 0n, 0n];

    // Verify every answer against the revealed secret, as the boss + contract would.
    const passers = task.order.filter((w) => {
      const s = task.subs.get(w)!;
      return s.answer_hash === answerHashBase64(deriveCode(task.secret, w), w);
    });
    for (const w of passers) {
      const s = task.subs.get(w)!;
      const emp = this.employees.get(w)!;
      s.passed = true;
      task.passed++;
      if (!s.reapply) {
        s.pay = task.submittedW[s.tier] > 0n ? (buckets[s.tier] * s.weight) / task.submittedW[s.tier] : 0n;
        payable[s.tier] += s.pay;
        task.passedW[s.tier] += s.weight;
      }
      if (emp.last_pass_day === null || emp.last_pass_day < id) {
        emp.streak = streakAfterPass(id, emp.last_pass_day, emp.streak);
        emp.last_pass_day = id;
        if (c.streak_milestones.includes(emp.streak)) this.emit("streak_milestone", at, { task_id: id, account_id: w, streak: emp.streak });
      }
      if (s.reapply) {
        emp.badges |= 1;
        this.emit("rehired", at, { task_id: id, account_id: w });
      }
    }
    const totalPayable = payable.reduce((a, b) => a + b, 0n);
    const toReserve = income - totalPayable;
    const reserveMid = this.treasury.reserve + toReserve;
    const op = BigInt(c.operating_cost) < reserveMid ? BigInt(c.operating_cost) : reserveMid;
    const reserveAfter = reserveMid - op;
    const runway = BigInt(c.operating_cost) > 0n ? Number(reserveAfter / BigInt(c.operating_cost)) : null;
    this.treasury.reserve = reserveAfter;
    this.treasury.outstanding += totalPayable;
    this.treasury.total_operating_cost += op;
    if (op > 0n) this.book({ at, kind: "operating", amount: op, simulated: true, taskId: id });
    const s = (x: bigint) => x.toString();
    task.alloc = {
      income: s(income),
      payroll: s(payroll),
      jackpot: s(jackpot),
      reserve_share: s(income - payroll - jackpot),
      buckets: buckets.map(s) as Tuple4<string>,
      payroll_dust: s(payroll - buckets.reduce((a, b) => a + b, 0n)),
      tier_payable: payable.map(s) as Tuple4<string>,
      settlement: { to_reserve: s(toReserve), operating_cost_paid: s(op), reserve_after: s(reserveAfter), runway_tasks: runway },
    };
    task.status = "finalized";
    task.finalizedAt = at;
    this.lastFinalized = id;
    this.emit("payroll_allocated", at, {
      task_id: id,
      income: s(income),
      payroll: s(payroll),
      jackpot: s(jackpot),
      reserve_share: s(income - payroll - jackpot),
      buckets: buckets.map(s) as Tuple4<string>,
      tier_payable: payable.map(s) as Tuple4<string>,
      to_reserve: s(toReserve),
      operating_cost_paid: s(op),
      reserve_after: s(reserveAfter),
      runway_tasks: runway,
    });
    this.emit("task_finalized", at, { task_id: id, day_secret: toBase64(task.secret), submitted: task.order.length, passed: task.passed });
    if (reserveAfter < BigInt(c.reserve_low)) this.emit("reserve_low", at, { task_id: id, reserve: s(reserveAfter), threshold: c.reserve_low });

    this.announceResults(task, at, before, totalPayable, passers.length);

    // Bots collect their pay a few seconds later; the dumper sells first and forfeits (anti-dump).
    for (const w of passers) {
      const sub = task.subs.get(w)!;
      if (sub.pay === 0n || w === SIM_PLAYER) continue;
      const bot = this.botOf.get(w);
      const t = at + 2000 + 10_000 * unit(this.seed, w, id, "claim");
      if (bot?.profile === "dumper") {
        // Sells a quarter before claiming (the claim forfeits), buys back before the next opening.
        const h = this.holders.get(w)!;
        this.push({ t: t - 1000, kind: "trade", wallet: w, balance: (h.balance * 3n) / 4n });
        this.push({ t: Math.max(t + 500, task.opensAt + this.epoch - 3000), kind: "trade", wallet: w, balance: h.balance });
      }
      this.push({ t, kind: "claim", task: id, wallet: w });
    }
  }

  private announceResults(task: Task, at: number, before: Map<WalletId, string>, payable: bigint, passed: number): void {
    const submitted = task.order.length;
    const rate = submitted ? passed / submitted : 0;
    const line =
      submitted === 0
        ? "Nobody filed anything. I will be scheduling a meeting about meetings."
        : rate >= 0.9
          ? "Great work, team. Synergy is up."
          : rate >= 0.5
            ? "Results are in. Most of you were aligned."
            : "Results are in. We will be discussing this at the offsite.";
    const items: FeedItem[] = [
      { id: `sim-res-${task.id}`, at, kind: "results", source: "template", taskId: task.id, text: `Day ${task.id}: ${passed} of ${submitted} passed. ${line}` },
    ];
    if (payable > 0n)
      items.push({ id: `sim-pay-${task.id}`, at: at + 1, kind: "payroll", source: "template", taskId: task.id, text: `Payday: ${payout(payable)} allocated to ${plural(passed, "passer")}. Claim it from your desk.` });
    for (const [w, was] of before) {
      const now = this.statusOf(w);
      const name = shortName(w);
      if (now === "laid_off" && was !== "laid_off")
        items.push({ id: `sim-lay-${task.id}-${w}`, at: at + 2, kind: "layoff", source: "template", wallet: w, taskId: task.id, text: `${name}: we are rebalancing our talent. Thank you for your service.` });
      else if (now === "active" && was === "laid_off")
        items.push({ id: `sim-reh-${task.id}-${w}`, at: at + 2, kind: "rehire", source: "template", wallet: w, taskId: task.id, text: `${name} is rehired. Welcome back. We never doubted you, officially.` });
      else if (now !== "laid_off") {
        const misses = this.employeeView(w).misses_in_row;
        if (misses === this.config.layoff_after - 1 && misses > 0)
          items.push({ id: `sim-warn-${task.id}-${w}`, at: at + 2, kind: "warning", source: "template", wallet: w, taskId: task.id, text: `${name} has missed ${misses} tasks in a row. One more and HR gets involved.` });
      }
    }
    for (const w of task.order) {
      const e = this.employees.get(w);
      if (e && e.last_pass_day === task.id && this.config.streak_milestones.includes(e.streak))
        items.push({ id: `sim-streak-${task.id}-${w}`, at: at + 3, kind: "streak", source: "template", wallet: w, taskId: task.id, text: `${shortName(w)} hit a ${e.streak}-day streak. Keep the synergy flowing.` });
    }
    this.feedLog.add(...items);
  }

  private claim(id: TaskId, wallet: WalletId, at = this.clock()): ClaimOutcome {
    const task = this.tasks.get(id);
    const s = task?.subs.get(wallet);
    if (!task || task.status !== "finalized") throw new Error("task is not finalized");
    if (!s || !s.passed || s.reapply || s.pay === 0n) throw new Error("nothing to claim for this task");
    if (s.claim !== "unclaimed") throw new Error("already claimed, pending or forfeited");
    const h = this.holders.get(wallet);
    const amount = s.pay.toString();
    this.treasury.outstanding -= s.pay;
    if (antidumpAllows(h?.balance ?? 0n, s.balance, this.config.antidump_bps)) {
      s.claim = "claimed";
      this.treasury.total_paid += s.pay;
      const emp = this.employees.get(wallet);
      if (emp) emp.total_earned += s.pay;
      this.book({ at, kind: "salary", amount: s.pay, simulated: true, wallet, taskId: id });
      this.emit("salary_paid", at, { task_id: id, account_id: wallet, amount });
      return { status: "paid", amount };
    }
    s.claim = "forfeited";
    this.treasury.reserve += s.pay;
    this.treasury.total_forfeited += s.pay;
    this.book({ at, kind: "forfeit", amount: s.pay, simulated: true, wallet, taskId: id });
    this.emit("salary_forfeited", at, { task_id: id, account_id: wallet, amount, snapshot_balance: s.balance.toString(), current_balance: (h?.balance ?? 0n).toString() });
    return { status: "forfeited", amount };
  }

  private deposit(amount: bigint, tag: IncomeTag, at: number): void {
    this.treasury.income_accrued += amount;
    this.treasury.total_income += amount;
    this.treasury.income_by_tag[tag] += amount;
    this.book({ at, kind: "income", amount, tag, simulated: true });
    this.emit("income_deposited", at, { from: "income-bot.sim", amount: amount.toString(), tag });
  }

  private emit<N extends ReorgEvent["event"]>(event: N, at: number, data: Extract<ReorgEvent, { event: N }>["data"]): void {
    const e = { seq: ++this.eventSeq, at: msToNs(at), event, data } as ReorgEvent;
    const f = feedFromEvent(e, { bossCovers: true, nowMs: at });
    if (f) this.feedBuf.push(f);
    if (this.replaying) return;
    for (const fn of this.eventListeners) fn(e);
  }

  /** Newest first, the last 200 rows (a big company's payday is thousands of claims). */
  private book(row: LedgerRow): void {
    this.ledgerRows.unshift(row);
    if (this.ledgerRows.length > 200) this.ledgerRows.length = 200;
  }

  private flushFeed(): void {
    if (this.feedBuf.length === 0) return;
    const items = this.feedBuf;
    this.feedBuf = [];
    // In chunks: a spread of 100k arguments overflows the stack.
    for (let i = 0; i < items.length; i += 2000) this.feedLog.add(...items.slice(i, i + 2000));
  }

  private changed(): void {
    this.flushFeed();
    this.dirty = true;
    if (this.replaying) return;
    const snap = this.snapshot();
    for (const fn of this.snapListeners) fn(snap);
  }

  // ------------------------------------------------------------------ views

  private statusOf(wallet: WalletId): EmployeeView["status"] | "none" {
    const e = this.employees.get(wallet);
    if (!e) return "none";
    return employeeState({ joined_after: e.joined_after, last_pass_day: e.last_pass_day, stored_streak: e.streak }, this.lastFinalized, this.config.layoff_after, this.config.layoff_len).status;
  }

  private employeeView(wallet: WalletId): EmployeeView {
    const e = this.employees.get(wallet)!;
    const st = employeeState({ joined_after: e.joined_after, last_pass_day: e.last_pass_day, stored_streak: e.streak }, this.lastFinalized, this.config.layoff_after, this.config.layoff_len);
    const recent: RecentResult[] = [];
    for (let t = this.current; t > e.joined_after && recent.length < 7; t--) {
      const s = this.tasks.get(t)?.subs.get(wallet);
      const finalized = t <= this.lastFinalized;
      if (s?.passed) recent.push({ task_id: t, result: "pass" });
      else if (s) recent.push({ task_id: t, result: finalized ? "fail" : "pending" });
      else if (finalized) recent.push({ task_id: t, result: "miss" });
    }
    return {
      account_id: wallet,
      joined_after: e.joined_after,
      last_pass_day: e.last_pass_day,
      stored_streak: e.streak,
      effective_streak: st.effective_streak,
      gap: st.gap,
      status: st.status,
      misses_in_row: st.misses_in_row,
      layoff_tasks_left: st.layoff_tasks_left,
      last_tier: e.last_tier,
      last_balance: e.last_balance.toString(),
      total_earned: e.total_earned.toString(),
      badges: e.badges,
      recent,
    };
  }

  private subView(taskId: TaskId, s: Sub): SubmissionView {
    return {
      task_id: taskId,
      account_id: s.account_id,
      answer_hash: s.answer_hash,
      balance: s.balance.toString(),
      tier: s.tier,
      streak_before: s.streak_before,
      multiplier_bps: s.multiplier_bps,
      weight: s.weight.toString(),
      submitted_at: msToNs(s.submitted_at),
      reapply: s.reapply,
      passed: s.passed,
      pay: s.pay.toString(),
      claim: s.claim,
    };
  }

  private taskView(t: Task): TaskView {
    return {
      id: t.id,
      kind: "decode_memo",
      status: t.status,
      commit_hash: toBase64(commitHash(t.secret)),
      opens_at: msToNs(t.opensAt),
      closes_at: msToNs(t.closesAt),
      day_secret: t.status === "open" ? null : toBase64(t.secret),
      submitted: t.order.length,
      passed: t.passed,
      tier_submitted_weight: t.submittedW.map(String) as Tuple4<string>,
      tier_passed_weight: t.passedW.map(String) as Tuple4<string>,
      allocation: t.alloc,
      finalized_at: t.finalizedAt === null ? null : msToNs(t.finalizedAt),
    };
  }

  private buildSnapshot(): Snapshot {
    const task = this.tasks.get(this.current) ?? null;
    const holders: HolderEntry[] = [...this.holders].map(([account_id, h]) => ({
      account_id,
      balance: h.balance.toString(),
      last_received_at: msToNs(h.lastReceivedAt),
    }));
    const tr = this.treasury;
    const op = BigInt(this.config.operating_cost);
    const treasury: TreasuryView = {
      reserve: tr.reserve.toString(),
      income_accrued: tr.income_accrued.toString(),
      outstanding: tr.outstanding.toString(),
      total_income: tr.total_income.toString(),
      income_by_tag: { client_job: tr.income_by_tag.client_job.toString(), fee_share: tr.income_by_tag.fee_share.toString(), seed: tr.income_by_tag.seed.toString() },
      total_paid: tr.total_paid.toString(),
      total_forfeited: tr.total_forfeited.toString(),
      total_operating_cost: tr.total_operating_cost.toString(),
      operating_cost: this.config.operating_cost,
      runway_tasks: op > 0n ? Number(tr.reserve / op) : null,
    };
    const boss: BossTask | null = task
      ? { task_id: task.id, cipher_label: task.params.cipher, level: task.params.level, task_text: task.text, written_by: "template", warmup: false }
      : null;
    const nextOpen = this.queue.reduce<Action | undefined>((m, a) => (a.kind === "open" && (!m || SimSource.before(a, m)) ? a : m), undefined);
    return {
      kind: "sim",
      network: "simulated",
      config: this.config,
      totalSupply: SUPPLY,
      lastFinalized: this.lastFinalized,
      task: task ? this.taskView(task) : null,
      submissions: task ? task.order.map((w) => this.subView(task.id, task.subs.get(w)!)) : [],
      lastFinalizedTask: this.lastFinalized ? this.taskView(this.tasks.get(this.lastFinalized)!) : null,
      holders,
      employees: [...this.employees.keys()].map((w) => this.employeeView(w)),
      treasury,
      boss,
      stalled: false,
      isCrowd: (w) => w !== SIM_PLAYER,
      stale: false,
      nextOpenAt: nextOpen ? nextOpen.t : null,
    };
  }
}

/** The sim's own wallet: badge in as a simulated Intern and play the preview's days. */
export class SimWallet implements WalletAdapter {
  readonly label = "Simulated player";
  readonly burner = true;
  private id: WalletId | null = null;

  constructor(private readonly sim: SimSource) {}

  accountId(): WalletId | null {
    return this.id;
  }

  async restore(): Promise<WalletId | null> {
    return null;
  }

  async connect(): Promise<WalletId> {
    this.id = this.sim.joinPlayer();
    return this.id;
  }

  async disconnect(): Promise<void> {
    this.id = null;
  }

  async submit(taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome> {
    if (!this.id) throw new Error("not connected");
    return this.sim.submitAs(this.id, taskId, answerHashB64);
  }

  async claimSalary(taskId: TaskId): Promise<ClaimOutcome> {
    if (!this.id) throw new Error("not connected");
    return this.sim.claimAs(this.id, taskId);
  }
}

/** For tests and the HUD: when a sim task's window ends. */
export const simClosesAt = (t: TaskView): number => nsToMs(t.closes_at);
