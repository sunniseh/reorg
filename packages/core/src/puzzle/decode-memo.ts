// The "Decode the Memo" family (spec §3, PROTOCOL.md §4). The answer is the wallet's protocol
// code; the puzzle hides it inside an encoded memo. Pure and deterministic.
import { CODE_CONSONANTS, CODE_VOWELS, deriveCode } from "../crypto";
import { CIPHERS, LEVEL_CIPHERS, estimateSolveSeconds, memoClauses } from "./ciphers";
import { PuzzleRng } from "./rng";
import type { GeneratedPuzzle, PuzzleFamily, PuzzleParams } from "./types";
import { buildMemo } from "./words";

/** Every memo starts with this word; the hint says so, and the solver uses it to rule out wrong keys. */
export const MEMO_CRIB = "MEMO";
export const CRIB_SENTENCE = `Every memo starts with ${MEMO_CRIB}.`;

const CODE_FORMAT = new RegExp(`(?<![A-Z])(?:[${CODE_CONSONANTS}][${CODE_VOWELS}]){4}(?![A-Z])`, "g");

/** All tokens in `text` that look like a protocol code (8 letters, consonant-vowel pairs). */
export function extractCodes(text: string): string[] {
  return [...text.matchAll(CODE_FORMAT)].map((m) => m[0]);
}

function generate(params: PuzzleParams, daySecret: Uint8Array, wallet: string): GeneratedPuzzle {
  const allowed = LEVEL_CIPHERS[params.level];
  if (params.family !== "decode-memo" || !allowed?.includes(params.cipher)) {
    throw new Error(`cipher ${params.cipher} is not allowed at level ${params.level}`);
  }
  const code = deriveCode(daySecret, wallet);
  const rng = new PuzzleRng(daySecret, wallet);
  const plain = buildMemo(rng, memoClauses(params.level, params.cipher), code);
  const { display, hint } = CIPHERS[params.cipher].generate(params.level, plain, rng);
  return { display, hint: `${hint} ${CRIB_SENTENCE}`, expectedAnswer: code };
}

/** Solve from display + hint only: every key the hint allows, then keep memos that start with MEMO. */
function solve(display: string, hint: string): string[] {
  const cipher = Object.values(CIPHERS).find((c) => hint.startsWith(c.label));
  if (!cipher) return [];
  let plains = cipher.candidates(display, hint);
  if (hint.includes(CRIB_SENTENCE)) plains = plains.filter((p) => p.startsWith(`${MEMO_CRIB} `));
  return [...new Set(plains.flatMap(extractCodes))];
}

export const decodeMemoFamily: PuzzleFamily = {
  id: "decode-memo",
  displayIsText: false, // ciphertext; the memo vocabulary is money-checked statically
  generate,
  solve,
  estimateSeconds: (params, display) => estimateSolveSeconds(params.cipher, display),
};
