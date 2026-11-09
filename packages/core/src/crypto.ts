// B-01: the commit–reveal primitives of docs/PROTOCOL.md §3–§5. Pure, chain-agnostic, and
// browser-safe (the client computes answer_hash locally). Must match protocol/vectors.json and
// the Rust implementation in contracts/core; change all three together.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const DAY_SECRET_BYTES = 32;
export const CODE_CONSONANTS = "BDFGKLMNPRSTVZ";
export const CODE_VOWELS = "AEIOU";
export const CODE_LENGTH = 8;

export const toHex = (b: Uint8Array): string => bytesToHex(b);
export const fromHex = (s: string): Uint8Array => hexToBytes(s);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** PROTOCOL.md §11: 32-byte values travel as standard base64 with padding. */
export function toBase64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < b.length ? B64.charAt((n >> 6) & 63) : "=";
    out += i + 2 < b.length ? B64.charAt(n & 63) : "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  if (!B64_RE.test(s)) throw new Error("invalid base64");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = s.charAt(i + j);
      n = (n << 6) | (c === "=" ? 0 : B64.indexOf(c));
    }
    for (const shift of [16, 8, 0]) if (o < out.length) out[o++] = (n >> shift) & 255;
  }
  return out;
}

/** §5 as the wire value: base64(answer_hash(answer, wallet)). */
export const answerHashBase64 = (answer: string, wallet: string): string => toBase64(answerHash(answer, wallet));

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmac(sha256, key, msg);
}

export function assertSecret(daySecret: Uint8Array): void {
  if (daySecret.length !== DAY_SECRET_BYTES) {
    throw new Error(`day_secret must be ${DAY_SECRET_BYTES} bytes, got ${daySecret.length}`);
  }
}

/** §3: the commitment published by open_task. */
export function commitHash(daySecret: Uint8Array): Uint8Array {
  assertSecret(daySecret);
  return sha256(daySecret);
}

/** §4: the wallet's answer for the task. 8 uppercase letters in consonant–vowel pairs. */
export function deriveCode(daySecret: Uint8Array, wallet: string): string {
  assertSecret(daySecret);
  const h = hmac(sha256, daySecret, utf8ToBytes(wallet));
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_CONSONANTS[(h[2 * i] as number) % CODE_CONSONANTS.length];
    code += CODE_VOWELS[(h[2 * i + 1] as number) % CODE_VOWELS.length];
  }
  return code;
}

const ASCII_WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** §5: trim ASCII whitespace, ASCII a–z to A–Z, "0" to "O", "1" to "I". Nothing else changes. */
export function normalizeAnswer(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && ASCII_WS.has(s.charCodeAt(start))) start++;
  while (end > start && ASCII_WS.has(s.charCodeAt(end - 1))) end--;
  let out = "";
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) out += String.fromCharCode(c - 32);
    else if (c === 0x30) out += "O";
    else if (c === 0x31) out += "I";
    else out += s[i];
  }
  return out;
}

/** §5: sha256(utf8(norm(answer)) || 0x00 || utf8(wallet)). The wallet binding makes copies useless. */
export function answerHash(answer: string, wallet: string): Uint8Array {
  const a = utf8ToBytes(normalizeAnswer(answer));
  const w = utf8ToBytes(wallet);
  const msg = new Uint8Array(a.length + 1 + w.length);
  msg.set(a, 0);
  msg[a.length] = 0;
  msg.set(w, a.length + 1);
  return sha256(msg);
}
