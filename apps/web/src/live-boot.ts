/**
 * Live wiring (roadmap W-11, W-12), loaded only when a contract is configured, so the standalone
 * preview never pulls chain code. This is the one place the client meets the NEAR adapters; the
 * renderer and HUD only see `StateSource` and `WalletAdapter` (ROADMAP §15).
 *
 * Env (VITE_*, see .env.example): VITE_NETWORK, VITE_RPC_URL, VITE_REORG_CONTRACT_ID,
 * VITE_TOKEN_CONTRACT_ID, VITE_BOSS_URL, VITE_CROWD_ROOT, VITE_DEMO (1 = burner demo player).
 */
import { BurnerWallet, NearConnectWallet, NearReader } from "@reorg/chain-near";
import type { AppOptions, WalletOption } from "./app";
import { BossClient } from "./state/boss";
import { LiveSource } from "./state/live";

const RPC: Record<string, string> = {
  testnet: "https://test.rpc.fastnear.com",
  sandbox: "http://127.0.0.1:3030",
};

export async function liveOptions(env: ImportMetaEnv): Promise<Partial<AppOptions>> {
  const network = env.VITE_NETWORK || "sandbox";
  const rpcUrl = env.VITE_RPC_URL || RPC[network] || RPC.sandbox!;
  const contractId = env.VITE_REORG_CONTRACT_ID!;
  const bossUrl = env.VITE_BOSS_URL || "";
  const reader = new NearReader({ rpcUrl, contractId, ...(env.VITE_TOKEN_CONTRACT_ID ? { tokenId: env.VITE_TOKEN_CONTRACT_ID } : {}) });
  const boss = bossUrl ? new BossClient(bossUrl) : null;
  const live = new LiveSource({ reader, boss, network, crowdRoot: env.VITE_CROWD_ROOT || null });

  const wallets: WalletOption[] = [];
  if (env.VITE_DEMO === "1" && bossUrl) {
    wallets.push({
      id: "burner",
      label: "Demo player",
      description: "A throwaway account kept in this browser, funded by the demo faucet. Nothing to install.",
      create: () => new BurnerWallet({ rpcUrl, contractId, bossUrl, network }),
    });
  }
  // A real wallet only makes sense on a public network; there are no wallets for a local chain.
  if (network === "testnet") {
    wallets.push({
      id: "near",
      label: "NEAR wallet",
      description: "Sign with your own testnet wallet (HOT, Meteor, MyNearWallet, Intear…) through NEAR Connect.",
      create: () => new NearConnectWallet({ contractId, network: "testnet" }),
    });
  }
  return {
    live,
    wallets,
    txUrl: network === "testnet" ? (hash) => `https://testnet.nearblocks.io/txns/${hash}` : () => null,
    // Contract events carry no transaction hash, so ledger rows link to the account; the contract's
    // own page lists every transaction (design §3 ledger).
    accountUrl: network === "testnet" ? (id) => `https://testnet.nearblocks.io/address/${id}` : () => null,
    contractId,
  };
}
