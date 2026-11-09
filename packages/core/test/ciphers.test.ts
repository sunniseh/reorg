// B-15: cipher round-trip property tests. For every cipher at every level that ships it, the
// solver's candidates (computed from display + hint only) must include the original plaintext,
// for random memos and for random A-Z strings with single spaces.
import { describe, expect, it } from "vitest";
import { CIPHERS, LEVEL_CIPHERS, PuzzleRng, buildMemo, sha256Bytes, type CipherId, type Level } from "../src";

const enc = new TextEncoder();
const rngFor = (tag: string) => new PuzzleRng(sha256Bytes(enc.encode(tag)), tag);
const LEVELS: Level[] = [1, 2, 3, 4, 5];
const ROUNDS = 200;

function randomText(rng: PuzzleRng): string {
  const words = 1 + rng.int(6);
  return Array.from({ length: words }, () =>
    Array.from({ length: 1 + rng.int(9) }, () => String.fromCharCode(65 + rng.int(26))).join(""),
  ).join(" ");
}

const combos: [CipherId, Level][] = LEVELS.flatMap((l) => LEVEL_CIPHERS[l].map((c): [CipherId, Level] => [c, l]));

describe("cipher round trip: decode(encode(x)) ∋ x", () => {
  it.each(combos)("%s @ L%i", (id, level) => {
    const cipher = CIPHERS[id];
    const rng = rngFor(`roundtrip/${id}/${level}`);
    for (let i = 0; i < ROUNDS; i++) {
      const plain = i % 2 === 0 ? buildMemo(rng, cipher.maxClauses, "BADOKIGU") : randomText(rng);
      const { display, hint } = cipher.generate(level, plain, rng);
      expect(hint.startsWith(cipher.label), hint).toBe(true);
      expect(cipher.candidates(display, hint), `${id} L${level}: ${plain}`).toContain(plain);
    }
  });

  it("every cipher is shipped at some level and has a distinct label", () => {
    const shipped = new Set(combos.map(([c]) => c));
    expect([...shipped].sort()).toEqual(Object.keys(CIPHERS).sort());
    const labels = Object.values(CIPHERS).map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    // No label may be a prefix of another, or the solver could pick the wrong cipher.
    for (const a of labels) for (const b of labels) if (a !== b) expect(b.startsWith(a), `${a} / ${b}`).toBe(false);
  });

  it("solvers reject malformed displays instead of throwing", () => {
    for (const cipher of Object.values(CIPHERS)) {
      const hint = cipher.generate(5 as Level, "MEMO TEST", rngFor(`malformed/${cipher.id}`)).hint;
      for (const junk of ["", "###", "99-99 / 0", "ZZ ZZ", "....---...---"]) {
        expect(() => cipher.candidates(junk, hint)).not.toThrow();
      }
    }
  });
});
