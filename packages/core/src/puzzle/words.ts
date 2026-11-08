// Memo wording and the money-word blocklist. Tasks must never involve money (CLAUDE.md), and
// the same check guards LLM flavor text (B-05). Memos are built from a grammar, so there are
// thousands of distinct memos, all A-Z plus single spaces (every cipher can encode them).
import type { PuzzleRng } from "./rng";

const MONEY_WORDS: ReadonlySet<string> = new Set(
  (
    "CASH MONEY PAY PAID PAYMENT PAYROLL PAYDAY SALARY WAGE BONUS PRICE COST FEE BUY SELL SOLD TRADE " +
    "TOKEN COIN DOLLAR USD EUR INVOICE BUDGET PROFIT REFUND TAX TAXES LOAN DEBT CREDIT DEBIT WALLET " +
    "RICH POOR EARN EARNING EARNINGS INCOME BANK PRIZE REWARD JACKPOT BET CRYPTO BITCOIN REORG"
  ).split(" "),
);

const CURRENCY_SYMBOLS = /[$€£¥₿¢]/;

/** True if the text mentions money: a listed word (singular or plural, any case) or a currency symbol. */
export function containsMoneyWord(text: string): boolean {
  if (CURRENCY_SYMBOLS.test(text)) return true;
  for (const token of text.toUpperCase().match(/[A-Z]+/g) ?? []) {
    if (MONEY_WORDS.has(token)) return true;
    if (token.endsWith("S") && MONEY_WORDS.has(token.slice(0, -1))) return true;
  }
  return false;
}

const DEPARTMENTS = [
  "FACILITIES", "COMPLIANCE", "LOGISTICS", "WELLNESS", "ARCHIVES", "INNOVATION", "SECURITY",
  "CATERING", "MORALE", "ENGAGEMENT", "SYNERGY", "STATIONERY", "HOSPITALITY", "ALIGNMENT",
] as const;

const AUDIENCES = [
  "ALL STAFF", "ALL INTERNS", "EVERY DESK", "THE ASSOCIATES", "ALL MANAGERS", "THE DIRECTORS",
  "THE LOBBY", "FLOOR THREE", "ANYONE WITH A BADGE",
] as const;

const SUBJECTS = [
  "THE FRIDAY STAPLER AUDIT", "THE ELEVATOR ETIQUETTE REVIEW", "THE KITCHEN FRIDGE CLEANUP",
  "A MANDATORY SYNERGY WORKSHOP", "THE WINDOW BLINDS POLICY", "THE QUARTERLY DESK PLANT CENSUS",
  "THE NEW LANYARD COLOR SCHEME", "THE PRINTER JAM INQUIRY", "THE OPEN PLAN SEATING SHUFFLE",
  "THE MEETING ABOUT MEETINGS", "THE SHARED MUG AMNESTY",
] as const;

const STATES = [
  "IS MANDATORY", "IS POSTPONED", "IS NOW OPEN", "IS UNDER REVIEW", "IS STRICTLY OPTIONAL",
  "HAS BEEN RESCHEDULED", "IS CANCELLED UNTIL FURTHER NOTICE",
] as const;

const ACTIONS = [
  "PLEASE TIDY YOUR DESK BY NOON", "PLEASE WATER THE PLANTS BEFORE LUNCH",
  "PLEASE ACKNOWLEDGE THIS MEMO TODAY", "PLEASE SMILE AT THE CAMERAS",
  "PLEASE RETURN BORROWED STAPLERS TO FACILITIES", "KINDLY STOP MICROWAVING FISH",
  "PLEASE LABEL YOUR LUNCH", "PLEASE KEEP THE STAIRWELL CLEAR",
] as const;

const EXTRAS = [
  "ATTENDANCE WILL BE NOTED", "HUMAN RESOURCES IS WATCHING", "THIS IS NOT A DRILL",
  "QUESTIONS SHOULD BE DIRECTED TO THE SUGGESTION BOX", "THANK YOU FOR YOUR CONTINUED SYNERGY",
  "BE ADVISED THAT ENTHUSIASM IS EXPECTED",
] as const;

/** Vigenere keywords by length (money-free, no 8-letter code lookalikes; checked by the tests). */
export const KEYWORDS: Readonly<Record<4 | 5 | 7, readonly string[]>> = {
  4: ["DESK", "MAIL", "LAMP", "FILE", "FORM", "COPY"],
  5: ["BADGE", "LUNCH", "PLANT", "CHAIR", "PAPER", "STAIR"],
  7: ["STAPLER", "CABINET", "LANYARD", "KITCHEN", "BINDERS", "CLIPPED"],
};

const FIXED = ["MEMO FROM TO CLEARANCE WORD IS"];

/** Every word the memo grammar and cipher keywords can emit. The tests check each one. */
export const MEMO_VOCABULARY: readonly string[] = [
  ...new Set(
    [...FIXED, ...DEPARTMENTS, ...AUDIENCES, ...SUBJECTS, ...STATES, ...ACTIONS, ...EXTRAS, ...Object.values(KEYWORDS).flat()]
      .join(" ")
      .split(" "),
  ),
];

/**
 * `clauses` 1..4: 1 = headline only, 2 adds an instruction, 3-4 add notices.
 * The code is always the last word, after "CLEARANCE WORD IS".
 */
export function buildMemo(rng: PuzzleRng, clauses: number, code: string): string {
  const parts = [
    `MEMO FROM ${rng.pick(DEPARTMENTS)} TO ${rng.pick(AUDIENCES)}`,
    `${rng.pick(SUBJECTS)} ${rng.pick(STATES)}`,
  ];
  if (clauses >= 2) parts.push(rng.pick(ACTIONS));
  if (clauses >= 3) parts.push(...rng.pickDistinct(EXTRAS, clauses - 2));
  parts.push(`CLEARANCE WORD IS ${code}`);
  return parts.join(" ");
}
