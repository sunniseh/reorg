// D-04 checks on synthetic contract views: a consistent task and treasury pass; one wrong yoctoNEAR
// anywhere is reported. The task is the spec §5.3 example from protocol/vectors.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReorgEvent, SubmissionView, TaskView, TreasuryView, Tuple4 } from "@reorg/core";
import { checkBooks, checkTaskPay } from "../src/checks";

const vectors = JSON.parse(readFileSync(new URL("../../../protocol/vectors.json", import.meta.url), "utf8"));
const v = (vectors.pay as { name: string }[]).find((x) => x.name === "spec-5.3-second-fails") as unknown as {
  config: { payroll_bps: number; jackpot_bps: number; tier_bucket_bps: Tuple4<number> };
  submissions: { account_id: string; tier: 0 | 1 | 2 | 3; balance: string; weight: string; passed: boolean; reapply: boolean }[];
  expected: {
    income: string;
    payroll: string;
    jackpot: string;
    reserve_share: string;
    payroll_dust: string;
    to_reserve: string;
    buckets: Tuple4<string>;
    tier_payable: Tuple4<string>;
    tier_submitted_weight: Tuple4<string>;
    tier_passed_weight: Tuple4<string>;
    pays: { account_id: string; pay: string }[];
  };
};
const e = v.expected;

function fixture() {
  const subs: SubmissionView[] = v.submissions.map((s) => ({
    task_id: 1,
    account_id: s.account_id,
    answer_hash: "",
    balance: s.balance,
    tier: s.tier,
    streak_before: 0,
    multiplier_bps: 10000,
    weight: s.weight,
    submitted_at: "0",
    reapply: s.reapply,
    passed: s.passed,
    pay: e.pays.find((p) => p.account_id === s.account_id)?.pay ?? "0",
    claim: "unclaimed",
  }));
  const task: TaskView = {
    id: 1,
    kind: "decode_memo",
    status: "finalized",
    commit_hash: "",
    opens_at: "0",
    closes_at: "0",
    day_secret: null,
    submitted: subs.length,
    passed: subs.filter((s) => s.passed).length,
    tier_submitted_weight: e.tier_submitted_weight,
    tier_passed_weight: e.tier_passed_weight,
    allocation: {
      income: e.income,
      payroll: e.payroll,
      jackpot: e.jackpot,
      reserve_share: e.reserve_share,
      buckets: e.buckets,
      payroll_dust: e.payroll_dust,
      tier_payable: e.tier_payable,
      settlement: { to_reserve: e.to_reserve, operating_cost_paid: "0", reserve_after: e.to_reserve, runway_tasks: null },
    },
    finalized_at: "1",
  };
  return { task, subs };
}

describe("checkTaskPay", () => {
  it("accepts the spec §5.3 task", () => {
    const { task, subs } = fixture();
    expect(checkTaskPay(task, subs, v.config)).toEqual([]);
  });

  it("reports a payout one yoctoNEAR off, and a wrong reserve split", () => {
    const { task, subs } = fixture();
    const paid = subs.find((s) => s.pay !== "0")!;
    paid.pay = (BigInt(paid.pay) + 1n).toString();
    expect(checkTaskPay(task, subs, v.config).join("\n")).toMatch(new RegExp(`${paid.account_id} paid`));
    const t2 = fixture();
    t2.task.allocation!.settlement!.to_reserve = "1";
    expect(checkTaskPay(t2.task, t2.subs, v.config).join("\n")).toMatch(/to_reserve/);
  });
});

describe("checkBooks", () => {
  // 10 in (seed 4 + client_job 6): 3 paid, 2 owed, 1 operating cost, 4 in the reserve.
  const treasury: TreasuryView = {
    reserve: "4",
    income_accrued: "0",
    outstanding: "2",
    total_income: "10",
    income_by_tag: { client_job: "6", fee_share: "0", seed: "4" },
    total_paid: "3",
    total_forfeited: "1",
    total_operating_cost: "1",
    operating_cost: "1",
    runway_tasks: 4,
  };
  const sub = (account_id: string, pay: string, claim: SubmissionView["claim"]) => ({ account_id, pay, claim }) as SubmissionView;
  const submissions = [sub("a", "3", "claimed"), sub("b", "2", "unclaimed"), sub("c", "1", "forfeited")];
  const ev = (event: string, data: object, seq: number) => ({ seq, at: "0", event, data }) as unknown as ReorgEvent;
  const events = [
    ev("income_deposited", { from: "x", amount: "4", tag: "seed" }, 1),
    ev("income_deposited", { from: "x", amount: "6", tag: "client_job" }, 2),
    ev("payroll_allocated", { task_id: 1, operating_cost_paid: "1" }, 3),
    ev("salary_paid", { task_id: 1, account_id: "a", amount: "3" }, 4),
    ev("salary_forfeited", { task_id: 1, account_id: "c", amount: "1" }, 5),
  ];

  it("balances", () => expect(checkBooks(treasury, { deposited: 10n, submissions, events })).toEqual([]));

  it("reports a missing yoctoNEAR, a deposit the contract didn't count, and unrecorded pay", () => {
    expect(checkBooks({ ...treasury, reserve: "3" }, { deposited: 10n, submissions, events })[0]).toMatch(/reserve \+ accrued/);
    expect(checkBooks(treasury, { deposited: 11n, submissions, events }).join()).toMatch(/deposited 11/);
    expect(checkBooks(treasury, { deposited: 10n, submissions: submissions.slice(1), events }).join()).toMatch(/claimed pay/);
    expect(checkBooks(treasury, { deposited: 10n, submissions, events: events.slice(0, 3) }).join()).toMatch(/salary_paid/);
  });
});
