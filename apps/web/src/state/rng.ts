/**
 * Small deterministic hashing and PRNG for client-side display decisions (the growth preview,
 * the idle schedule). Not cryptographic and never used for protocol values.
 */

/** 32-bit FNV-1a over the UTF-16 code units of the joined parts. */
export function hash32(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join("␟");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche (murmur3 fmix32) so nearby inputs spread out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A uniform number in [0, 1) from the parts. */
export const unit = (...parts: (string | number)[]): number => hash32(...parts) / 4294967296;

/** mulberry32: a seeded stream of numbers in [0, 1). */
export function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
