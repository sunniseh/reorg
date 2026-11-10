// D-02 crowd runner and D-08 income bot, chain-agnostic: the boss over HTTP, the chain through a
// read interface, transactions through `CrowdSigner` / `DemoOperator` (packages/core/src/chain.ts).
// Every decision comes from `crowdDecision(member, task_id, seed)`, so a run is reproducible;
// submissions land at seeded times across the window, claims follow the finalize. SIMULATED.
import {
  answerHashBase64,
  crowdDecision,
  crowdRandom,
  solvePuzzle,
  type CrowdDecision,
  type CrowdMember,
  type CrowdSigner,
  type DemoOperator,
  type SubmissionView,
  type TaskId,
  type TaskView,
  type WalletId,
} from "@reorg/core";

/** The slice of the boss's `GET /api/task/current` the runner reads. */
export interface CurrentTask {
  task_id: number;
  status: "open" | "closed" | "finalizing" | "finalized";
  warmup: boolean;
  opens_at: string | null;
  closes_at: string | null;
}

export interface PuzzleView {
  task_id: number;
  display: string;
  hint: string;
}

export interface BossClient {
  /** The newest opened task, or null before the first. */
  current(): Promise<CurrentTask | null>;
  puzzle(wallet: WalletId): Promise<PuzzleView>;
}

export interface CrowdReader {
  getTask(taskId: TaskId): Promise<TaskView | null>;
  getSubmission(taskId: TaskId, wallet: WalletId): Promise<SubmissionView | null>;
}

export interface RunnerOptions {
  boss: BossClient;
  reader: CrowdReader;
  signer: CrowdSigner;
  /** Income bot and the dumper's market; null turns both off. */
  operator: DemoOperator | null;
  members: readonly CrowdMember[];
  seed: string;
  /** yoctoNEAR deposited (tag client_job) once per opened task; 0 turns the income bot off. */
  incomePerTask: bigint;
  pollMs?: number;
  log?: (msg: string) => void;
}

export interface RunnerStats {
  /** Sum of successful income deposits (the e2e check balances the books against it). */
  income: bigint;
  submitted: number;
  rejected: number;
  paid: number;
  forfeited: number;
  dumps: number;
  errors: number;
}

/** The dumper sells this share of its tokens after submitting: below the 90% anti-dump line. */
export const DUMP_PERCENT = 12n;
const NS_PER_MS = 1_000_000n;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

/** A wrong answer in the right format: the last vowel changes. */
export function wrongAnswer(answer: string): string {
  return `${answer.slice(0, -1)}${answer.endsWith("A") ? "E" : "A"}`;
}

export class CrowdRunner {
  readonly stats: RunnerStats = { income: 0n, submitted: 0, rejected: 0, paid: 0, forfeited: 0, dumps: 0, errors: 0 };
  private readonly planned = new Set<TaskId>();
  /** Accepted submissions per task, until their claims are scheduled. */
  private readonly filed = new Map<TaskId, Map<number, CrowdDecision>>();
  /** Tokens each dumper sold and the operator still has to sell back. */
  private readonly sold = new Map<number, bigint>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RunnerOptions) {
    this.log = opts.log ?? (() => {});
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.fail("runner", e);
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs ?? 1000);
        this.wake = () => (clearTimeout(t), resolve());
      });
    }
  }

  /** Stops scheduling and waits for transactions already sent. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.wake?.();
    await Promise.allSettled([...this.inflight]);
  }

  /** One poll: plan a newly opened task, schedule claims for finalized ones. */
  async tick(): Promise<void> {
    const cur = await this.opts.boss.current();
    if (!cur) return;
    if (cur.status === "open" && !this.planned.has(cur.task_id)) this.plan(cur);
    for (const taskId of [...this.filed.keys()]) {
      if (taskId > cur.task_id || (taskId === cur.task_id && cur.status !== "finalized")) continue;
      const task = await this.opts.reader.getTask(taskId);
      if (task?.status !== "finalized") continue;
      const members = this.filed.get(taskId)!;
      this.filed.delete(taskId);
      for (const index of members.keys()) {
        const delay = 1000 + 5000 * crowdRandom(this.opts.seed, index, taskId, "claim");
        this.later(() => this.track(this.claim(index, taskId)), delay);
      }
    }
  }

  private plan(cur: CurrentTask): void {
    this.planned.add(cur.task_id);
    const { operator, incomePerTask } = this.opts;
    if (operator && incomePerTask > 0n) {
      this.track(
        operator.depositIncome(incomePerTask, "client_job").then(
          () => void (this.stats.income += incomePerTask),
          (e) => this.fail(`income deposit for task ${cur.task_id}`, e),
        ),
      );
    }
    const opens = cur.opens_at ? Number(BigInt(cur.opens_at) / NS_PER_MS) : Date.now();
    const closes = cur.closes_at ? Number(BigInt(cur.closes_at) / NS_PER_MS) : opens;
    for (const m of this.opts.members) {
      const d = crowdDecision(m, cur.task_id, this.opts.seed, cur.warmup);
      if (d.action === "skip") continue;
      const due = opens + d.at * (closes - opens);
      this.later(() => this.track(this.file(m, cur.task_id, d)), Math.max(0, due - Date.now()));
    }
  }

  private async file(m: CrowdMember, taskId: TaskId, d: CrowdDecision): Promise<void> {
    const { signer, operator } = this.opts;
    const wallet = signer.accountId(m.index);
    try {
      const p = await this.opts.boss.puzzle(wallet);
      if (p.task_id !== taskId) return;
      const [answer] = solvePuzzle("decode-memo", p.display, p.hint);
      if (!answer) throw new Error(`no answer found for task ${taskId}`);
      const filed = d.action === "pass" ? answer : wrongAnswer(answer);
      const out = await signer.submit(m.index, taskId, answerHashBase64(filed, wallet));
      if (!out.accepted) {
        this.stats.rejected++;
        this.log(`${wallet} task ${taskId} rejected: ${out.reason}`);
        return;
      }
      this.stats.submitted++;
      if (!this.filed.has(taskId)) this.filed.set(taskId, new Map());
      this.filed.get(taskId)!.set(m.index, d);
      if (d.dump && operator) {
        const amount = (m.amount * DUMP_PERCENT) / 100n;
        await signer.sendTokens(m.index, operator.accountId, amount);
        this.sold.set(m.index, (this.sold.get(m.index) ?? 0n) + amount);
        this.stats.dumps++;
        this.log(`${wallet} sold ${DUMP_PERCENT}% of its tokens after submitting task ${taskId} (its claim will forfeit)`);
      }
    } catch (e) {
      this.fail(`${wallet} task ${taskId}`, e);
    }
  }

  private async claim(index: number, taskId: TaskId): Promise<void> {
    const { signer, operator } = this.opts;
    const wallet = signer.accountId(index);
    try {
      const s = await this.opts.reader.getSubmission(taskId, wallet);
      if (s?.passed && !s.reapply && s.pay !== "0" && s.claim === "unclaimed") {
        const out = await signer.claimSalary(index, taskId);
        if (out.status === "paid") this.stats.paid++;
        else if (out.status === "forfeited") {
          this.stats.forfeited++;
          this.log(`${wallet} claim for task ${taskId} forfeited (anti-dump)`);
        } else this.log(`${wallet} claim for task ${taskId}: retry (${out.reason})`);
      }
    } catch (e) {
      this.fail(`${wallet} claim ${taskId}`, e);
    }
    const amount = this.sold.get(index);
    if (amount && operator) {
      this.sold.delete(index);
      await operator.sendTokens(wallet, amount).catch((e) => {
        this.sold.set(index, amount);
        this.fail(`buy-back for ${wallet}`, e);
      });
    }
  }

  private fail(what: string, e: unknown): void {
    this.stats.errors++;
    this.log(`${what}: ${errMsg(e)}`);
  }

  private later(fn: () => void, ms: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }
}

/** `BossClient` over the boss's HTTP API (apps/boss/README.md). */
export function httpBoss(baseUrl: string): BossClient {
  const base = baseUrl.replace(/\/$/, "");
  const get = async <T>(path: string, nullOn404 = false): Promise<T | null> => {
    const res = await fetch(`${base}${path}`);
    if (res.status === 404 && nullOn404) return null;
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`boss ${path}: ${res.status} ${body.error ?? ""}`.trim());
    return body;
  };
  return {
    current: () => get<CurrentTask>("/api/task/current", true),
    puzzle: async (wallet) => (await get<PuzzleView>(`/api/puzzle?wallet=${encodeURIComponent(wallet)}`))!,
  };
}
