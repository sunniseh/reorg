/**
 * JSON shapes of the REORG contract's views and call arguments (roadmap P-03).
 * Normative source: docs/PROTOCOL.md §6, §7, §11. Chain-agnostic: no chain SDK types.
 * Wire encoding: u128 and u64 values are decimal strings; ids, counts and bps are numbers;
 * 32-byte values are standard base64 with padding.
 */

/** Opaque wallet identity, hashed as UTF-8. Never parse it. */
export type WalletId = string;
/** u128 as a decimal string (token base units, payout base units, weights). */
export type U128 = string;
/** u64 as a decimal string (nanosecond timestamps). */
export type U64 = string;
/** 32 bytes, standard base64 with padding (44 chars). */
export type Base64 = string;
export type TaskId = number;
export type Tuple4<T> = [T, T, T, T];

export const TIER_NAMES = ["director", "manager", "associate", "intern"] as const;
export type TierName = (typeof TIER_NAMES)[number];
/** 0 = Director … 3 = Intern. "No tier" (visitor) is `null`. */
export type TierIndex = 0 | 1 | 2 | 3;

export const TASK_KINDS = ["decode_memo"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** `closed` is derived by the view (stored Open and now ≥ closes_at), never stored. */
export type TaskStatus = "open" | "closed" | "finalizing" | "finalized";

/** PROTOCOL.md §6.5, employee status (contract views and core). */
export type EmployeeStatus = "active" | "struggling" | "laid_off";
/** PROTOCOL.md §6.5, tower character status (core only). */
export type CharacterStatus = EmployeeStatus | "new_hire" | "visitor";

export const INCOME_TAGS = ["client_job", "fee_share", "seed"] as const;
export type IncomeTag = (typeof INCOME_TAGS)[number];

/** Per-task result in an employee's recent history. */
export type TaskResult = "pass" | "fail" | "miss" | "pending";

export type ClaimState = "unclaimed" | "pending" | "claimed" | "forfeited";

// ---------------------------------------------------------------- views

/** Set on the first finalize call (income snapshot), completed by the last one. */
export interface Allocation {
  income: U128;
  payroll: U128;
  jackpot: U128;
  reserve_share: U128;
  buckets: Tuple4<U128>;
  payroll_dust: U128;
  /** Grows as finalize batches verify passers. */
  tier_payable: Tuple4<U128>;
  /** `null` until the last finalize call. */
  settlement: {
    to_reserve: U128;
    operating_cost_paid: U128;
    reserve_after: U128;
    runway_tasks: number | null;
  } | null;
}

export interface TaskView {
  id: TaskId;
  kind: TaskKind;
  status: TaskStatus;
  commit_hash: Base64;
  opens_at: U64;
  closes_at: U64;
  /** Revealed secret, `null` until the first finalize call. */
  day_secret: Base64 | null;
  submitted: number;
  passed: number;
  tier_submitted_weight: Tuple4<U128>;
  tier_passed_weight: Tuple4<U128>;
  allocation: Allocation | null;
  finalized_at: U64 | null;
}

export interface SubmissionView {
  task_id: TaskId;
  account_id: WalletId;
  answer_hash: Base64;
  /** Snapshot balance at submission. */
  balance: U128;
  tier: TierIndex;
  streak_before: number;
  multiplier_bps: number;
  /** balance × multiplier_bps (never divided). */
  weight: U128;
  submitted_at: U64;
  reapply: boolean;
  /** True once a finalize call verified this wallet. */
  passed: boolean;
  /** "0" unless passed and not reapply. */
  pay: U128;
  claim: ClaimState;
}

export interface RecentResult {
  task_id: TaskId;
  result: TaskResult;
}

export interface EmployeeView {
  account_id: WalletId;
  joined_after: TaskId;
  last_pass_day: TaskId | null;
  stored_streak: number;
  effective_streak: number;
  gap: number;
  status: EmployeeStatus;
  misses_in_row: number;
  layoff_tasks_left: number;
  last_tier: TierIndex;
  last_balance: U128;
  total_earned: U128;
  /** Bit 0 = rehired; other bits reserved. */
  badges: number;
  /** Up to 7 entries, newest first; tasks before joining are omitted. */
  recent: RecentResult[];
}

export interface TreasuryView {
  reserve: U128;
  income_accrued: U128;
  /** Allocated but not yet claimed or forfeited. */
  outstanding: U128;
  total_income: U128;
  income_by_tag: Record<IncomeTag, U128>;
  total_paid: U128;
  total_forfeited: U128;
  total_operating_cost: U128;
  operating_cost: U128;
  runway_tasks: number | null;
}

/** Token extension views (D15, D16). */
export interface HolderInfo {
  balance: U128;
  last_received_at: U64;
}

export interface HolderEntry extends HolderInfo {
  account_id: WalletId;
}

// ---------------------------------------------------------------- call / view args

export interface InitArgs<C> {
  config: C;
  token: WalletId;
  boss: WalletId;
  total_supply: U128;
  /** Defaults to the deploying account. */
  owner?: WalletId | null;
}

export interface OpenTaskArgs {
  kind: TaskKind;
  commit_hash: Base64;
  closes_at: U64;
}

export interface SubmitArgs {
  task_id: TaskId;
  answer_hash: Base64;
}

export interface FinalizeTaskArgs {
  task_id: TaskId;
  day_secret: Base64;
  passers: WalletId[];
  /** True on the final batch; triggers allocation settlement. */
  last: boolean;
}

export interface TaskArg {
  task_id: TaskId;
}

export interface DepositIncomeArgs {
  tag: IncomeTag;
}

/** Both fields optional; `limit` is capped at 100 (200 for `ft_holders`). */
export interface PageArgs {
  from_index?: number;
  limit?: number;
}

export interface GetEventsArgs {
  since_seq: number;
  limit?: number;
}

/** Return value of `submit` (its balance callback). Rejections after the balance read are values, not failures. */
export interface SubmitOutcome {
  accepted: boolean;
  reason: string | null;
}

/** Return value of `claim_salary`. `retry`: the balance read or the transfer failed; nothing changed. */
export type ClaimOutcome =
  | { status: "paid"; amount: U128 }
  | { status: "forfeited"; amount: U128 }
  | { status: "retry"; reason: string };

export interface ContractInfo {
  owner: WalletId;
  boss: WalletId;
  token: WalletId;
  total_supply: U128;
  current_task_id: TaskId;
  last_finalized: TaskId;
  event_seq: number;
  employees: number;
}

/** Method names on the REORG contract (C-04 … C-15, C-21). */
export const REORG_METHODS = {
  // calls
  openTask: "open_task",
  submit: "submit",
  finalizeTask: "finalize_task",
  claimSalary: "claim_salary",
  provePass: "prove_pass",
  depositIncome: "deposit_income",
  refreshTotalSupply: "refresh_total_supply",
  updateConfig: "update_config",
  setBoss: "set_boss",
  setExcluded: "set_excluded",
  setOwner: "set_owner",
  // views
  getConfig: "get_config",
  getInfo: "get_info",
  getCurrentTaskId: "get_current_task_id",
  getTask: "get_task",
  getEmployee: "get_employee",
  listEmployees: "list_employees",
  getSubmission: "get_submission",
  listSubmissions: "list_submissions",
  getClaimable: "get_claimable",
  getTreasury: "get_treasury",
  getEvents: "get_events",
  getStorageFloat: "get_storage_float",
} as const;

/** Extension views on the token contract (C-01). */
export const TOKEN_METHODS = {
  holderInfo: "ft_holder_info",
  holders: "ft_holders",
  holdersCount: "ft_holders_count",
} as const;
