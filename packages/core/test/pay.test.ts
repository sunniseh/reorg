// PROTOCOL.md §7.3 / D1 in TS must reproduce the `pay` section of protocol/vectors.json (the Rust
// core runs the same file), so the D-04 end-to-end check can recompute every on-chain payout.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { payShare, startAllocation, toReserve, type Tuple4 } from "../src";

const vectors = JSON.parse(readFileSync(new URL("../../../protocol/vectors.json", import.meta.url), "utf8"));

interface PaySub {
  account_id: string;
  tier: number;
  weight: string;
  passed: boolean;
  reapply: boolean;
}
interface PayCase {
  name: string;
  config: { payroll_bps: number; jackpot_bps: number; tier_bucket_bps: Tuple4<number> };
  submissions: PaySub[];
  expected: Record<string, unknown> & { pays: { account_id: string; pay: string }[] };
}

const big4 = (xs: unknown) => (xs as string[]).map(BigInt) as Tuple4<bigint>;

describe("pay math (§7.3, D1)", () => {
  it.each(vectors.pay as PayCase[])("$name", (v) => {
    const e = v.expected;
    const start = startAllocation(BigInt(e["income"] as string), v.config);
    expect(start.payroll).toBe(BigInt(e["payroll"] as string));
    expect(start.jackpot).toBe(BigInt(e["jackpot"] as string));
    expect(start.reserve_share).toBe(BigInt(e["reserve_share"] as string));
    expect(start.buckets).toEqual(big4(e["buckets"]));
    expect(start.payroll_dust).toBe(BigInt(e["payroll_dust"] as string));

    const submitted: Tuple4<bigint> = [0n, 0n, 0n, 0n];
    for (const s of v.submissions) if (!s.reapply) submitted[s.tier] = submitted[s.tier]! + BigInt(s.weight);
    expect(submitted).toEqual(big4(e["tier_submitted_weight"]));

    const payable: Tuple4<bigint> = [0n, 0n, 0n, 0n];
    const pays = new Map<string, bigint>();
    for (const s of v.submissions) {
      const pay = s.passed && !s.reapply ? payShare(start.buckets[s.tier]!, BigInt(s.weight), submitted[s.tier]!) : 0n;
      payable[s.tier] = payable[s.tier]! + pay;
      pays.set(s.account_id, pay);
    }
    expect(payable).toEqual(big4(e["tier_payable"]));
    for (const p of e.pays) expect(pays.get(p.account_id), p.account_id).toBe(BigInt(p.pay));
    expect(toReserve(start, payable)).toBe(BigInt(e["to_reserve"] as string));
  });

  it("pays nothing from an empty tier", () => expect(payShare(10n, 0n, 0n)).toBe(0n));
});
