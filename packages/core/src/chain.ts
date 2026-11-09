/**
 * Chain adapter interfaces (ROADMAP §3). Everything chain-specific (RPC, signing, account
 * types) lives behind these; the boss scheduler and the tower see only this module and the
 * plain JSON shapes of abi.ts. Implemented for NEAR in packages/chain-near.
 */
import type {
  ContractInfo,
  EmployeeView,
  FinalizeTaskArgs,
  OpenTaskArgs,
  SubmissionView,
  TaskId,
  TaskView,
  TreasuryView,
} from "./abi";
import type { ContractConfig } from "./config";
import type { ReorgEvent } from "./events";

/** Largest page the contract returns from `list_*` and `get_events`. */
export const MAX_PAGE = 100;

/** Read-only views of the REORG contract. */
export interface ChainReader {
  /** Chain time in nanoseconds (latest block timestamp). Windows are measured against this. */
  now(): Promise<bigint>;
  getInfo(): Promise<ContractInfo>;
  getConfig(): Promise<ContractConfig>;
  getTask(taskId: TaskId): Promise<TaskView | null>;
  listSubmissions(taskId: TaskId, fromIndex: number, limit: number): Promise<SubmissionView[]>;
  listEmployees(fromIndex: number, limit: number): Promise<EmployeeView[]>;
  getTreasury(): Promise<TreasuryView>;
  /** Events with `seq > sinceSeq`, oldest first. */
  getEvents(sinceSeq: number, limit: number): Promise<ReorgEvent[]>;
}

/**
 * The boss-only calls. Both throw on failure. A thrown error does not prove the call had no
 * effect (the transaction may have landed), so callers reconcile through the views.
 */
export interface ChainAdapter extends ChainReader {
  /** The boss account (opaque string). */
  readonly bossId: string;
  /** Returns the new task id. */
  openTask(args: OpenTaskArgs): Promise<TaskId>;
  finalizeTask(args: FinalizeTaskArgs): Promise<void>;
}

/** Reads every page of a paged view. */
export async function readAll<T>(page: (from: number, limit: number) => Promise<T[]>, limit = MAX_PAGE): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const batch = await page(out.length, limit);
    out.push(...batch);
    if (batch.length < limit) return out;
  }
}
