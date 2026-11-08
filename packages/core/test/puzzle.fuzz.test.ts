// B-04 fuzz gate (roadmap §6.1): every shipped (cipher, level) must pass selfCheck for thousands
// of seeds. A non-unique answer, a money word or an over-budget puzzle fails the build, so a bad
// day can never reach production. Scale up locally with FUZZ_SECRETS=500.
import { describe, expect, it } from "vitest";
import {
  deriveCode,
  FALLBACK_PARAMS,
  LEVEL_CIPHERS,
  MEMO_VOCABULARY,
  SELF_CHECK_WALLETS,
  decodeMemoFamily,
  generatePuzzle,
  containsMoneyWord,
  estimateSolveSeconds,
  resolveDayParams,
  selfCheck,
  selfCheckFamily,
  sha256Bytes,
  type GeneratedPuzzle,
  type Level,
  type PuzzleFamily,
  type PuzzleParams,
} from "../src";

const SECRETS = Number(process.env["FUZZ_SECRETS"] ?? 40);
const LEVELS: Level[] = [1, 2, 3, 4, 5];
const enc = new TextEncoder();
const secretFor = (tag: string) => sha256Bytes(enc.encode(tag));
const CODE_RE = /(?<![A-Z])(?:[BDFGKLMNPRSTVZ][AEIOU]){4}(?![A-Z])/;

describe("self-check fuzz: every shipped (cipher, level)", () => {
  for (const level of LEVELS) {
    for (const cipher of LEVEL_CIPHERS[level]) {
      it(`${cipher} @ L${level}: ${SECRETS} secrets x ${SELF_CHECK_WALLETS.length} wallets`, () => {
        const params: PuzzleParams = { family: "decode-memo", cipher, level };
        for (let s = 0; s < SECRETS; s++) {
          const report = selfCheck(params, secretFor(`fuzz/${cipher}/${level}/${s}`));
          expect(report.failures, `secret #${s}`).toEqual([]);
        }
      });
    }
  }

  it("every level has at least one cipher, and the fallback is a level-1 cipher", () => {
    for (const level of LEVELS) expect(LEVEL_CIPHERS[level].length).toBeGreaterThan(0);
    expect(LEVEL_CIPHERS[1]).toContain(FALLBACK_PARAMS.cipher);
    expect(FALLBACK_PARAMS.level).toBe(1);
  });

  it("the fallback itself passes on many secrets", () => {
    for (let s = 0; s < SECRETS; s++) {
      expect(selfCheck(FALLBACK_PARAMS, secretFor(`fuzz/fallback/${s}`)).failures).toEqual([]);
    }
  });
});

describe("generatePuzzle (B-03)", () => {
  const secret = secretFor("gen/1");
  const params: PuzzleParams = { family: "decode-memo", cipher: "vigenere", level: 3 };

  it("is pure and deterministic", () => {
    expect(generatePuzzle(params, secret, "alice.testnet")).toEqual(generatePuzzle(params, secret, "alice.testnet"));
  });

  it("expectedAnswer is the protocol code (PROTOCOL.md section 4) and never appears in the display or hint", () => {
    for (const w of SELF_CHECK_WALLETS) {
      const p = generatePuzzle(params, secret, w);
      expect(p.expectedAnswer).toBe(deriveCode(secret, w));
      expect(p.expectedAnswer).toMatch(CODE_RE);
      expect(p.display).not.toContain(p.expectedAnswer);
      expect(p.hint).not.toContain(p.expectedAnswer);
    }
  });

  it("gives different wallets different puzzles", () => {
    const displays = new Set(SELF_CHECK_WALLETS.map((w) => generatePuzzle(params, secret, w).display));
    expect(displays.size).toBeGreaterThan(SELF_CHECK_WALLETS.length * 0.9);
  });

  it("a different day secret gives a different puzzle for the same wallet", () => {
    const a = generatePuzzle(params, secretFor("gen/a"), "alice.testnet");
    const b = generatePuzzle(params, secretFor("gen/b"), "alice.testnet");
    expect(a.display).not.toBe(b.display);
  });

  it("handles unusual wallet strings (wallet is an opaque string)", () => {
    for (const w of ["", "a", "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "ünï.çødé", "x".repeat(256), "a\u0000b"]) {
      const p = generatePuzzle(params, secret, w);
      expect(p.expectedAnswer).toBe(deriveCode(secret, w));
    }
  });

  it("rejects a cipher that is not allowed at that level", () => {
    expect(() => generatePuzzle({ family: "decode-memo", cipher: "morse", level: 1 }, secret, "w")).toThrow();
  });

  it("stays inside the 60-second budget for every shipped combination", () => {
    for (const level of LEVELS) {
      for (const cipher of LEVEL_CIPHERS[level]) {
        for (const w of SELF_CHECK_WALLETS) {
          const p = generatePuzzle({ family: "decode-memo", cipher, level }, secret, w);
          expect(estimateSolveSeconds(cipher, p.display), `${cipher} L${level}`).toBeLessThanOrEqual(60);
        }
      }
    }
  });
});

describe("memo vocabulary and money-word blocklist", () => {
  it("no vocabulary word is a money word or looks like a code", () => {
    for (const word of MEMO_VOCABULARY) {
      expect(word, word).toMatch(/^[A-Z]+$/);
      expect(containsMoneyWord(word), word).toBe(false);
      expect(word, word).not.toMatch(CODE_RE);
    }
  });

  it("flags money words, plurals, case and currency symbols", () => {
    for (const bad of ["Cash only", "your SALARY", "wages due", "pay now", "send 5 coins", "costs $5", "€10", "free TOKENS"]) {
      expect(containsMoneyWord(bad), bad).toBe(true);
    }
    for (const ok of ["Please water the plants", "Spot the stapler", "Company picnic"]) {
      expect(containsMoneyWord(ok), ok).toBe(false);
    }
  });
});

describe("the checker itself catches bad puzzles", () => {
  const params: PuzzleParams = { family: "decode-memo", cipher: "caesar", level: 1 };
  const secret = secretFor("checker/1");
  const wrap = (over: Partial<PuzzleFamily>): PuzzleFamily => ({ ...decodeMemoFamily, ...over });

  it("passes the real family", () => {
    expect(selfCheckFamily(decodeMemoFamily, params, secret).failures).toEqual([]);
  });

  it("fails when the solver finds two candidates", () => {
    const f = wrap({ solve: (d, h) => [...decodeMemoFamily.solve(d, h), "BADOKIGU"] });
    expect(selfCheckFamily(f, params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when the solver finds none", () => {
    expect(selfCheckFamily(wrap({ solve: () => [] }), params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when the only candidate is wrong", () => {
    expect(selfCheckFamily(wrap({ solve: () => ["BADOKIGU"] }), params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when the expected answer is not the protocol code", () => {
    const f = wrap({
      generate: (p, s, w): GeneratedPuzzle => ({ ...decodeMemoFamily.generate(p, s, w), expectedAnswer: "BADOKIGU" }),
    });
    expect(selfCheckFamily(f, params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when the display or hint contains a money word", () => {
    const f = wrap({
      generate: (p, s, w): GeneratedPuzzle => {
        const g = decodeMemoFamily.generate(p, s, w);
        return { ...g, hint: `${g.hint} Pay attention.` };
      },
    });
    expect(selfCheckFamily(f, params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when a puzzle blows the 60-second budget", () => {
    const f = wrap({
      generate: (p, s, w): GeneratedPuzzle => {
        const g = decodeMemoFamily.generate(p, s, w);
        return { ...g, display: `${g.display} ${"ABCD ".repeat(400)}` };
      },
    });
    expect(selfCheckFamily(f, params, secret).failures.length).toBeGreaterThan(0);
  });

  it("fails when generate throws", () => {
    const f = wrap({
      generate: () => {
        throw new Error("boom");
      },
    });
    expect(selfCheckFamily(f, params, secret).failures.length).toBeGreaterThan(0);
  });
});

describe("resolveDayParams: a day is never skipped", () => {
  const secret = secretFor("resolve/1");
  const wanted: PuzzleParams = { family: "decode-memo", cipher: "rail-fence", level: 4 };

  it("keeps the requested params when they pass", () => {
    const r = resolveDayParams(wanted, secret);
    expect(r.usedFallback).toBe(false);
    expect(r.params).toEqual(wanted);
  });

  it("reports failure (not a silent pass) when even the fallback is broken", () => {
    const broken: PuzzleFamily = { ...decodeMemoFamily, solve: () => [] };
    const r = resolveDayParams(wanted, secret, { families: { "decode-memo": broken } });
    expect(r.usedFallback).toBe(true);
    expect(r.report.ok).toBe(false);
  });

  it("falls back and succeeds when only the requested combination is bad", () => {
    const flaky: PuzzleFamily = {
      ...decodeMemoFamily,
      generate: (p, s, w) => {
        if (p.cipher === "rail-fence") throw new Error("generator bug");
        return decodeMemoFamily.generate(p, s, w);
      },
    };
    const r = resolveDayParams(wanted, secret, { families: { "decode-memo": flaky } });
    expect(r.usedFallback).toBe(true);
    expect(r.params).toEqual(FALLBACK_PARAMS);
    expect(r.report.ok).toBe(true);
  });
});
