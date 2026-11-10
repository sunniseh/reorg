/**
 * The one interface the client renders from (roadmap §3, W-01, W-12). Two implementations:
 * `LiveSource` (contract views + `get_events` + the boss service) and `SimSource` (the seeded
 * growth preview). Components never read the chain: they get a `Snapshot` and derived models
 * from `@reorg/core` (design §15.3 rule 2).
 */
import type {
  ContractConfig,
  EmployeeView,
  HolderEntry,
  HolderInfo,
  ReorgEvent,
  SubmissionView,
  TaskId,
  TaskStatus,
  TaskView,
  TowerLayout,
  TreasuryView,
  WalletAdapter,
  WalletId,
} from "@reorg/core";

/** The boss service's view of the newest task (`GET /api/task/current`, subset). */
export interface BossTask {
  task_id: TaskId;
  cipher_label: string;
  level: number;
  task_text: string;
  written_by: "ai" | "template";
  warmup: boolean;
}

/** The player's personal puzzle (`GET /api/puzzle?wallet=`). */
export interface Puzzle {
  task_id: TaskId;
  display: string;
  hint: string;
  answer_format: string;
  task_text: string;
  /** Nanoseconds, decimal string. */
  closes_at: string;
}

export type FeedKind =
  | "task"
  | "results"
  | "submission"
  | "payroll"
  | "claim"
  | "forfeit"
  | "layoff"
  | "warning"
  | "rehire"
  | "promotion"
  | "new_hire"
  | "streak"
  | "income"
  | "system";

export interface FeedItem {
  id: string;
  /** Wall-clock ms. */
  at: number;
  kind: FeedKind;
  text: string;
  /** Who wrote it: the boss's LLM, a template, code (system), or a raw chain event. */
  source: "ai" | "template" | "system" | "chain";
  wallet?: WalletId;
  taskId?: TaskId;
  /** For merged items ("12 answers filed"). */
  count?: number;
  /** Stays as the oldest item when the feed is trimmed (the "records before you arrived" line). */
  pinned?: boolean;
}

export interface Snapshot {
  kind: "live" | "sim";
  /** "sandbox", "testnet", or "simulated". */
  network: string;
  config: ContractConfig;
  totalSupply: bigint;
  lastFinalized: TaskId;
  /** The newest task, or null before the first. */
  task: TaskView | null;
  /** Submissions to `task`. */
  submissions: SubmissionView[];
  /** The latest finalized task (= `task` once it finalizes): the boss's face and the HUD read it. */
  lastFinalizedTask: TaskView | null;
  holders: HolderEntry[];
  employees: EmployeeView[];
  treasury: TreasuryView;
  boss: BossTask | null;
  /** The boss service reports STALLED (design §4.6, P1 server tag). */
  stalled: boolean;
  /** Crowd (bot) accounts, from deployment config. Never guessed (design §12.5). */
  isCrowd: (wallet: WalletId) => boolean;
  /** Reads have failed for a while: the HUD shows that the picture may be old. */
  stale: boolean;
  /** When the next task is expected to open (ms), if anyone knows. */
  nextOpenAt: number | null;
  /**
   * A big company (design §4.3, §12): the boss service's prebuilt layout (`GET /api/tower`),
   * drawn instead of building one from `holders`/`employees`/`submissions` (left empty then).
   */
  tower?: TowerLayout;
  /**
   * The company is bankrupt (design §14.3, Later). No v1 source sets it: the contract reserves
   * `bankruptcy_empty_tasks` but has no bankruptcy (PROTOCOL.md). The renderer is ready for it.
   */
  bankrupt?: boolean;
}

/** Everything the my-desk dock needs about the connected wallet. */
export interface PlayerView {
  wallet: WalletId;
  holder: HolderInfo;
  employee: EmployeeView | null;
  /** The wallet's submission to the newest task, if any. */
  submission: SubmissionView | null;
  /** Finalized, passed, paid, unclaimed submissions: newest first. */
  claimables: SubmissionView[];
}

export interface LedgerRow {
  at: number;
  kind: "income" | "salary" | "forfeit" | "operating";
  amount: bigint;
  tag?: string;
  simulated: boolean;
  wallet?: WalletId;
  taskId?: TaskId;
}

export type Unsubscribe = () => void;

export interface StateSource {
  readonly kind: "live" | "sim";
  start(): void;
  stop(): void;
  /** Corrected wall clock in ms (chain time when known, design §5.6). */
  now(): number;
  snapshot(): Snapshot | null;
  onSnapshot(fn: (s: Snapshot) => void): Unsubscribe;
  /** Contract events newer than load time, in `seq` order (design §14.1 rule 3). */
  onEvent(fn: (e: ReorgEvent) => void): Unsubscribe;
  onFeed(fn: (items: readonly FeedItem[]) => void): Unsubscribe;
  /** Recent feed, newest first. */
  feed(): readonly FeedItem[];
  /** Re-read soon (after a player action). */
  refresh(): void;
  player(wallet: WalletId): Promise<PlayerView>;
  puzzle(wallet: WalletId): Promise<Puzzle | null>;
  /** Income, salaries, forfeits and operating costs seen so far, newest first. */
  ledger(): readonly LedgerRow[];
  /** The badged-in player, so a big company's tower unfolds their floor (null: nobody). */
  focus?(wallet: WalletId | null): void;
  /** A wallet that plays in this source (the sim's own; live sources use the real one). */
  wallet(): WalletAdapter | null;
}

/** `closed` is derived: a stored Open task whose window has passed (PROTOCOL §2). */
export function effectiveStatus(task: Pick<TaskView, "status" | "closes_at">, nowMs: number): TaskStatus {
  if (task.status === "open" && nowMs >= nsToMs(task.closes_at)) return "closed";
  return task.status;
}

export const nsToMs = (ns: string | bigint): number => Number(BigInt(ns) / 1_000_000n);
export const msToNs = (ms: number): string => (BigInt(Math.floor(ms)) * 1_000_000n).toString();
