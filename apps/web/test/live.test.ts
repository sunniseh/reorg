import {
  ConfigSchema,
  type ContractInfo,
  type EmployeeView,
  type HolderEntry,
  type ReorgEvent,
  type SubmissionView,
  type TaskView,
  type TowerReader,
  type TreasuryView,
} from "@reorg/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import defaultConfig from "../../../protocol/config.default.json";
import { LiveSource } from "../src/state/live";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
const INTERN = ((SUPPLY * 6n) / 10_000n).toString();

function task(id: number, status: TaskView["status"]): TaskView {
  return {
    id, kind: "decode_memo", status, commit_hash: "A".repeat(43) + "=", opens_at: "1", closes_at: "2", day_secret: null,
    submitted: 1, passed: status === "finalized" ? 1 : 0, tier_submitted_weight: ["0", "0", "0", "0"], tier_passed_weight: ["0", "0", "0", "0"],
    allocation: null, finalized_at: null,
  };
}

function sub(taskId: number, account_id: string, over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    task_id: taskId, account_id, answer_hash: "x", balance: INTERN, tier: 3, streak_before: 0, multiplier_bps: 10000, weight: "1",
    submitted_at: "1", reapply: false, passed: true, pay: "1000", claim: "unclaimed", ...over,
  };
}

class FakeReader implements TowerReader {
  info: ContractInfo = { owner: "o", boss: "b", token: "t", total_supply: SUPPLY.toString(), current_task_id: 2, last_finalized: 2, event_seq: 3, employees: 1 };
  tasks = new Map<number, TaskView>([[1, task(1, "finalized")], [2, task(2, "finalized")]]);
  holders: HolderEntry[] = [
    { account_id: "me.test", balance: INTERN, last_received_at: "0" },
    { account_id: "c001.crowd.test", balance: INTERN, last_received_at: "0" },
  ];
  employees: EmployeeView[] = [
    {
      account_id: "me.test", joined_after: 0, last_pass_day: 2, stored_streak: 2, effective_streak: 2, gap: 0, status: "active",
      misses_in_row: 0, layoff_tasks_left: 0, last_tier: 3, last_balance: INTERN, total_earned: "0", badges: 0,
      recent: [{ task_id: 2, result: "pass" }, { task_id: 1, result: "pass" }],
    },
  ];
  subs = new Map<string, SubmissionView>([["1|me.test", sub(1, "me.test", { claim: "claimed" })], ["2|me.test", sub(2, "me.test")]]);
  events: ReorgEvent[] = [
    { seq: 1, at: "1000000000", event: "income_deposited", data: { from: "bot", amount: "5", tag: "client_job" } },
    { seq: 2, at: "1000000000", event: "salary_paid", data: { task_id: 1, account_id: "me.test", amount: "1000" } },
    { seq: 3, at: "1000000000", event: "income_deposited", data: { from: "bot", amount: "7", tag: "fee_share" } },
  ];
  fail = false;
  calls = 0;
  private guard() {
    this.calls++;
    if (this.fail) throw new Error("rpc down");
  }
  async now() { return BigInt(Date.now() + 5000) * 1_000_000n; }
  async getInfo() { this.guard(); return { ...this.info }; }
  async getConfig() { this.guard(); return ConfigSchema.parse(defaultConfig); }
  async getTask(id: number) { this.guard(); return this.tasks.get(id) ?? null; }
  async listSubmissions(id: number, from: number, limit: number) {
    this.guard();
    return [...this.subs.values()].filter((s) => s.task_id === id).slice(from, from + limit);
  }
  async listEmployees(from: number, limit: number) { this.guard(); return this.employees.slice(from, from + limit); }
  async getTreasury(): Promise<TreasuryView> {
    this.guard();
    return {
      reserve: "10", income_accrued: "0", outstanding: "0", total_income: "12", income_by_tag: { client_job: "5", fee_share: "7", seed: "0" },
      total_paid: "1000", total_forfeited: "0", total_operating_cost: "0", operating_cost: "0", runway_tasks: null,
    };
  }
  async getEvents(since: number, limit: number) { this.guard(); return this.events.filter((e) => e.seq > since).slice(0, limit); }
  async listHolders(from: number, limit: number) { this.guard(); return this.holders.slice(from, from + limit); }
  async holderInfo(w: string) { this.guard(); const h = this.holders.find((x) => x.account_id === w); return { balance: h?.balance ?? "0", last_received_at: "0" }; }
  async getEmployee(w: string) { this.guard(); return this.employees.find((e) => e.account_id === w) ?? null; }
  async getSubmission(id: number, w: string) { this.guard(); return this.subs.get(`${id}|${w}`) ?? null; }
}

let src: LiveSource | null = null;
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] }));
afterEach(() => {
  src?.stop();
  src = null;
  vi.useRealTimers();
});

async function boot(r: FakeReader) {
  src = new LiveSource({ reader: r, boss: null, network: "sandbox", crowdRoot: "crowd.test", pollMs: 1000, fullRefreshMs: 10_000, staleAfterMs: 3000 });
  const events: string[] = [];
  src.onEvent((e) => events.push(e.event));
  src.start();
  await vi.advanceTimersByTimeAsync(10);
  return { src, events };
}

describe("LiveSource (W-12)", () => {
  it("reads every view into one snapshot; history fills the feed and ledger but never animates", async () => {
    const r = new FakeReader();
    const { src, events } = await boot(r);
    const s = src.snapshot()!;
    expect(s.task?.id).toBe(2);
    expect(s.holders).toHaveLength(2);
    expect(s.isCrowd("c001.crowd.test")).toBe(true);
    expect(s.isCrowd("me.test")).toBe(false);
    expect(events).toEqual([]);
    expect(src.ledger().map((l) => [l.kind, l.simulated])).toEqual(expect.arrayContaining([["income", true], ["income", false], ["salary", false]]));
    expect(src.feed().length).toBeGreaterThan(0);
    // Clock corrected from the block timestamp (+5 s in the fake).
    expect(src.now() - Date.now()).toBeGreaterThan(4000);
  });

  it("delivers only newer events, then re-reads the views once", async () => {
    const r = new FakeReader();
    const { src, events } = await boot(r);
    const snaps: number[] = [];
    src.onSnapshot((s) => snaps.push(s.task?.id ?? 0));
    r.info = { ...r.info, current_task_id: 3, event_seq: 4 };
    r.tasks.set(3, task(3, "open"));
    r.events.push({ seq: 4, at: "2000000000", event: "task_opened", data: { task_id: 3, kind: "decode_memo", commit_hash: "A".repeat(43) + "=", opens_at: "1", closes_at: "9" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(["task_opened"]);
    expect(snaps.at(-1)).toBe(3);
  });

  it("marks the snapshot stale when reads keep failing, and recovers", async () => {
    const r = new FakeReader();
    const { src } = await boot(r);
    r.fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(src.snapshot()!.stale).toBe(true);
    r.fail = false;
    await vi.advanceTimersByTimeAsync(10_500);
    expect(src.snapshot()!.stale).toBe(false);
  });

  it("finds the player's unclaimed pay on recent passed days", async () => {
    const r = new FakeReader();
    const { src } = await boot(r);
    const p = await src.player("me.test");
    expect(p.claimables.map((c) => c.task_id)).toEqual([2]);
    expect(p.submission?.task_id).toBe(2);
    expect(p.employee?.effective_streak).toBe(2);
  });
});
