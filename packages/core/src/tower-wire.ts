/**
 * The tower layout on the wire (design §4.3, §12; boss `GET /api/tower`). A memecoin can have
 * tens of thousands of holders, too many for every browser to page through on each refresh, so
 * past a size the boss service reads the chain once, lays the tower out with `layoutTower()` and
 * serves the result. Only the drawn characters travel; folds carry the exact counts.
 *
 * JSON-safe: bigints are decimal strings, the desk map is rebuilt from the floors, and appearance
 * and crowd labels are derived again on the client (they are functions of the wallet and the
 * deployment config, never of the server's word).
 */
import type { CharacterStatus, EmployeeView, SubmissionView, TierIndex, Tuple4, WalletId } from "./abi";
import { appearanceOf } from "./identity";
import type { BuildingState, DeskRef, DeskResult, TowerCharacter, TowerFloor, TowerFold, TowerLayout } from "./tower";

export interface CharacterWire {
  wallet: WalletId;
  balance: string;
  sharePpm: number;
  status: CharacterStatus;
  tier: TierIndex | null;
  balanceTier: TierIndex | null;
  employee: EmployeeView | null;
  streak: number;
  flames: number;
  missesInRow: number;
  layoffTasksLeft: number;
  submission: SubmissionView | null;
  submitted: boolean;
  result: DeskResult | null;
  pay: string;
}

export interface TowerWire {
  v: 1;
  state: BuildingState;
  employees: number;
  tierCounts: Tuple4<number>;
  /** Desks hold indices into `characters` (null: an empty room). */
  floors: { key: string; tier: TierIndex; index: number; desks: (number | null)[] }[];
  folds: TowerFold[];
  foldedFloors: number;
  /** Indices into `characters`. */
  visitors: number[];
  visitorCount: number;
  benchCount: number;
  characters: CharacterWire[];
}

export function encodeTower(l: TowerLayout): TowerWire {
  const index = new Map(l.characters.map((c, i) => [c.wallet, i]));
  const at = (c: TowerCharacter) => index.get(c.wallet)!;
  return {
    v: 1,
    state: l.state,
    employees: l.employees,
    tierCounts: [...l.tierCounts],
    floors: l.floors.map((f) => ({ key: f.key, tier: f.tier, index: f.index, desks: f.desks.map((c) => (c ? at(c) : null)) })),
    folds: l.folds.map((f) => ({ ...f })),
    foldedFloors: l.foldedFloors,
    visitors: l.visitors.map(at),
    visitorCount: l.visitorCount,
    benchCount: l.benchCount,
    characters: l.characters.map(({ look: _look, crowd: _crowd, balance, pay, ...rest }) => ({ ...rest, balance: balance.toString(), pay: pay.toString() })),
  };
}

/** Rebuilds a layout; throws on a malformed payload (a boss bug must not draw a wrong tower). */
export function decodeTower(w: TowerWire, opts: { isCrowd?: (wallet: WalletId) => boolean } = {}): TowerLayout {
  if (w?.v !== 1 || !Array.isArray(w.characters) || !Array.isArray(w.floors)) throw new Error("tower: unknown payload");
  const characters: TowerCharacter[] = w.characters.map((c) => ({
    ...c,
    balance: BigInt(c.balance),
    pay: BigInt(c.pay),
    crowd: opts.isCrowd?.(c.wallet) ?? false,
    look: appearanceOf(c.wallet),
  }));
  const char = (i: number): TowerCharacter => {
    const c = characters[i];
    if (!c) throw new Error(`tower: no character ${i}`);
    return c;
  };
  const desks = new Map<WalletId, DeskRef>();
  const floors: TowerFloor[] = w.floors.map((f, fi) => ({
    key: f.key,
    tier: f.tier,
    index: f.index,
    desks: f.desks.map((i, room) => {
      if (i === null) return null;
      const c = char(i);
      desks.set(c.wallet, { floor: fi, room });
      return c;
    }),
  }));
  const drawn = floors.flatMap((f) => f.desks.filter((c): c is TowerCharacter => c !== null));
  return {
    state: w.state,
    employees: w.employees,
    tierCounts: [...w.tierCounts],
    floors,
    folds: w.folds.map((f) => ({ ...f })),
    foldedFloors: w.foldedFloors,
    visitors: w.visitors.map(char),
    visitorCount: w.visitorCount,
    bench: drawn.filter((c) => c.status === "laid_off"),
    benchCount: w.benchCount,
    characters,
    desks,
  };
}
