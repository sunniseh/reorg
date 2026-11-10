// In-memory ChainAdapter for scheduler tests. Mirrors the contract rules the boss depends on
// (reorg-core engine: open, submit, begin_finalize, verify_passer, settle; D5 status; events),
// with simplified pay math (the real math is tested in Rust against the vectors). Calls can be
// made to fail before they apply, or after they apply with the response lost.
import {
  answerHashBase64,
  commitHash,
  deriveCode,
  employeeState,
  fromBase64,
  multiplierBps,
  streakAfterPass,
  toBase64,
  type ChainAdapter,
  type ContractConfig,
  type ContractInfo,
  type EmployeeView,
  type FinalizeTaskArgs,
  type OpenTaskArgs,
  type ReorgEvent,
  type SubmissionView,
  type TaskId,
  type TaskView,
  type TreasuryView,
} from "@reorg/core";

export type FaultMode = "before" | "after";
type Method = "openTask" | "finalizeTask" | "getTask" | "listSubmissions" | "getInfo";

interface Task {
  id: number;
  commit: string;
  opens_at: bigint;
  closes_at: bigint;
  status: "open" | "finalizing" | "finalized";
  secret: string | null;
  submitted: number;
  passed: number;
  finalized_at: bigint | null;
}

interface Sub {
  account: string;
  hash: string;
  weight: bigint;
  streak_before: number;
  multiplier: number;
  reapply: boolean;
  passed: boolean;
  at: bigint;
}

interface Emp {
  joined_after: number;
  last_pass_day: number | null;
  streak: number;
}

export function testConfig(over: Partial<ContractConfig> = {}): ContractConfig {
  return {
    tier_thresholds_ppm: [30_000, 10_000, 2_500, 10],
    tier_bucket_bps: [3500, 3000, 2000, 1500],
    payroll_bps: 6000,
    reserve_bps: 3000,
    jackpot_bps: 1000,
    streak_step_bps: 1000,
    streak_max_steps: 5,
    streak_milestones: [3, 7, 14],
    layoff_after: 3,
    layoff_len: 7,
    antidump_bps: 9000,
    bankruptcy_empty_tasks: 3,
    operating_cost: "0",
    reserve_low: "0",
    min_window_ns: "1000000000",
    max_passers_per_call: 50,
    excluded_accounts: [],
    ...over,
  };
}

const panic = (msg: string): never => {
  throw new Error(`Smart contract panicked: ${msg}`);
};

export class FakeChain implements ChainAdapter {
  readonly bossId = "boss.test";
  config: ContractConfig;
  tasks = new Map<number, Task>();
  subs = new Map<number, Sub[]>();
  employees = new Map<string, Emp>();
  events: ReorgEvent[] = [];
  current = 0;
  lastFinalized = 0;
  income = 10n ** 24n;
  reserve = 0n;
  /** Calls that took effect, for assertions. */
  applied: { method: "openTask" | "finalizeTask"; args: OpenTaskArgs | FinalizeTaskArgs }[] = [];
  /** Called after a task opens (tests submit from here). */
  onOpen: ((task: TaskView) => void) | null = null;
  private faults: { method: Method; mode: FaultMode; error: string; count: number }[] = [];

  constructor(
    private readonly clockMs: () => number,
    config: Partial<ContractConfig> = {},
  ) {
    this.config = testConfig(config);
  }

  /** The next `count` calls to `method` fail; `after` = the call applies but the caller sees an error. */
  fail(method: Method, mode: FaultMode = "before", count = 1, error = `injected ${method} failure`): void {
    this.faults.push({ method, mode, error, count });
  }

  private fault(method: Method, mode: FaultMode): void {
    const f = this.faults.find((x) => x.method === method && x.mode === mode && x.count > 0);
    if (!f) return;
    f.count--;
    throw new Error(f.error);
  }

  private nowNs(): bigint {
    return BigInt(this.clockMs()) * 1_000_000n;
  }

  private emit(event: ReorgEvent["event"], data: Record<string, unknown>): void {
    this.events.push({ seq: this.events.length + 1, at: this.nowNs().toString(), event, data } as ReorgEvent);
  }

  // ---------------------------------------------------------------- views

  async now(): Promise<bigint> {
    return this.nowNs();
  }

  async getInfo(): Promise<ContractInfo> {
    this.fault("getInfo", "before");
    return {
      owner: "owner.test",
      boss: this.bossId,
      token: "token.test",
      total_supply: "1000000000",
      current_task_id: this.current,
      last_finalized: this.lastFinalized,
      event_seq: this.events.length,
      employees: this.employees.size,
    };
  }

  async getConfig(): Promise<ContractConfig> {
    return structuredClone(this.config);
  }

  private view(t: Task): TaskView {
    return {
      id: t.id,
      kind: "decode_memo",
      status: t.status === "open" && this.nowNs() >= t.closes_at ? "closed" : t.status,
      commit_hash: t.commit,
      opens_at: t.opens_at.toString(),
      closes_at: t.closes_at.toString(),
      day_secret: t.secret,
      submitted: t.submitted,
      passed: t.passed,
      tier_submitted_weight: ["0", "0", "0", "0"],
      tier_passed_weight: ["0", "0", "0", "0"],
      allocation: null,
      finalized_at: t.finalized_at?.toString() ?? null,
    };
  }

  async getTask(taskId: TaskId): Promise<TaskView | null> {
    this.fault("getTask", "before");
    const t = this.tasks.get(taskId);
    return t ? this.view(t) : null;
  }

  async listSubmissions(taskId: TaskId, fromIndex: number, limit: number): Promise<SubmissionView[]> {
    this.fault("listSubmissions", "before");
    return (this.subs.get(taskId) ?? []).slice(fromIndex, fromIndex + Math.min(limit, 100)).map((s) => ({
      task_id: taskId,
      account_id: s.account,
      answer_hash: s.hash,
      balance: "1000",
      tier: 3,
      streak_before: s.streak_before,
      multiplier_bps: s.multiplier,
      weight: s.weight.toString(),
      submitted_at: s.at.toString(),
      reapply: s.reapply,
      passed: s.passed,
      pay: "0",
      claim: "unclaimed",
    }));
  }

  employeeView(account: string): EmployeeView {
    const e = this.employees.get(account)!;
    const st = employeeState(
      { joined_after: e.joined_after, last_pass_day: e.last_pass_day, stored_streak: e.streak },
      this.lastFinalized,
      this.config.layoff_after,
      this.config.layoff_len,
    );
    return {
      account_id: account,
      joined_after: e.joined_after,
      last_pass_day: e.last_pass_day,
      stored_streak: e.streak,
      effective_streak: st.effective_streak,
      gap: st.gap,
      status: st.status,
      misses_in_row: st.misses_in_row,
      layoff_tasks_left: st.layoff_tasks_left,
      last_tier: 3,
      last_balance: "1000",
      total_earned: "0",
      badges: 0,
      recent: [],
    };
  }

  async listEmployees(fromIndex: number, limit: number): Promise<EmployeeView[]> {
    return [...this.employees.keys()].slice(fromIndex, fromIndex + Math.min(limit, 100)).map((a) => this.employeeView(a));
  }

  async getTreasury(): Promise<TreasuryView> {
    return {
      reserve: this.reserve.toString(),
      income_accrued: this.income.toString(),
      outstanding: "0",
      total_income: "0",
      income_by_tag: { client_job: "0", fee_share: "0", seed: "0" },
      total_paid: "0",
      total_forfeited: "0",
      total_operating_cost: "0",
      operating_cost: this.config.operating_cost,
      runway_tasks: null,
    };
  }

  async getEvents(sinceSeq: number, limit: number): Promise<ReorgEvent[]> {
    return this.events.slice(sinceSeq, sinceSeq + Math.min(limit, 100));
  }

  // ---------------------------------------------------------------- player side (tests)

  /** The right answer for `account` under a base64 day secret. */
  static codeFor(secretB64: string, account: string): string {
    return deriveCode(fromBase64(secretB64), account);
  }

  /** A wallet submits `answer` for task `taskId`. Returns the contract's rejection reason, or null. */
  submit(account: string, taskId: number, answer: string): string | null {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "open") return "task is not open";
    if (this.nowNs() >= t.closes_at) return "submission window is closed";
    const list = this.subs.get(taskId) ?? [];
    if (list.some((s) => s.account === account)) return "already submitted for this task";
    let emp = this.employees.get(account);
    if (!emp) {
      emp = { joined_after: this.lastFinalized, last_pass_day: null, streak: 0 };
      this.employees.set(account, emp);
    }
    const st = employeeState(
      { joined_after: emp.joined_after, last_pass_day: emp.last_pass_day, stored_streak: emp.streak },
      this.lastFinalized,
      this.config.layoff_after,
      this.config.layoff_len,
    );
    const multiplier = multiplierBps(st.effective_streak, this.config.streak_step_bps, this.config.streak_max_steps);
    list.push({
      account,
      hash: answerHashBase64(answer, account),
      weight: 1000n * BigInt(multiplier),
      streak_before: st.effective_streak,
      multiplier,
      reapply: st.laid_off,
      passed: false,
      at: this.nowNs(),
    });
    this.subs.set(taskId, list);
    t.submitted++;
    this.emit("submission_received", { task_id: taskId, account_id: account, tier: 3, balance: "1000", weight: "1000", reapply: st.laid_off });
    return null;
  }

  // ---------------------------------------------------------------- boss calls

  async openTask(args: OpenTaskArgs): Promise<TaskId> {
    this.fault("openTask", "before");
    if (this.current !== this.lastFinalized) panic("previous task is not finalized");
    const now = this.nowNs();
    const closes = BigInt(args.closes_at);
    if (closes <= now || closes - now < BigInt(this.config.min_window_ns)) panic("closes_at is too soon (min_window_ns)");
    const id = ++this.current;
    this.tasks.set(id, { id, commit: args.commit_hash, opens_at: now, closes_at: closes, status: "open", secret: null, submitted: 0, passed: 0, finalized_at: null });
    this.applied.push({ method: "openTask", args });
    this.emit("task_opened", { task_id: id, kind: "decode_memo", commit_hash: args.commit_hash, opens_at: now.toString(), closes_at: args.closes_at });
    this.onOpen?.(this.view(this.tasks.get(id)!));
    this.fault("openTask", "after");
    return id;
  }

  async finalizeTask(args: FinalizeTaskArgs): Promise<void> {
    this.fault("finalizeTask", "before");
    if (args.passers.length > this.config.max_passers_per_call) panic("too many passers in one call (max_passers_per_call)");
    const t = this.tasks.get(args.task_id) ?? panic("task not found");
    if (t.status === "finalized") panic("task already finalized");
    if (t.status === "finalizing" && t.secret !== args.day_secret) panic("day_secret differs from the revealed secret");
    if (t.status === "open") {
      if (this.nowNs() < t.closes_at) panic("task window has not closed yet");
      if (toBase64(commitHash(fromBase64(args.day_secret))) !== t.commit) panic("day_secret does not match the commit");
    }
    // Validate every passer before mutating anything (a panic reverts the whole call).
    const subs = this.subs.get(t.id) ?? [];
    const seen = new Set<string>();
    const secret = fromBase64(args.day_secret);
    for (const p of args.passers) {
      const s = subs.find((x) => x.account === p) ?? panic(`no submission for this account: ${p}`);
      if (s.passed || seen.has(p)) panic(`passer already verified: ${p}`);
      if (s.hash !== answerHashBase64(deriveCode(secret, p), p)) panic(`answer hash does not match: ${p}`);
      seen.add(p);
    }
    if (t.status === "open") {
      t.status = "finalizing";
      t.secret = args.day_secret;
    }
    for (const p of args.passers) {
      const s = subs.find((x) => x.account === p)!;
      s.passed = true;
      t.passed++;
      const e = this.employees.get(p)!;
      if (e.last_pass_day === null || e.last_pass_day < t.id) {
        e.streak = streakAfterPass(t.id, e.last_pass_day, e.streak);
        e.last_pass_day = t.id;
        if (this.config.streak_milestones.includes(e.streak)) this.emit("streak_milestone", { task_id: t.id, account_id: p, streak: e.streak });
      }
      if (s.reapply) this.emit("rehired", { task_id: t.id, account_id: p });
    }
    if (args.last) {
      t.status = "finalized";
      t.finalized_at = this.nowNs();
      this.lastFinalized = t.id;
      const payroll = t.passed > 0 ? (this.income * 6000n) / 10000n : 0n;
      this.reserve += this.income - payroll;
      this.emit("task_finalized", { task_id: t.id, day_secret: args.day_secret, submitted: t.submitted, passed: t.passed });
      this.emit("payroll_allocated", {
        task_id: t.id,
        income: this.income.toString(),
        payroll: ((this.income * 6000n) / 10000n).toString(),
        jackpot: "0",
        reserve_share: "0",
        buckets: ["0", "0", "0", "0"],
        tier_payable: ["0", "0", "0", payroll.toString()],
        to_reserve: (this.income - payroll).toString(),
        operating_cost_paid: "0",
        reserve_after: this.reserve.toString(),
        runway_tasks: null,
      });
    }
    this.applied.push({ method: "finalizeTask", args });
    this.fault("finalizeTask", "after");
  }
}
