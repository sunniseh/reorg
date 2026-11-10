/**
 * Tier of a balance (PROTOCOL.md §6.1, D12). Same integer comparison as the contract:
 * smallest k with `balance × PPM ≥ thresholds[k] × totalSupply`, else visitor (`null`).
 */
import type { TierIndex } from "./abi";
import { PPM } from "./config";

export function tierOf(balance: bigint, totalSupply: bigint, thresholdsPpm: readonly number[]): TierIndex | null {
  if (totalSupply <= 0n) return null;
  const lhs = balance * BigInt(PPM);
  for (let k = 0; k < 4; k++) {
    if (lhs >= BigInt(thresholdsPpm[k]!) * totalSupply) return k as TierIndex;
  }
  return null;
}
