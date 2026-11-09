/**
 * Display formatting. Units are display config, kept here so a different chain is a one-file
 * change (CLAUDE.md "Keeping the code portable"): payouts are in the chain's native coin, the
 * token is $REORG.
 */
import type { WalletId } from "@reorg/core";

export const UNITS = {
  payoutSymbol: "NEAR",
  payoutDecimals: 24,
  tokenSymbol: "$REORG",
  tokenDecimals: 18,
};

/** Fixed-point bigint → string with at most `digits` decimals, trailing zeros trimmed. */
export function fixed(value: bigint, decimals: number, digits: number): string {
  const neg = value < 0n;
  let v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const round = digits < decimals ? 10n ** BigInt(decimals - digits) / 2n : 0n;
  v += round;
  const whole = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0").slice(0, digits);
  frac = frac.replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  return `${neg ? "−" : ""}${w}${frac ? "." + frac : ""}`;
}

/** Payout amount, e.g. "0.45 NEAR". Small non-zero amounts keep 2 significant digits. */
export function payout(yocto: bigint | string, opts: { symbol?: boolean; digits?: number } = {}): string {
  const v = BigInt(yocto);
  let digits = opts.digits ?? 2;
  const scale = 10n ** BigInt(UNITS.payoutDecimals);
  if (v !== 0n && (v < 0n ? -v : v) < scale / 100n) {
    // e.g. 0.0042: show enough decimals for two significant digits (cap 6).
    const s = ((v < 0n ? -v : v) * 10n ** 6n) / scale;
    digits = s >= 1000n ? 3 : s >= 100n ? 4 : s >= 10n ? 5 : 6;
  }
  const n = fixed(v, UNITS.payoutDecimals, digits);
  return opts.symbol === false ? n : `${n} ${UNITS.payoutSymbol}`;
}

/** Token amount, e.g. "12.5M $REORG". */
export function tokens(units: bigint | string, opts: { symbol?: boolean } = {}): string {
  const v = BigInt(units) / 10n ** BigInt(UNITS.tokenDecimals);
  const n = Number(v);
  const s =
    n >= 1e9 ? `${trim(n / 1e9)}B` : n >= 1e6 ? `${trim(n / 1e6)}M` : n >= 1e4 ? `${trim(n / 1e3)}K` : n.toLocaleString("en-US");
  return opts.symbol === false ? s : `${s} ${UNITS.tokenSymbol}`;
}
const trim = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, "");

/** Share of supply from parts per million, e.g. "3.12%", "0.051%". */
export function share(ppm: number): string {
  const pct = ppm / 10_000;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

/** A short display name: the first label of a named account, or an elided implicit account. */
export function shortName(wallet: WalletId): string {
  if (/^[0-9a-f]{64}$/.test(wallet) || /^0x[0-9a-f]{40}$/i.test(wallet)) return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  const first = wallet.split(".")[0] ?? wallet;
  return first.length > 18 ? `${first.slice(0, 16)}…` : first;
}

/** "4:12" from milliseconds (never negative). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export const TIER_TITLES = ["Director", "Manager", "Associate", "Intern"] as const;
export const TIER_PLURALS = ["Directors", "Managers", "Associates", "Interns"] as const;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
