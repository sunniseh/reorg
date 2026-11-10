// D-04 checks over plain contract views, chain-agnostic and pure (unit-tested in test/checks.test.ts).
// Each returns a list of problems; empty means the check holds.
//   - checkTaskPay: every payout of a finalized task equals the core pay-math mirror (§7.3, D1).
//   - checkBooks: the treasury balances to the yoctoNEAR against its own totals and the event log.
import {
  payShare,
  startAllocation,
  toReserve,
  type ContractConfig,
  type ReorgEvent,
  type SubmissionView,
  type TaskView,
  type TreasuryView,
  type Tuple4,
} from "@reorg/core";

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const str4 = (xs: readonly bigint[]) => xs.map(String).join(",");

/** Recomputes a finalized task's allocation and every submission's pay from its submissions. */
export function checkTaskPay(
  task: TaskView,
  subs: readonly SubmissionView[],
  cfg: Pick<ContractConfig, "payroll_bps" | "jackpot_bps" | "tier_bucket_bps">,
): string[] {
  const p: string[] = [];
  const at = `task ${task.id}`;
  if (task.status !== "finalized") return [`${at}: not finalized (${task.status})`];
  const alloc = task.allocation;
  if (!alloc?.settlement) return [`${at}: no settled allocation`];
  if (subs.length !== task.submitted) p.push(`${at}: ${subs.length} submissions listed, task says ${task.submitted}`);
  const passed = subs.filter((s) => s.passed).length;
  if (passed !== task.passed) p.push(`${at}: ${passed} passers listed, task says ${task.passed}`);

  const start = startAllocation(BigInt(alloc.income), cfg);
  const fields = ["payroll", "jackpot", "reserve_share", "payroll_dust"] as const;
  for (const f of fields) if (start[f] !== BigInt(alloc[f])) p.push(`${at}: ${f} ${alloc[f]} ≠ mirror ${start[f]}`);
  if (str4(start.buckets) !== alloc.buckets.join(",")) p.push(`${at}: buckets ${alloc.buckets} ≠ mirror ${str4(start.buckets)}`);

  const submittedW: Tuple4<bigint> = [0n, 0n, 0n, 0n];
  for (const s of subs) if (!s.reapply) submittedW[s.tier] += BigInt(s.weight);
  if (str4(submittedW) !== task.tier_submitted_weight.join(",")) p.push(`${at}: tier_submitted_weight ≠ the sum of submissions`);

  const payable: Tuple4<bigint> = [0n, 0n, 0n, 0n];
  for (const s of subs) {
    const want = s.passed && !s.reapply ? payShare(start.buckets[s.tier], BigInt(s.weight), submittedW[s.tier]) : 0n;
    payable[s.tier] += want;
    if (BigInt(s.pay) !== want) p.push(`${at}: ${s.account_id} paid ${s.pay}, mirror says ${want}`);
  }
  if (str4(payable) !== alloc.tier_payable.join(",")) p.push(`${at}: tier_payable ${alloc.tier_payable} ≠ mirror ${str4(payable)}`);
  const reserve = toReserve(start, payable);
  if (reserve !== BigInt(alloc.settlement.to_reserve)) p.push(`${at}: to_reserve ${alloc.settlement.to_reserve} ≠ mirror ${reserve}`);
  return p;
}

export interface BookFacts {
  /** Every income deposit the demo made (seed + income bot), in yoctoNEAR. */
  deposited: bigint;
  /** Every submission of every task so far (for outstanding and paid totals). */
  submissions: readonly SubmissionView[];
  /** The full event log since the contract was created. */
  events: readonly ReorgEvent[];
}

/**
 * Income = reserve + not-yet-allocated income + allocated-but-unclaimed + paid + operating cost,
 * exactly; and each total equals what the event log and the submissions say.
 */
export function checkBooks(t: TreasuryView, facts: BookFacts): string[] {
  const p: string[] = [];
  const n = (x: string) => BigInt(x);
  const held = n(t.reserve) + n(t.income_accrued) + n(t.outstanding) + n(t.total_paid) + n(t.total_operating_cost);
  if (held !== n(t.total_income)) p.push(`books: income ${t.total_income} ≠ reserve + accrued + outstanding + paid + operating cost (${held})`);
  const byTag = sum(Object.values(t.income_by_tag).map(n));
  if (byTag !== n(t.total_income)) p.push(`books: income by tag sums to ${byTag}, total is ${t.total_income}`);
  if (facts.deposited !== n(t.total_income)) p.push(`books: the demo deposited ${facts.deposited}, the contract counts ${t.total_income}`);

  const amounts = (name: "income_deposited" | "salary_paid" | "salary_forfeited") =>
    sum(facts.events.flatMap((e) => (e.event === name ? [n(e.data.amount)] : [])));
  if (amounts("income_deposited") !== n(t.total_income)) p.push(`books: income_deposited events sum to ${amounts("income_deposited")}`);
  if (amounts("salary_paid") !== n(t.total_paid)) p.push(`books: salary_paid events sum to ${amounts("salary_paid")}, total_paid is ${t.total_paid}`);
  if (amounts("salary_forfeited") !== n(t.total_forfeited)) {
    p.push(`books: salary_forfeited events sum to ${amounts("salary_forfeited")}, total_forfeited is ${t.total_forfeited}`);
  }
  const opCost = sum(facts.events.flatMap((e) => (e.event === "payroll_allocated" ? [n(e.data.operating_cost_paid)] : [])));
  if (opCost !== n(t.total_operating_cost)) p.push(`books: operating cost in payroll_allocated events sums to ${opCost}, total is ${t.total_operating_cost}`);

  const owed = sum(facts.submissions.filter((s) => s.claim === "unclaimed" || s.claim === "pending").map((s) => n(s.pay)));
  if (owed !== n(t.outstanding)) p.push(`books: unclaimed pay sums to ${owed}, outstanding is ${t.outstanding}`);
  const paid = sum(facts.submissions.filter((s) => s.claim === "claimed").map((s) => n(s.pay)));
  if (paid !== n(t.total_paid)) p.push(`books: claimed pay sums to ${paid}, total_paid is ${t.total_paid}`);
  return p;
}
