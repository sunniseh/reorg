// NEAR implementation of the chain-agnostic ChainAdapter (packages/core/src/chain.ts).
// The only place in the boss service that knows about RPC, gas or keys.
import {
  ConfigSchema,
  EVENT_NAMES,
  REORG_METHODS,
  ReorgEventSchema,
  type ChainAdapter,
  type ContractConfig,
  type ContractInfo,
  type EmployeeView,
  type FinalizeTaskArgs,
  type OpenTaskArgs,
  type ReorgEvent,
  type SubmissionView,
  type TaskId,
  type TaskView,
  type TreasuryView,
} from "@reorg/core";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

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

export class NearChainAdapter implements ChainAdapter {
  readonly bossId: string;
  readonly contractId: string;
  private readonly provider: JsonRpcProvider;
  private readonly boss: Account;

  constructor(opts: NearChainOptions) {
    this.bossId = opts.bossId;
    this.contractId = opts.contractId;
    this.provider = new JsonRpcProvider(
      { url: opts.rpcUrl, ...(opts.rpcHeaders ? { headers: opts.rpcHeaders } : {}) },
      { retries: 3, wait: 500, backoff: 2 },
    );
    this.boss = new Account(opts.bossId, this.provider, opts.bossKey as KeyPairString);
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.contractId, method, args })) as T;
  }

  async now(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: "optimistic" });
    return BigInt(block.header.timestamp_nanosec);
  }

  getInfo(): Promise<ContractInfo> {
    return this.view<ContractInfo>(REORG_METHODS.getInfo);
  }

  async getConfig(): Promise<ContractConfig> {
    return ConfigSchema.parse(await this.view(REORG_METHODS.getConfig));
  }

  async getTask(taskId: TaskId): Promise<TaskView | null> {
    return (await this.view<TaskView | null>(REORG_METHODS.getTask, { task_id: taskId })) ?? null;
  }

  listSubmissions(taskId: TaskId, fromIndex: number, limit: number): Promise<SubmissionView[]> {
    return this.view(REORG_METHODS.listSubmissions, { task_id: taskId, from_index: fromIndex, limit });
  }

  listEmployees(fromIndex: number, limit: number): Promise<EmployeeView[]> {
    return this.view(REORG_METHODS.listEmployees, { from_index: fromIndex, limit });
  }

  getTreasury(): Promise<TreasuryView> {
    return this.view(REORG_METHODS.getTreasury);
  }

  async getEvents(sinceSeq: number, limit: number): Promise<ReorgEvent[]> {
    const raw = await this.view<unknown[]>(REORG_METHODS.getEvents, { since_seq: sinceSeq, limit });
    // Unknown event names (a newer contract) are skipped rather than failing the whole page.
    return raw.flatMap((e) => {
      const name = (e as { event?: string }).event;
      return EVENT_NAMES.includes(name as never) ? [ReorgEventSchema.parse(e)] : [];
    });
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
