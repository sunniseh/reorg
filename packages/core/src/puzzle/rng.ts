// Deterministic per-wallet randomness for puzzle parameters (cipher key, memo wording). It is
// derived from day_secret under its own domain, so it never overlaps the answer HMAC of
// PROTOCOL.md section 4 and reveals nothing about the code.
import { assertSecret, hmacSha256, sha256Bytes } from "../crypto";

const enc = new TextEncoder();
const DOMAIN = enc.encode("reorg/puzzle/v1\u0000");

export function puzzleSubkey(daySecret: Uint8Array): Uint8Array {
  assertSecret(daySecret);
  const msg = new Uint8Array(DOMAIN.length + daySecret.length);
  msg.set(DOMAIN, 0);
  msg.set(daySecret, DOMAIN.length);
  return sha256Bytes(msg);
}

export class PuzzleRng {
  private readonly subkey: Uint8Array;
  private readonly wallet: Uint8Array;
  private block: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private counter = 0;

  constructor(daySecret: Uint8Array, wallet: string) {
    this.subkey = puzzleSubkey(daySecret);
    this.wallet = enc.encode(wallet);
  }

  private refill(): void {
    const msg = new Uint8Array(this.wallet.length + 5);
    msg.set(this.wallet, 0);
    msg[this.wallet.length] = 0;
    new DataView(msg.buffer).setUint32(this.wallet.length + 1, this.counter++, false);
    this.block = hmacSha256(this.subkey, msg);
    this.pos = 0;
  }

  u32(): number {
    if (this.pos + 4 > this.block.length) this.refill();
    const b = this.block;
    const p = this.pos;
    this.pos += 4;
    return (((b[p] as number) << 24) | ((b[p + 1] as number) << 16) | ((b[p + 2] as number) << 8) | (b[p + 3] as number)) >>> 0;
  }

  /** Uniform integer in [0, n) by rejection sampling (no modulo bias). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error(`bad range ${n}`);
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const x = this.u32();
      if (x < limit) return x % n;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(items.length)] as T;
  }

  /** `count` distinct items, in random order. */
  pickDistinct<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < count && pool.length > 0; i++) out.push(pool.splice(this.int(pool.length), 1)[0] as T);
    return out;
  }
}
