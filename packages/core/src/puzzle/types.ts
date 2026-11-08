// Puzzle types (roadmap §6.1). A "family" is a kind of daily task the scheduler can pick; the
// scheduler only sees this interface, so new families (acrostic, sequence, ...) plug in later.
export type Level = 1 | 2 | 3 | 4 | 5;

export type CipherId =
  | "caesar"
  | "atbash"
  | "reversed-words"
  | "a1z26"
  | "keyboard-shift"
  | "vigenere"
  | "morse"
  | "hex"
  | "base64"
  | "rail-fence";

export interface PuzzleParams {
  family: "decode-memo";
  cipher: CipherId;
  level: Level;
}

export type FamilyId = PuzzleParams["family"];

export interface GeneratedPuzzle {
  /** What the employee sees (the encoded memo). */
  display: string;
  /** What the employee is told about the cipher and key. Sufficient to solve from `display`. */
  hint: string;
  /** The protocol code for this wallet (PROTOCOL.md section 4). Never shown. */
  expectedAnswer: string;
}

export interface PuzzleFamily {
  readonly id: FamilyId;
  /**
   * True (default) if `display` is meant to be read as text, so the money-word check applies to it.
   * False for ciphertext: random letters may spell a word by coincidence, and the hidden memo is
   * covered by the vocabulary test instead.
   */
  readonly displayIsText?: boolean;
  /** Pure and deterministic in (params, daySecret, wallet). */
  generate(params: PuzzleParams, daySecret: Uint8Array, wallet: string): GeneratedPuzzle;
  /** Every answer candidate consistent with display + hint alone. Uses no secret. */
  solve(display: string, hint: string): string[];
  /** Estimated seconds for a human to solve it; must stay within the 60 s budget. */
  estimateSeconds(params: PuzzleParams, display: string): number;
}

export const SOLVE_BUDGET_SECONDS = 60;
