// BurnerWallet without a chain (W-11): storage, the faucet request, and never losing a funded key
// to a transient RPC error. The sandbox suites cover real transactions.
import { describe, expect, it, vi } from "vitest";
import { BurnerWallet, type KeyStore } from "../src";

class MemStore implements KeyStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

// Nothing listens here, so every RPC call fails like a network outage.
const DEAD_RPC = "http://127.0.0.1:9";

function faucetStub() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { public_key } = JSON.parse(String(init?.body)) as { public_key: string };
    expect(public_key).toMatch(/^ed25519:/);
    return new Response(JSON.stringify({ account_id: "p1.faucet.test", tokens: "1", native: "1" }), { status: 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("BurnerWallet (W-11)", () => {
  it("creates one burner through the faucet even when connect is pressed twice, and stores its key", async () => {
    const store = new MemStore();
    const fetch = faucetStub();
    const w = new BurnerWallet({ rpcUrl: DEAD_RPC, contractId: "reorg.test", bossUrl: "http://boss/", network: "sandbox", store, fetch });
    const [a, b] = await Promise.all([w.connect(), w.connect()]);
    expect(a).toBe("p1.faucet.test");
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("http://boss/api/faucet");
    const saved = JSON.parse(store.getItem("reorg.burner.sandbox.reorg.test")!) as { account_id: string; key: string };
    expect(saved.account_id).toBe("p1.faucet.test");
    expect(saved.key).toMatch(/^ed25519:/);
    expect(w.accountId()).toBe("p1.faucet.test");
  });

  it("keeps the stored key when the RPC is unreachable (a funded desk is never lost to a blip)", async () => {
    const store = new MemStore();
    store.setItem("reorg.burner.sandbox.reorg.test", JSON.stringify({ account_id: "p1.faucet.test", key: "ed25519:x" }));
    const w = new BurnerWallet({ rpcUrl: DEAD_RPC, contractId: "reorg.test", bossUrl: "http://boss", network: "sandbox", store, fetch: faucetStub() });
    expect(await w.restore()).toBeNull();
    expect(store.getItem("reorg.burner.sandbox.reorg.test")).not.toBeNull();
  }, 30_000);

  it("reports the faucet's refusal", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "the faucet is resting; try again later" }), { status: 429 })) as unknown as typeof globalThis.fetch;
    const w = new BurnerWallet({ rpcUrl: DEAD_RPC, contractId: "reorg.test", bossUrl: "http://boss", network: "sandbox", store: new MemStore(), fetch });
    await expect(w.connect()).rejects.toThrow(/resting/);
  });
});
