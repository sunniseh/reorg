// Registry of puzzle families. The scheduler (B-08/B-09) only talks to this module, so a new
// family (acrostic, sequence, ...) is one entry here plus its own PuzzleFamily implementation.
import { decodeMemoFamily } from "./decode-memo";
import type { FamilyId, GeneratedPuzzle, PuzzleFamily, PuzzleParams } from "./types";

export const FAMILIES: Readonly<Record<FamilyId, PuzzleFamily>> = {
  "decode-memo": decodeMemoFamily,
};

function familyOf(id: FamilyId): PuzzleFamily {
  const family = FAMILIES[id];
  if (!family) throw new Error(`unknown puzzle family ${String(id)}`);
  return family;
}

/** B-03: the puzzle shown to `wallet`. Pure and deterministic in (params, daySecret, wallet). */
export function generatePuzzle(params: PuzzleParams, daySecret: Uint8Array, wallet: string): GeneratedPuzzle {
  return familyOf(params.family).generate(params, daySecret, wallet);
}

/** Every answer consistent with display + hint (what the self-check runs). Uses no secret. */
export function solvePuzzle(family: FamilyId, display: string, hint: string): string[] {
  return familyOf(family).solve(display, hint);
}
