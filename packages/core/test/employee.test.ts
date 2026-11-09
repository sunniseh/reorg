// PROTOCOL.md §6.3–§6.4 in TS must reproduce protocol/vectors.json (the Rust core uses the same file).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { employeeState, fromBase64, layoffState, multiplierBps, streakAfterPass, toBase64 } from "../src";

const vectors = JSON.parse(readFileSync(new URL("../../../protocol/vectors.json", import.meta.url), "utf8"));
const cfg = vectors.config as { layoff_after: number; layoff_len: number; streak_step_bps: number; streak_max_steps: number };

describe("layoffState (D5)", () => {
  it.each(vectors.layoff as Record<string, number | string | boolean>[])("A=$layoff_after L=$layoff_len gap=$gap", (v) => {
    const s = layoffState(v["gap"] as number, v["layoff_after"] as number, v["layoff_len"] as number);
    expect(s).toEqual({
      laid_off: v["laid_off"],
      status: v["status"],
      misses_in_row: v["misses_in_row"],
      layoff_tasks_left: v["layoff_tasks_left"],
    });
  });
});

describe("employeeState (§6.3 + §6.4)", () => {
  it.each(vectors.status as Record<string, unknown>[])("$note", (v) => {
    const s = employeeState(
      {
        joined_after: v["joined_after"] as number,
        last_pass_day: v["last_pass_day"] as number | null,
        stored_streak: v["stored_streak"] as number,
      },
      v["last_finalized"] as number,
      cfg.layoff_after,
      cfg.layoff_len,
    );
    for (const k of ["gap", "status", "laid_off", "layoff_tasks_left", "misses_in_row", "effective_streak"] as const) {
      expect(s[k], k).toEqual(v[k]);
    }
  });
});

describe("streak rules (D6)", () => {
  it.each(vectors.multiplier as { streak_before: number; multiplier_bps: number }[])("multiplier($streak_before)", (v) => {
    expect(multiplierBps(v.streak_before, cfg.streak_step_bps, cfg.streak_max_steps)).toBe(v.multiplier_bps);
  });
  it.each(vectors.streak_update as { task_id: number; last_pass_day: number | null; stored_streak: number; new_streak: number; note: string }[])(
    "$note",
    (v) => {
      expect(streakAfterPass(v.task_id, v.last_pass_day, v.stored_streak)).toBe(v.new_streak);
    },
  );
});

describe("base64 wire encoding (§11)", () => {
  it("matches the vectors' base64 for every 32-byte value", () => {
    for (const c of vectors.crypto as { answer_hash_b64: string; answer_hash_hex: string }[]) {
      const bytes = Uint8Array.from(Buffer.from(c.answer_hash_hex, "hex"));
      expect(toBase64(bytes)).toBe(c.answer_hash_b64);
      expect(fromBase64(c.answer_hash_b64)).toEqual(bytes);
    }
  });
  it("round-trips every length and rejects garbage", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
    for (const bad of ["abc", "####", "QQ=", "QQ==="]) expect(() => fromBase64(bad), bad).toThrow();
  });
});
