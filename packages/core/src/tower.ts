/**
 * The tower model (roadmap W-02, D16, D18, D20, D21; PROTOCOL.md §6.5; design spec §4, §5.3, §12).
 *
 * Pure functions of current chain state, so every client draws the same building:
 *   holders ⋈ employees → characters (status, floor tier, desk overlays) → layout (floors, rooms,
 *   bench, queue) → building state. No history, no hysteresis (D20). The renderer never re-sorts.
 *
 * Scale (design §4.3, §12): a memecoin can reach tens of thousands of holders, so the layout draws
 * at most DRAWN_FLOORS floors per tier (plus the player's own floor). The floors past that are
 * *folded*: they keep their numbers and their order, but only their counts reach the renderer,
 * which draws them as the annex towers (§12.2). Visitors and the bench are counted in full and
 * drawn up to a cap.
 */
import type {
  CharacterStatus,
  EmployeeView,
  HolderEntry,
  SubmissionView,
  TaskView,
  TierIndex,
  Tuple4,
  WalletId,
} from "./abi";
import type { ContractConfig } from "./config";
import { appearanceOf, type Appearance } from "./identity";
import { tierOf } from "./tier";

/**
 * Rooms per floor for Directors, Managers, Associates, Interns (D21: same floor width for all;
 * D23: 12 px characters, so 1.5× the desks of the first 16 px art). Must match
 * art/building.mjs ROOM_ANCHORS[tier].perFloor.
 */
export const ROOMS_PER_FLOOR: Tuple4<number> = [6, 9, 12, 18];

/** Building states by employee count (design §12.2). Display constants, not contract config. */
export const BUILDING_STATES = [
  { id: "garage", min: 0 },
  { id: "office", min: 11 },
  { id: "tower", min: 51 },
  { id: "skyscraper", min: 251 },
  { id: "megacorp", min: 1001 },
  { id: "campus", min: 5001 },
  { id: "conglomerate", min: 25001 },
] as const;

/**
 * Floors per tier drawn in the headquarters; the rest fold into the annexes (design §4.3). Kept
 * low so a big company reads as a skyline of towers, not one long column (at most ~24 floors).
 */
export const DRAWN_FLOORS = 6;
/** Visitors that get a character (the queue shows 5 of them, the staff list all drawn ones). */
export const DRAWN_VISITORS = 50;
export type BuildingState = (typeof BUILDING_STATES)[number]["id"];

export function buildingStateOf(employees: number): BuildingState {
  let state: BuildingState = "garage";
  for (const s of BUILDING_STATES) if (employees >= s.min) state = s.id;
  return state;
}

export type DeskResult = "pass" | "miss";

export interface TowerInput {
  config: Pick<ContractConfig, "tier_thresholds_ppm" | "excluded_accounts" | "streak_milestones">;
  totalSupply: bigint;
  holders: readonly Pick<HolderEntry, "account_id" | "balance">[];
  /** Contract employee views (status already derived against the last finalized task). */
  employees: readonly EmployeeView[];
  /** The newest task (`current_task_id`), or null before the first one. */
  task: Pick<TaskView, "id" | "status"> | null;
  /** Submissions to `task`. */
  submissions: readonly SubmissionView[];
  /** Crowd (bot) accounts, from deployment config (design §12.5). Never guessed. */
  isCrowd?: (wallet: WalletId) => boolean;
}

export interface TowerCharacter {
  wallet: WalletId;
  balance: bigint;
  /** Share of total supply in parts per million. */
  sharePpm: number;
  status: CharacterStatus;
  /** The floor's tier: last submission snapshot for employees, current balance for new hires. Null for visitors. */
  tier: TierIndex | null;
  /** Tier of the current balance (null: visitor). */
  balanceTier: TierIndex | null;
  employee: EmployeeView | null;
  streak: number;
  /** Number of streak milestones reached (flame level, P1). */
  flames: number;
  missesInRow: number;
  layoffTasksLeft: number;
  /** This wallet's submission to the newest task, if any. */
  submission: SubmissionView | null;
  /** Paper on the desk: a submission to a task that is not finalized yet. */
  submitted: boolean;
  /** Dot on the desk: the newest task is finalized and this wallet submitted to it. */
  result: DeskResult | null;
  /** Pay allocated for the newest finalized task (0 unless passed and not reapply). */
  pay: bigint;
  crowd: boolean;
  look: Appearance;
}

/** Derives one character per drawn holder (PROTOCOL.md §6.5). Excluded accounts are dropped. */
export function towerCharacters(input: TowerInput): TowerCharacter[] {
  const { config, totalSupply } = input;
  const excluded = new Set(config.excluded_accounts);
  const employees = new Map(input.employees.map((e) => [e.account_id, e]));
  const subs = new Map(input.submissions.map((s) => [s.account_id, s]));
  const finalized = input.task?.status === "finalized";
  const out: TowerCharacter[] = [];
  const seen = new Set<WalletId>();
  for (const h of input.holders) {
    const wallet = h.account_id;
    if (excluded.has(wallet) || seen.has(wallet)) continue;
    seen.add(wallet);
    const balance = BigInt(h.balance);
    if (balance <= 0n) continue;
    const balanceTier = tierOf(balance, totalSupply, config.tier_thresholds_ppm);
    const employee = employees.get(wallet) ?? null;
    let status: CharacterStatus;
    let tier: TierIndex | null;
    if (balanceTier === null) {
      status = "visitor";
      tier = null;
    } else if (!employee) {
      status = "new_hire";
      tier = balanceTier;
    } else {
      status = employee.status;
      tier = employee.last_tier;
    }
    const sub = input.task ? subs.get(wallet) ?? null : null;
    const streak = employee?.effective_streak ?? 0;
    out.push({
      wallet,
      balance,
      sharePpm: totalSupply > 0n ? Number((balance * 1_000_000n) / totalSupply) : 0,
      status,
      tier,
      balanceTier,
      employee,
      streak,
      flames: config.streak_milestones.filter((m) => m <= streak).length,
      missesInRow: employee?.misses_in_row ?? 0,
      layoffTasksLeft: employee?.layoff_tasks_left ?? 0,
      submission: sub,
      submitted: !!sub && !finalized,
      result: sub && finalized ? (sub.passed ? "pass" : "miss") : null,
      pay: sub && finalized && sub.passed ? BigInt(sub.pay) : 0n,
      crowd: input.isCrowd?.(wallet) ?? false,
      look: appearanceOf(wallet),
    });
  }
  return out;
}

/** Desk order (design §4.3): tier, then balance descending, then account id (code-unit order). */
export function compareDesk(a: TowerCharacter, b: TowerCharacter): number {
  const ta = a.tier ?? 4;
  const tb = b.tier ?? 4;
  if (ta !== tb) return ta - tb;
  if (a.balance !== b.balance) return a.balance > b.balance ? -1 : 1;
  return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
}

export interface TowerFloor {
  /** Stable key, e.g. `t2f0` (tier 2, its first floor). */
  key: string;
  tier: TierIndex;
  /** 0 = the tier's top floor. */
  index: number;
  /** Exactly ROOMS_PER_FLOOR[tier] entries; null = empty room. */
  desks: (TowerCharacter | null)[];
}

/**
 * A run of consecutive floors of one tier that the headquarters does not draw (design §4.3). Its
 * floors work in the annex towers; the counts are exact, so the picture still tells the truth.
 */
export interface TowerFold {
  /** Stable key, e.g. `t3f40-8333` (tier 3, floors 40 to 8,333). */
  key: string;
  tier: TierIndex;
  /** First and last folded floor, as tier floor indices (0 = the tier's top floor). */
  from: number;
  to: number;
  /** Index into `TowerLayout.floors` of the first drawn floor below the fold (`floors.length` if none). */
  before: number;
  employees: number;
  /** Desks with paper on them (submitted, not finalized yet). */
  submitted: number;
  passed: number;
  missed: number;
  laidOff: number;
}

export interface DeskRef {
  /** Index into `TowerLayout.floors`. */
  floor: number;
  room: number;
}

export interface TowerLayout {
  state: BuildingState;
  /** Characters with a desk (new hires, active, struggling, laid off). */
  employees: number;
  /** Desk holders per tier. */
  tierCounts: Tuple4<number>;
  /** Drawn floors, top to bottom: Director floors first, Intern floors last. Every tier has at least one. */
  floors: TowerFloor[];
  /** Folded floor runs, top to bottom (empty below DRAWN_FLOORS floors per tier). */
  folds: TowerFold[];
  /** Floors folded into the annexes, all tiers. */
  foldedFloors: number;
  /** Drawn visitors in queue order (balance descending, then id), at most DRAWN_VISITORS. */
  visitors: TowerCharacter[];
  /** All visitors. */
  visitorCount: number;
  /** Laid-off employees with a drawn desk, in desk order (they sit on the street bench, their desk stays dimmed). */
  bench: TowerCharacter[];
  /** All laid-off employees, folded ones included. */
  benchCount: number;
  /** Every drawn character: desk holders in desk order, then drawn visitors. */
  characters: TowerCharacter[];
  desks: ReadonlyMap<WalletId, DeskRef>;
}

export interface LayoutOptions {
  /** The player's wallet: their floor is always drawn, even past DRAWN_FLOORS. */
  you?: WalletId | null;
  /** Floors drawn per tier (default DRAWN_FLOORS). */
  drawnFloors?: number;
}

/** Lays characters out into floors (design §4.3). */
export function layoutTower(characters: readonly TowerCharacter[], opts: LayoutOptions = {}): TowerLayout {
  const drawnPerTier = Math.max(1, opts.drawnFloors ?? DRAWN_FLOORS);
  const staff = characters.filter((c) => c.tier !== null).sort(compareDesk);
  const allVisitors = characters.filter((c) => c.tier === null).sort(compareDesk);
  const tierCounts: Tuple4<number> = [0, 0, 0, 0];
  for (const c of staff) tierCounts[c.tier!]++;
  const floors: TowerFloor[] = [];
  const folds: TowerFold[] = [];
  const desks = new Map<WalletId, DeskRef>();
  const drawn: TowerCharacter[] = [];
  let k = 0;
  let foldedFloors = 0;
  for (const tier of [0, 1, 2, 3] as const) {
    const per = ROOMS_PER_FLOOR[tier];
    const n = tierCounts[tier];
    const count = Math.max(1, Math.ceil(n / per));
    let yourFloor = -1;
    if (opts.you && count > drawnPerTier) {
      for (let i = drawnPerTier * per; i < n; i++) {
        if (staff[k + i]!.wallet === opts.you) {
          yourFloor = Math.floor(i / per);
          break;
        }
      }
    }
    let fold: TowerFold | null = null;
    for (let f = 0; f < count; f++) {
      if (f >= drawnPerTier && f !== yourFloor) {
        if (!fold) {
          fold = { key: "", tier, from: f, to: f, before: 0, employees: 0, submitted: 0, passed: 0, missed: 0, laidOff: 0 };
          folds.push(fold);
        }
        fold.to = f;
        foldedFloors++;
        for (let r = 0; r < per && f * per + r < n; r++) {
          const c = staff[k + f * per + r]!;
          fold.employees++;
          if (c.submitted) fold.submitted++;
          if (c.result === "pass") fold.passed++;
          else if (c.result === "miss") fold.missed++;
          if (c.status === "laid_off") fold.laidOff++;
        }
        continue;
      }
      if (fold) {
        fold.key = `t${tier}f${fold.from}-${fold.to}`;
        fold.before = floors.length;
        fold = null;
      }
      const desksOnFloor: (TowerCharacter | null)[] = [];
      for (let r = 0; r < per; r++) {
        const i = f * per + r;
        if (i < n) {
          const c = staff[k + i]!;
          desks.set(c.wallet, { floor: floors.length, room: r });
          desksOnFloor.push(c);
          drawn.push(c);
        } else desksOnFloor.push(null);
      }
      floors.push({ key: `t${tier}f${f}`, tier, index: f, desks: desksOnFloor });
    }
    if (fold) {
      fold.key = `t${tier}f${fold.from}-${fold.to}`;
      fold.before = -1; // fixed below: the next drawn floor may belong to a later tier
      fold = null;
    }
    k += n;
  }
  // A fold at the end of a tier sits before the next tier's first floor (or the lobby).
  for (const f of folds) {
    if (f.before !== -1) continue;
    const next = floors.findIndex((fl) => fl.tier > f.tier);
    f.before = next === -1 ? floors.length : next;
  }
  const visitors = allVisitors.slice(0, DRAWN_VISITORS);
  return {
    state: buildingStateOf(staff.length),
    employees: staff.length,
    tierCounts,
    floors,
    folds,
    foldedFloors,
    visitors,
    visitorCount: allVisitors.length,
    bench: drawn.filter((c) => c.status === "laid_off"),
    benchCount: staff.reduce((a, c) => a + (c.status === "laid_off" ? 1 : 0), 0),
    characters: [...drawn, ...visitors],
    desks,
  };
}

export function buildTower(input: TowerInput, opts: LayoutOptions = {}): TowerLayout {
  return layoutTower(towerCharacters(input), opts);
}
