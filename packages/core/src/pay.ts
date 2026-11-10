/**
 * Pay math mirror (PROTOCOL.md §7.3, D1): the same integer steps as `reorg-core` (`rules.rs`,
 * `Allocation::start`, `pay_share`, `to_reserve`), tested against the `pay` section of
 * protocol/vectors.json. BigInt is arbitrary precision, so the contract's U256 intermediates
 * need no special handling here. Used by the end-to-end check (D-04) to recompute every payout.
 */
import type { Tuple4 } from "./abi";
import { BPS, type ContractConfig } from "./config";

export interface AllocationStart {
  income: bigint;
  payroll: bigint;
  jackpot: bigint;
  reserve_share: bigint;
  buckets: Tuple4<bigint>;
  payroll_dust: bigint;
}

type PayConfig = Pick<ContractConfig, "payroll_bps" | "jackpot_bps" | "tier_bucket_bps">;

const bps = (x: bigint, b: number) => (x * BigInt(b)) / BigInt(BPS);

/** First finalize call: split the income snapshot into payroll buckets, jackpot and reserve share. */
export function startAllocation(income: bigint, cfg: PayConfig): AllocationStart {
  const payroll = bps(income, cfg.payroll_bps);
  const jackpot = bps(income, cfg.jackpot_bps);
  const buckets = cfg.tier_bucket_bps.map((b) => bps(payroll, b)) as Tuple4<bigint>;
  return {
    income,
    payroll,
    jackpot,
    reserve_share: income - payroll - jackpot,
    buckets,
    payroll_dust: payroll - buckets.reduce((a, b) => a + b, 0n),
  };
}

/** D1: a passer's pay, `bucket × weight / submitted_weight`, floored. Zero when nobody submitted. */
export function payShare(bucket: bigint, weight: bigint, submittedWeight: bigint): bigint {
  return submittedWeight === 0n ? 0n : (bucket * weight) / submittedWeight;
}

/** What the last finalize call moves into the reserve: everything not payable. */
export function toReserve(start: AllocationStart, tierPayable: Tuple4<bigint>): bigint {
  const unpaid = start.buckets.reduce((a, b, i) => a + (b - tierPayable[i]!), 0n);
  return start.reserve_share + start.jackpot + start.payroll_dust + unpaid;
}
