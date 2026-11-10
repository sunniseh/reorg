/**
 * Chain adapter interfaces (ROADMAP §3). Everything chain-specific (RPC, signing, account
 * types) lives behind these; the boss scheduler and the tower see only this module and the
 * plain JSON shapes of abi.ts. Implemented for NEAR in packages/chain-near.
 */
import type {
  ClaimOutcome,
  ContractInfo,
  EmployeeView,
  FinalizeTaskArgs,
  HolderEntry,
  HolderInfo,
  OpenTaskArgs,
  SubmissionView,
  SubmitOutcome,
  TaskId,
  TaskView,
  TreasuryView,
  WalletId,
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

/**
 * Everything the tower client reads (W-12): the contract views plus the token's holder registry
 * (D16). Read-only and key-less, so it runs in a browser.
 */
export interface TowerReader extends ChainReader {
  /** The token's holders with a positive balance, in registry order (page size ≤ 200). */
  listHolders(fromIndex: number, limit: number): Promise<HolderEntry[]>;
  /** Holders with a positive balance (`ft_holders_count`): picks the full read or the boss's tower. */
  holdersCount(): Promise<number>;
  holderInfo(wallet: WalletId): Promise<HolderInfo>;
  getEmployee(wallet: WalletId): Promise<EmployeeView | null>;
  getSubmission(taskId: TaskId, wallet: WalletId): Promise<SubmissionView | null>;
}

/** Largest page `ft_holders` returns. */
export const MAX_HOLDER_PAGE = 200;

/**
 * The player's wallet (roadmap §3, W-10, W-11): connect, then sign the three player calls.
 * Rejections after the balance read come back as values (`accepted: false`, `status: retry`);
 * transport and panic failures throw an Error whose message carries the contract's reason.
 */
export interface WalletAdapter {
  /** Short label for the dock ("Demo player", "HOT Wallet"…). */
  readonly label: string;
  /** True for a throwaway key kept in this browser (demo mode). */
  readonly burner: boolean;
  /** The connected account, or null. */
  accountId(): WalletId | null;
  /** Restores a previous session without prompting; resolves to the account or null. */
  restore(): Promise<WalletId | null>;
  /** Prompts (or creates a burner) and resolves to the account. */
  connect(): Promise<WalletId>;
  disconnect(): Promise<void>;
  submit(taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome>;
  claimSalary(taskId: TaskId): Promise<ClaimOutcome>;
  provePass?(taskId: TaskId): Promise<string>;
}

/** Demo faucet (D-09): creates and funds a burner account for a public key. */
export interface Faucet {
  fund(publicKey: string, hint: string): Promise<FaucetGrant>;
}

export interface FaucetGrant {
  account_id: WalletId;
  /** Token base units sent. */
  tokens: string;
  /** Payout base units (yoctoNEAR) sent for gas. */
  native: string;
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
