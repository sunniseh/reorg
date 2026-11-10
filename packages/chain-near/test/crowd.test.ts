// Crowd keys (D-02, D-06): derived from CROWD_SEED, deterministic, distinct per index and seed,
// and a valid ed25519 pair (the signature verifies with the derived public key).
import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { crowdKey, crowdPublicKey } from "../src";

describe("crowdKey", () => {
  it("is deterministic and distinct per index and seed", () => {
    expect(crowdKey("seed", 0)).toBe(crowdKey("seed", 0));
    const keys = new Set([0, 1, 2, 19].map((i) => crowdKey("seed", i)));
    keys.add(crowdKey("other", 0));
    expect(keys.size).toBe(5);
    expect(() => crowdKey("", 0)).toThrow(/CROWD_SEED/);
  });

  it("is a valid ed25519 key pair", () => {
    const kp = KeyPair.fromString(crowdKey("seed", 3));
    expect(kp.getPublicKey().toString()).toBe(crowdPublicKey("seed", 3));
    const msg = new TextEncoder().encode("hello");
    expect(kp.verify(msg, kp.sign(msg).signature)).toBe(true);
  });
});
