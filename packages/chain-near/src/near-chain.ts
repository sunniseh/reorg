// NEAR implementation of the chain-agnostic ChainAdapter (packages/core/src/chain.ts): the views
// (NearReader) plus the two boss-only calls. The only place in the boss service that knows about
// RPC, gas or keys.
import { REORG_METHODS, type ChainAdapter, type FinalizeTaskArgs, type OpenTaskArgs, type TaskId } from "@reorg/core";
import { Account, teraToGas, type KeyPairString } from "near-api-js";
import { NearReader } from "./reader";

/** open_task burns ~3 Tgas; finalize with 50 passers + settle burns ~29 Tgas (contracts/README.md). */
export const OPEN_TASK_GAS = teraToGas("30");
export const FINALIZE_GAS = teraToGas("200");

export interface NearChainOptions {
  rpcUrl: string;
  /** Extra headers for a keyed RPC provider (e.g. `{ "x-api-key": … }`). */
  rpcHeaders?: Record<string, string>;
  contractId: string;
  bossId: string;
  /** `ed25519:…` secret key of the boss account. Read from the environment by the caller. */
  bossKey: string;
}

export class NearChainAdapter extends NearReader implements ChainAdapter {
  readonly bossId: string;
  private readonly boss: Account;

  constructor(opts: NearChainOptions) {
    super({ rpcUrl: opts.rpcUrl, contractId: opts.contractId, ...(opts.rpcHeaders ? { rpcHeaders: opts.rpcHeaders } : {}) });
    this.bossId = opts.bossId;
    this.boss = new Account(opts.bossId, this.provider, opts.bossKey as KeyPairString);
  }

  async openTask(args: OpenTaskArgs): Promise<TaskId> {
    const id = await this.boss.callFunction({
      contractId: this.contractId,
      methodName: REORG_METHODS.openTask,
      args: { ...args },
      gas: OPEN_TASK_GAS,
    });
    return Number(id);
  }

  async finalizeTask(args: FinalizeTaskArgs): Promise<void> {
    await this.boss.callFunction({
      contractId: this.contractId,
      methodName: REORG_METHODS.finalizeTask,
      args: { ...args },
      gas: FINALIZE_GAS,
    });
  }
}
