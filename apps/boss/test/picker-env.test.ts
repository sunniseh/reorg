// B-10: picker rules and environment parsing.
import { describe, expect, it } from "vitest";
import { LEVEL_CIPHERS, type Level, type PuzzleParams } from "@reorg/core";
import { loadEnv } from "../src/env";
import { DEFAULT_PICKER, parseFixedSchedule, parseLevelSchedule, pickLevel, pickParams, type PickerConfig } from "../src/picker";

const prev = (level: Level, submitted: number | null, passed: number | null) => ({
  params: { family: "decode-memo" as const, cipher: LEVEL_CIPHERS[level][0]!, level },
  submitted,
  passed,
});

describe("pickParams", () => {
  it("is deterministic and only picks shipped (cipher, level) pairs", () => {
    for (let slot = 1; slot <= 50; slot++) {
      const a = pickParams({ slot, warmup: false, previous: null }, DEFAULT_PICKER);
      expect(pickParams({ slot, warmup: false, previous: null }, DEFAULT_PICKER)).toEqual(a);
      expect(LEVEL_CIPHERS[a.level]).toContain(a.cipher);
    }
  });

  it("follows the weekly level rhythm and never repeats yesterday's cipher", () => {
    let last: PuzzleParams | null = null;
    for (let slot = 1; slot <= 28; slot++) {
      const p: PuzzleParams = pickParams({ slot, warmup: false, previous: last ? { params: last, submitted: null, passed: null } : null }, DEFAULT_PICKER);
      expect(p.level).toBe(DEFAULT_PICKER.levelSchedule[(slot - 1) % 7]);
      if (last) expect(p.cipher).not.toBe(last.cipher);
      last = p;
    }
  });

  it("warm-up is always level 1", () => {
    expect(pickParams({ slot: 6, warmup: true, previous: null }, DEFAULT_PICKER).level).toBe(1);
  });

  it("auto difficulty: thresholds are strict and the level is clamped to 1..5", () => {
    const auto: PickerConfig = { ...DEFAULT_PICKER, levelMode: "auto", levelSchedule: [3] };
    const ctx = (p: ReturnType<typeof prev>) => ({ slot: 9, warmup: false, previous: p });
    expect(pickLevel(ctx(prev(3, 10, 10)), auto)).toBe(4);
    expect(pickLevel(ctx(prev(3, 10, 9)), auto)).toBe(3); // exactly 90% is not "more than 90%"
    expect(pickLevel(ctx(prev(3, 10, 5)), auto)).toBe(3); // exactly 50% is not "fewer than 50%"
    expect(pickLevel(ctx(prev(3, 10, 4)), auto)).toBe(2);
    expect(pickLevel(ctx(prev(5, 4, 4)), auto)).toBe(5);
    expect(pickLevel(ctx(prev(1, 4, 0)), auto)).toBe(1);
    expect(pickLevel(ctx(prev(4, 0, 0)), auto)).toBe(4); // nobody played: keep the level
    expect(pickLevel(ctx(prev(4, null, null)), auto)).toBe(4); // not finalized yet
    expect(pickLevel({ slot: 1, warmup: false, previous: null }, auto)).toBe(3);
  });

  it("parses schedules and rejects combinations that don't ship", () => {
    expect(parseFixedSchedule("caesar:1, a1z26:2")).toEqual([
      { family: "decode-memo", cipher: "caesar", level: 1 },
      { family: "decode-memo", cipher: "a1z26", level: 2 },
    ]);
    expect(parseFixedSchedule("  ")).toEqual([]);
    expect(() => parseFixedSchedule("morse:1")).toThrow(/not a shipped/);
    expect(() => parseFixedSchedule("nope:3")).toThrow();
    expect(parseLevelSchedule("1,2, 5")).toEqual([1, 2, 5]);
    expect(() => parseLevelSchedule("0,6")).toThrow();
  });
});

describe("loadEnv", () => {
  const base = {
    NEAR_RPC_URL: "http://127.0.0.1:3030",
    REORG_CONTRACT_ID: "reorg.test.near",
    BOSS_ACCOUNT_ID: "boss.test.near",
    BOSS_PRIVATE_KEY: "ed25519:fake-key-for-tests",
  };

  it("applies defaults and treats empty strings as unset", () => {
    const e = loadEnv({ ...base, EPOCH_SECONDS: "", WEB_ORIGIN: "http://a, http://b" });
    expect(e.scheduler.epochMs).toBe(86_400_000);
    expect(e.scheduler.windowFraction).toBe(0.75);
    expect(e.scheduler.lookahead).toBe(7);
    expect(e.origins).toEqual(["http://a", "http://b"]);
    expect(e.llm).toBeNull();
    expect(e.network).toBe("sandbox");
  });

  it("reads the demo settings (D11: 75 s epoch, 50 s window, warm-up)", () => {
    const e = loadEnv({ ...base, EPOCH_SECONDS: "75", WINDOW_FRACTION: "0.6667", WARMUP_TASKS: "3", WARMUP_WINDOW_SECONDS: "10", PUZZLE_SCHEDULE: "caesar:1" });
    expect(e.scheduler.epochMs).toBe(75_000);
    expect(Math.round((e.scheduler.epochMs * e.scheduler.windowFraction) / 1000)).toBe(50);
    expect(e.scheduler.warmupTasks).toBe(3);
    expect(e.scheduler.picker.fixedSchedule).toHaveLength(1);
  });

  it("rejects bad values without echoing them", () => {
    expect(() => loadEnv({ ...base, BOSS_PRIVATE_KEY: "hunter2-not-a-key" })).toThrow(/BOSS_PRIVATE_KEY/);
    expect(() => loadEnv({ ...base, BOSS_PRIVATE_KEY: "hunter2-not-a-key" })).not.toThrow(/hunter2/);
    expect(() => loadEnv({ ...base, WINDOW_FRACTION: "1.5" })).toThrow(/WINDOW_FRACTION/);
    expect(() => loadEnv({ ...base, NETWORK: "mainnet" })).toThrow(/NETWORK/);
    expect(() => loadEnv({ BOSS_PRIVATE_KEY: base.BOSS_PRIVATE_KEY })).toThrow(/NEAR_RPC_URL/);
  });

  it("needs all three NEAR AI variables or none", () => {
    expect(() => loadEnv({ ...base, NEAR_AI_API_KEY: "k" })).toThrow(/NEAR_AI/);
    const e = loadEnv({ ...base, NEAR_AI_API_KEY: "k", NEAR_AI_BASE_URL: "https://llm.test/v1", NEAR_AI_MODEL: "m" });
    expect(e.llm).toEqual({ apiKey: "k", baseUrl: "https://llm.test/v1", model: "m" });
  });
});
