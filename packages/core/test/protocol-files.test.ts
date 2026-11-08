// Phase 0 checks: the protocol files parse against the core schemas and agree with each other.
// Crypto/pay-math conformance against vectors.json lands with B-01 (core/crypto) and C-08 (Rust).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, ConfigSchema, EVENT_NAMES, ReorgEventSchema, type ContractConfig } from "../src";

const root = new URL("../../../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const defaults: ContractConfig = readJson("protocol/config.default.json");
const vectors = readJson("protocol/vectors.json");

describe("config (P-04)", () => {
  it("default config validates", () => {
    expect(ConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("default config file has exactly the schema keys", () => {
    expect(Object.keys(defaults).sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it("vectors were generated from the current default config", () => {
    expect(vectors.config).toEqual(defaults);
  });

  it.each([
    ["bucket shares not summing to 10000", { tier_bucket_bps: [3500, 3000, 2000, 1000] }],
    ["split not summing to 10000", { jackpot_bps: 0 }],
    ["thresholds not descending", { tier_thresholds_bps: [300, 300, 25, 5] }],
    ["zero threshold", { tier_thresholds_bps: [300, 100, 25, 0] }],
    ["bps above 10000", { antidump_bps: 10_001 }],
    ["layoff_after zero", { layoff_after: 0 }],
    ["milestones not ascending", { streak_milestones: [7, 3] }],
    ["zero window", { min_window_ns: "0" }],
    ["u128 as number", { operating_cost: 1 }],
    ["unknown key", { epoch_ns: "1" }],
  ])("rejects %s", (_name, patch) => {
    expect(ConfigSchema.safeParse({ ...defaults, ...patch }).success).toBe(false);
  });
});

describe("events (P-03)", () => {
  const c = vectors.crypto[0];
  const alloc = vectors.pay[2].expected;
  const samples: Record<string, unknown> = {
    task_opened: { task_id: 1, kind: "decode_memo", commit_hash: c.commit_hash_b64, opens_at: "1", closes_at: "2" },
    submission_received: { task_id: 1, account_id: c.wallet, tier: 3, balance: "5", weight: "50000", reapply: false },
    task_finalized: { task_id: 1, day_secret: c.day_secret_b64, submitted: 3, passed: 2 },
    payroll_allocated: {
      task_id: 1,
      income: alloc.income,
      payroll: alloc.payroll,
      jackpot: alloc.jackpot,
      reserve_share: alloc.reserve_share,
      buckets: alloc.buckets,
      tier_payable: alloc.tier_payable,
      to_reserve: alloc.to_reserve,
      operating_cost_paid: alloc.operating_cost_paid,
      reserve_after: alloc.reserve_after,
      runway_tasks: alloc.runway_tasks,
    },
    salary_paid: { task_id: 1, account_id: "a.testnet", amount: "1" },
    salary_forfeited: { task_id: 1, account_id: "a.testnet", amount: "1", snapshot_balance: "10", current_balance: "8" },
    income_deposited: { from: "a.testnet", amount: "1", tag: "client_job" },
    streak_milestone: { task_id: 1, account_id: "a.testnet", streak: 3 },
    rehired: { task_id: 5, account_id: "a.testnet" },
    reserve_low: { task_id: 1, reserve: "1", threshold: "2" },
  };

  it("has a sample for every event", () => {
    expect(Object.keys(samples).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it.each(EVENT_NAMES)("%s parses", (name) => {
    const parsed = ReorgEventSchema.parse({ seq: 1, at: "1700000000000000000", event: name, data: samples[name] });
    expect(parsed.event).toBe(name);
  });

  it("rejects unknown events, missing fields, extra fields and numeric u128", () => {
    const ok = { seq: 1, at: "1", event: "rehired", data: { task_id: 1, account_id: "a" } };
    expect(ReorgEventSchema.safeParse(ok).success).toBe(true);
    expect(ReorgEventSchema.safeParse({ ...ok, event: "laid_off" }).success).toBe(false);
    expect(ReorgEventSchema.safeParse({ ...ok, data: { task_id: 1 } }).success).toBe(false);
    expect(ReorgEventSchema.safeParse({ ...ok, data: { ...ok.data, x: 1 } }).success).toBe(false);
    const paid = { seq: 2, at: "1", event: "salary_paid", data: { task_id: 1, account_id: "a", amount: 1 } };
    expect(ReorgEventSchema.safeParse(paid).success).toBe(false);
  });
});

describe("vectors.json shape (P-02)", () => {
  it("has the sections PROTOCOL.md §9 promises", () => {
    for (const key of [
      "hmac_sha256", "crypto", "wallet_binding", "normalization", "tier", "multiplier",
      "layoff", "status", "streak_update", "antidump", "recycle", "pay",
    ]) {
      expect(vectors, key).toHaveProperty(key);
    }
    expect(vectors.crypto.length).toBeGreaterThanOrEqual(10);
    const gaps = vectors.layoff.filter((l: { layoff_len: number }) => l.layoff_len === 7).map((l: { gap: number }) => l.gap);
    expect(gaps).toEqual(expect.arrayContaining([0, 2, 3, 9, 10, 12, 13, 19, 20]));
  });

  it("pay vectors conserve income exactly", () => {
    for (const p of vectors.pay) {
      const e = p.expected;
      const paid = e.tier_payable.reduce((a: bigint, x: string) => a + BigInt(x), 0n);
      expect(paid + BigInt(e.to_reserve), p.name).toBe(BigInt(e.income));
    }
  });
});
