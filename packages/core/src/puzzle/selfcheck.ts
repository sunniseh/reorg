// B-04: the solve-check. Before a task opens, the boss generates the day's puzzle for 64
// synthetic wallets and *solves each from the displayed text and hint only*; the puzzle ships
// only if exactly one code-format candidate exists and it equals the protocol code. Any failure
// switches the day to the always-valid level-1 Caesar fallback, so a day is never skipped.
import { deriveCode, sha256Bytes, toHex } from "../crypto";
import { FAMILIES } from "./families";
import { SOLVE_BUDGET_SECONDS, type FamilyId, type GeneratedPuzzle, type PuzzleFamily, type PuzzleParams } from "./types";
import { containsMoneyWord } from "./words";

const enc = new TextEncoder();

function syntheticWallet(i: number): string {
  const h = toHex(sha256Bytes(enc.encode(`reorg/selfcheck-wallet/${i}`)));
  switch (i % 4) {
    case 0:
      return `employee-${i}.testnet`; // named account
    case 1:
      return h; // implicit account (64 hex)
    case 2:
      return `0x${h.slice(0, 40)}`; // EVM-style
    default:
      return `${h.slice(0, 8)}.sub${i}.reorg.testnet`; // sub-account
  }
}

/** 64 deterministic wallets in several address styles (wallet is an opaque string). */
export const SELF_CHECK_WALLETS: readonly string[] = Array.from({ length: 64 }, (_, i) => syntheticWallet(i));

export interface SelfCheckReport {
  ok: boolean;
  /** First failures, "<wallet>: <reason>" (capped). */
  failures: string[];
  checked: number;
}

const MAX_FAILURES = 20;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function selfCheckFamily(
  family: PuzzleFamily,
  params: PuzzleParams,
  daySecret: Uint8Array,
  wallets: readonly string[] = SELF_CHECK_WALLETS,
): SelfCheckReport {
  const failures: string[] = [];
  let failed = 0;
  const fail = (wallet: string, reason: string): void => {
    failed++;
    if (failures.length < MAX_FAILURES) failures.push(`${wallet}: ${reason}`);
  };

  for (const wallet of wallets) {
    let p: GeneratedPuzzle;
    let protocolCode: string;
    try {
      protocolCode = deriveCode(daySecret, wallet);
      p = family.generate(params, daySecret, wallet);
    } catch (e) {
      fail(wallet, `generate threw: ${errMsg(e)}`);
      continue;
    }
    if (p.expectedAnswer !== protocolCode) fail(wallet, "expectedAnswer is not the protocol code");
    const displayChecked = family.displayIsText ?? true;
    if ((displayChecked && containsMoneyWord(p.display)) || containsMoneyWord(p.hint)) {
      fail(wallet, "money word in display or hint");
    }
    if (p.display.includes(p.expectedAnswer) || p.hint.includes(p.expectedAnswer)) fail(wallet, "puzzle leaks the answer");
    const seconds = family.estimateSeconds(params, p.display);
    if (!(seconds <= SOLVE_BUDGET_SECONDS)) fail(wallet, `estimated ${Math.round(seconds)} s exceeds the budget`);

    let candidates: string[];
    try {
      candidates = [...new Set(family.solve(p.display, p.hint))];
    } catch (e) {
      fail(wallet, `solver threw: ${errMsg(e)}`);
      continue;
    }
    if (candidates.length !== 1) fail(wallet, `${candidates.length} candidates (need exactly 1)`);
    else if (candidates[0] !== p.expectedAnswer) fail(wallet, "the solver's only candidate is not the expected answer");
  }
  return { ok: failed === 0, failures, checked: wallets.length };
}

export interface CheckOptions {
  /** Override family implementations (tests, future families). */
  families?: Partial<Record<FamilyId, PuzzleFamily>>;
  wallets?: readonly string[];
}

export function selfCheck(params: PuzzleParams, daySecret: Uint8Array, opts: CheckOptions = {}): SelfCheckReport {
  const family = opts.families?.[params.family] ?? FAMILIES[params.family];
  return selfCheckFamily(family, params, daySecret, opts.wallets);
}

/** Always valid (a Caesar shift is trivially invertible), so the fallback can never skip a day. */
export const FALLBACK_PARAMS: PuzzleParams = { family: "decode-memo", cipher: "caesar", level: 1 };

export interface ResolvedDay {
  /** The params the day will actually use. */
  params: PuzzleParams;
  usedFallback: boolean;
  /** Check result for `params`. If this is not ok, even the fallback failed: raise an alarm. */
  report: SelfCheckReport;
  /** Check result for the params the scheduler asked for. */
  requestedReport: SelfCheckReport;
}

export function resolveDayParams(params: PuzzleParams, daySecret: Uint8Array, opts: CheckOptions = {}): ResolvedDay {
  const requestedReport = selfCheck(params, daySecret, opts);
  if (requestedReport.ok) return { params, usedFallback: false, report: requestedReport, requestedReport };
  const report = selfCheck(FALLBACK_PARAMS, daySecret, opts);
  return { params: FALLBACK_PARAMS, usedFallback: true, report, requestedReport };
}
