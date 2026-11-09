// Demo faucet (roadmap D-09) behind the chain-agnostic Faucet interface: creates a burner account
// `p<random>.<funder>` for a browser's public key, registers it with the token and sends it native
// coin for gas plus enough $REORG for a desk. Used by the boss service in demo mode only; the
// funder's key comes from the environment (FAUCET_ACCOUNT_ID / FAUCET_PRIVATE_KEY).
import { REORG_METHODS, type ContractInfo, type Faucet, type FaucetGrant } from "@reorg/core";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

export interface NearFaucetOptions {
  rpcUrl: string;
  contractId: string;
  funderId: string;
  funderKey: string;
  /** yoctoNEAR per burner. */
  nativeAmount: bigint;
  /** Token base units per burner. */
  tokenAmount: bigint;
}

export class NearFaucet implements Faucet {
  private readonly provider: JsonRpcProvider;
  private readonly funder: Account;
  private tokenId: string | null = null;
  private storageMin: bigint | null = null;

  constructor(private readonly opts: NearFaucetOptions) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl });
    this.funder = new Account(opts.funderId, this.provider, opts.funderKey as KeyPairString);
  }

  private async token(): Promise<{ id: string; storage: bigint }> {
    if (!this.tokenId) {
      const info = (await this.provider.callFunction({ contractId: this.opts.contractId, method: REORG_METHODS.getInfo, args: {} })) as ContractInfo;
      this.tokenId = info.token;
      const b = (await this.provider.callFunction({ contractId: info.token, method: "storage_balance_bounds", args: {} })) as { min: string };
      this.storageMin = BigInt(b.min);
    }
    return { id: this.tokenId, storage: this.storageMin! };
  }

  async fund(publicKey: string, _hint: string): Promise<FaucetGrant> {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(publicKey)) throw new Error("public_key must be an ed25519 key");
    const { id: tokenId, storage } = await this.token();
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
    const accountId = `p${rand}.${this.opts.funderId}`;
    await this.funder.createSubAccount({ accountOrPrefix: accountId, publicKey, nearToTransfer: this.opts.nativeAmount });
    await this.funder.callFunction({ contractId: tokenId, methodName: "storage_deposit", args: { account_id: accountId }, deposit: storage });
    await this.funder.callFunction({
      contractId: tokenId,
      methodName: "ft_transfer",
      args: { receiver_id: accountId, amount: this.opts.tokenAmount.toString() },
      deposit: 1n,
    });
    return { account_id: accountId, tokens: this.opts.tokenAmount.toString(), native: this.opts.nativeAmount.toString() };
  }
}
