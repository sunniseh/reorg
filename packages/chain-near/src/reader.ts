// NEAR implementation of the key-less TowerReader (packages/core/src/chain.ts): contract views plus
// the token's holder registry (D16). Browser-safe: it only uses JSON-RPC over fetch.
import {
  ConfigSchema,
  EVENT_NAMES,
  REORG_METHODS,
  ReorgEventSchema,
  TOKEN_METHODS,
  type ContractConfig,
  type ContractInfo,
  type EmployeeView,
  type HolderEntry,
  type HolderInfo,
  type ReorgEvent,
  type SubmissionView,
  type TaskId,
  type TaskView,
  type TowerReader,
  type TreasuryView,
  type WalletId,
} from "@reorg/core";
import { JsonRpcProvider } from "near-api-js";

export interface NearReaderOptions {
  rpcUrl: string;
  /** Extra headers for a keyed RPC provider (e.g. `{ "x-api-key": … }`). */
  rpcHeaders?: Record<string, string>;
  contractId: string;
  /** The token contract; read from `get_info` when omitted. */
  tokenId?: string;
}

export class NearReader implements TowerReader {
  readonly contractId: string;
  protected readonly provider: JsonRpcProvider;
  private tokenId: string | null;

  constructor(opts: NearReaderOptions) {
    this.contractId = opts.contractId;
    this.tokenId = opts.tokenId ?? null;
    this.provider = new JsonRpcProvider(
      { url: opts.rpcUrl, ...(opts.rpcHeaders ? { headers: opts.rpcHeaders } : {}) },
      { retries: 3, wait: 500, backoff: 2 },
    );
  }

  protected async view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.contractId): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  private async token(): Promise<string> {
    if (!this.tokenId) this.tokenId = (await this.getInfo()).token;
    return this.tokenId;
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

  async listHolders(fromIndex: number, limit: number): Promise<HolderEntry[]> {
    return this.view(TOKEN_METHODS.holders, { from_index: fromIndex, limit }, await this.token());
  }

  async holderInfo(wallet: WalletId): Promise<HolderInfo> {
    return this.view(TOKEN_METHODS.holderInfo, { account_id: wallet }, await this.token());
  }

  async getEmployee(wallet: WalletId): Promise<EmployeeView | null> {
    return (await this.view<EmployeeView | null>(REORG_METHODS.getEmployee, { account_id: wallet })) ?? null;
  }

  async getSubmission(taskId: TaskId, wallet: WalletId): Promise<SubmissionView | null> {
    return (await this.view<SubmissionView | null>(REORG_METHODS.getSubmission, { task_id: taskId, account_id: wallet })) ?? null;
  }
}
