// B-01: the TS crypto must reproduce protocol/vectors.json (same file the Rust core is tested against).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  answerHash,
  commitHash,
  deriveCode,
  fromHex,
  hmacSha256,
  normalizeAnswer,
  toHex,
} from "../src";

const vectors = JSON.parse(readFileSync(new URL("../../../protocol/vectors.json", import.meta.url), "utf8"));

describe("hmacSha256 (RFC 4231)", () => {
  it.each(vectors.hmac_sha256 as { name: string; key_hex: string; msg_hex: string; hmac_hex: string }[])(
    "$name",
    (v) => {
      expect(toHex(hmacSha256(fromHex(v.key_hex), fromHex(v.msg_hex)))).toBe(v.hmac_hex);
    },
  );
});

type CryptoVector = {
  name: string;
  day_secret_hex: string;
  commit_hash_hex: string;
  wallet: string;
  hmac_hex: string;
  code: string;
  answer_hash_hex: string;
};

describe("commit, code and answer hash (PROTOCOL §3-§5)", () => {
  it.each(vectors.crypto as CryptoVector[])("$name", (v) => {
    const secret = fromHex(v.day_secret_hex);
    expect(toHex(commitHash(secret))).toBe(v.commit_hash_hex);
    expect(deriveCode(secret, v.wallet)).toBe(v.code);
    expect(toHex(answerHash(v.code, v.wallet))).toBe(v.answer_hash_hex);
  });

  it("rejects a day_secret that is not 32 bytes", () => {
    expect(() => commitHash(new Uint8Array(31))).toThrow();
    expect(() => deriveCode(new Uint8Array(33), "w")).toThrow();
  });
});

describe("wallet binding", () => {
  it.each(vectors.wallet_binding as { answer: string; wallet: string; answer_hash_hex: string }[])(
    "$wallet",
    (v) => {
      expect(toHex(answerHash(v.answer, v.wallet))).toBe(v.answer_hash_hex);
    },
  );

  it("the same code hashes differently for different wallets", () => {
    expect(toHex(answerHash("BADOKIGU", "a.test"))).not.toBe(toHex(answerHash("BADOKIGU", "b.test")));
  });
});

describe("normalizeAnswer (PROTOCOL §5)", () => {
  it.each(vectors.normalization as { input: string; output: string; note: string }[])("$note", (v) => {
    expect(normalizeAnswer(v.input)).toBe(v.output);
  });

  it("normalized and raw answers hash the same", () => {
    expect(toHex(answerHash("  bad0k1gu\n", "w"))).toBe(toHex(answerHash("BADOKIGU", "w")));
  });
});
