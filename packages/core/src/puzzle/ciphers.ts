// B-02: the ciphers of "Decode the Memo". Each cipher can encode a memo (A-Z and single spaces)
// and, separately, *solve* a puzzle from the displayed text and the hint alone. The solver
// enumerates every key the hint allows. That is what makes the self-check (B-04) meaningful.
import type { PuzzleRng } from "./rng";
import type { CipherId, Level } from "./types";
import { KEYWORDS } from "./words";

export interface Cipher {
  readonly id: CipherId;
  /** Every hint for this cipher starts with this label; the solver recognizes the cipher by it. */
  readonly label: string;
  /** Heuristic human seconds per displayed character (tool use allowed); feeds the 60 s budget. */
  readonly secondsPerChar: number;
  /** Longest memo (see memoClauses) this cipher keeps inside the budget. */
  readonly maxClauses: number;
  generate(level: Level, plain: string, rng: PuzzleRng): { display: string; hint: string };
  /** Plaintexts for every key the hint allows. Uses only `display` and `hint`. */
  candidates(display: string, hint: string): string[];
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const places = (n: number): string => `${n} place${n === 1 ? "" : "s"}`;

/** Apply f(letterIndex 0..25, letterOrdinal) to every A-Z letter; everything else is kept. */
function mapLetters(s: string, f: (letter: number, ordinal: number) => number): string {
  let out = "";
  let ordinal = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) out += String.fromCharCode(65 + mod(f(c - 65, ordinal++), 26));
    else out += s.charAt(i);
  }
  return out;
}

/** Parse "N" or "N to M" from the first capture groups of `re`; null if absent or out of bounds. */
function parseRange(hint: string, re: RegExp, min: number, max: number): [number, number] | null {
  const m = re.exec(hint);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || hi < lo) return null;
  return [lo, hi];
}

// --- Caesar -------------------------------------------------------------------------------

const caesar: Cipher = {
  id: "caesar",
  label: "Caesar cipher",
  secondsPerChar: 0.15,
  maxClauses: 4,
  generate(level, plain, rng) {
    const shift = 1 + rng.int(25);
    const width = level <= 1 ? 1 : 5;
    const lo = width === 1 ? shift : Math.min(Math.max(1, shift - rng.int(width)), 26 - width);
    const hi = lo + width - 1;
    const by = width === 1 ? places(shift) : `${lo} to ${hi} places`;
    return {
      display: mapLetters(plain, (l) => l + shift),
      hint: `Caesar cipher: every letter was moved forward by ${by}.`,
    };
  },
  candidates(display, hint) {
    const r = parseRange(hint, /moved forward by (\d+)(?: to (\d+))? places?\./, 1, 25);
    if (!r) return [];
    const out: string[] = [];
    for (let k = r[0]; k <= r[1]; k++) out.push(mapLetters(display, (l) => l - k));
    return out;
  },
};

// --- Atbash -------------------------------------------------------------------------------

const atbash: Cipher = {
  id: "atbash",
  label: "Atbash cipher",
  secondsPerChar: 0.15,
  maxClauses: 4,
  generate(_level, plain) {
    return {
      display: mapLetters(plain, (l) => 25 - l),
      hint: "Atbash cipher: the alphabet is mirrored, so A becomes Z, B becomes Y, and so on.",
    };
  },
  candidates(display) {
    return [mapLetters(display, (l) => 25 - l)];
  },
};

// --- Reversed words -----------------------------------------------------------------------

const reverseWords = (s: string): string =>
  s
    .split(" ")
    .map((w) => [...w].reverse().join(""))
    .join(" ");

const reversedWords: Cipher = {
  id: "reversed-words",
  label: "Reversed words",
  secondsPerChar: 0.12,
  maxClauses: 4,
  generate(_level, plain) {
    return { display: reverseWords(plain), hint: "Reversed words: every word was spelled backwards." };
  },
  candidates(display) {
    return [reverseWords(display)];
  },
};

// --- A1Z26 --------------------------------------------------------------------------------

const a1z26: Cipher = {
  id: "a1z26",
  label: "A1Z26 cipher",
  secondsPerChar: 0.08,
  maxClauses: 2,
  generate(_level, plain) {
    const display = plain
      .split(" ")
      .map((w) => [...w].map((c) => c.charCodeAt(0) - 64).join("-"))
      .join(" / ");
    return {
      display,
      hint: "A1Z26 cipher: A is 1, B is 2, and so on up to Z is 26. Dashes separate letters and slashes separate words.",
    };
  },
  candidates(display) {
    const words: string[] = [];
    for (const word of display.split(" / ")) {
      let w = "";
      for (const n of word.split("-")) {
        const v = /^\d{1,2}$/.test(n) ? Number(n) : 0;
        if (v < 1 || v > 26) return [];
        w += String.fromCharCode(64 + v);
      }
      words.push(w);
    }
    return [words.join(" ")];
  },
};

// --- Keyboard shift -----------------------------------------------------------------------

const ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"] as const;
const KEY_POS = new Map<string, readonly [number, number]>();
ROWS.forEach((row, r) => [...row].forEach((ch, i) => KEY_POS.set(ch, [r, i])));

function shiftKeys(s: string, delta: number): string {
  let out = "";
  for (const ch of s) {
    const pos = KEY_POS.get(ch);
    if (!pos) {
      out += ch;
      continue;
    }
    const row = ROWS[pos[0]] as string;
    out += row.charAt(mod(pos[1] + delta, row.length));
  }
  return out;
}

const keyboardShift: Cipher = {
  id: "keyboard-shift",
  label: "Keyboard cipher",
  secondsPerChar: 0.15,
  maxClauses: 4,
  generate(_level, plain, rng) {
    const shift = 1 + rng.int(3);
    return {
      display: shiftKeys(plain, shift),
      hint: `Keyboard cipher: every letter was replaced by the key ${places(shift)} to its right on the same QWERTY row, wrapping around the row.`,
    };
  },
  candidates(display, hint) {
    const r = parseRange(hint, /the key (\d+) places? to its right/, 1, 9);
    if (!r) return [];
    const out: string[] = [];
    for (let k = r[0]; k <= r[1]; k++) out.push(shiftKeys(display, -k));
    return out;
  },
};

// --- Vigenere -----------------------------------------------------------------------------

const vigenere: Cipher = {
  id: "vigenere",
  label: "Vigenere cipher",
  secondsPerChar: 0.2,
  maxClauses: 3,
  generate(level, plain, rng) {
    const len = level >= 5 ? 7 : level === 4 ? 5 : 4;
    const keyword = rng.pick(KEYWORDS[len]);
    return {
      display: mapLetters(plain, (l, o) => l + (keyword.charCodeAt(o % keyword.length) - 65)),
      hint: `Vigenere cipher with the keyword ${keyword}. Spaces are skipped.`,
    };
  },
  candidates(display, hint) {
    const m = /keyword ([A-Z]{2,12})\./.exec(hint);
    if (!m) return [];
    const keyword = m[1] as string;
    return [mapLetters(display, (l, o) => l - (keyword.charCodeAt(o % keyword.length) - 65))];
  },
};

// --- Morse --------------------------------------------------------------------------------

const MORSE: Readonly<Record<string, string>> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..",
  J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.",
  S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
};
const MORSE_REVERSE = new Map(Object.entries(MORSE).map(([k, v]) => [v, k] as const));

const morse: Cipher = {
  id: "morse",
  label: "Morse code",
  secondsPerChar: 0.06,
  maxClauses: 2,
  generate(_level, plain) {
    const display = plain
      .split(" ")
      .map((w) => [...w].map((c) => MORSE[c] as string).join(" "))
      .join(" / ");
    return {
      display,
      hint: "Morse code: dots and dashes, a space between letters and a slash between words.",
    };
  },
  candidates(display) {
    const words: string[] = [];
    for (const word of display.split(" / ")) {
      let w = "";
      for (const sym of word.split(" ")) {
        const ch = MORSE_REVERSE.get(sym);
        if (ch === undefined) return [];
        w += ch;
      }
      words.push(w);
    }
    return [words.join(" ")];
  },
};

// --- Hex ----------------------------------------------------------------------------------

const hex: Cipher = {
  id: "hex",
  label: "Hexadecimal",
  secondsPerChar: 0.05,
  maxClauses: 2,
  generate(_level, plain) {
    const display = [...plain].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")).join(" ");
    return { display, hint: "Hexadecimal: ASCII text written as hexadecimal bytes separated by spaces." };
  },
  candidates(display) {
    if (!/^[0-9A-F]{2}( [0-9A-F]{2})*$/.test(display)) return [];
    let out = "";
    for (const pair of display.split(" ")) {
      const v = parseInt(pair, 16);
      if (v < 0x20 || v > 0x7e) return [];
      out += String.fromCharCode(v);
    }
    return [out];
  },
};

// --- Base64 -------------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += b1 === undefined ? "=" : B64.charAt((n >> 6) & 63);
    out += b2 === undefined ? "=" : B64.charAt(n & 63);
  }
  return out;
}

function b64decode(s: string): number[] | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    const pad = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (j >= 4 - pad ? 0 : B64.indexOf(chunk.charAt(j)));
    out.push((n >> 16) & 255);
    if (pad < 2) out.push((n >> 8) & 255);
    if (pad < 1) out.push(n & 255);
  }
  return out;
}

const base64: Cipher = {
  id: "base64",
  label: "Base64",
  secondsPerChar: 0.1,
  maxClauses: 3,
  generate(_level, plain) {
    return {
      display: b64encode([...plain].map((c) => c.charCodeAt(0))),
      hint: "Base64: standard alphabet with = padding.",
    };
  },
  candidates(display) {
    const bytes = b64decode(display);
    if (!bytes) return [];
    let out = "";
    for (const v of bytes) {
      if (v < 0x20 || v > 0x7e) return [];
      out += String.fromCharCode(v);
    }
    return [out];
  },
};

// --- Rail fence ---------------------------------------------------------------------------

/** Positions 0..n-1 in the order a zigzag over `rails` rails reads them off (rail by rail). */
function railOrder(n: number, rails: number): number[] {
  const cycle = 2 * (rails - 1);
  const railOf = (i: number): number => {
    const m = i % cycle;
    return m < rails ? m : cycle - m;
  };
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => railOf(a) - railOf(b) || a - b);
}

function railEncode(s: string, rails: number): string {
  return railOrder(s.length, rails)
    .map((i) => s.charAt(i))
    .join("");
}

function railDecode(s: string, rails: number): string {
  const out: string[] = new Array<string>(s.length).fill("");
  railOrder(s.length, rails).forEach((pos, j) => {
    out[pos] = s.charAt(j);
  });
  return out.join("");
}

const railFence: Cipher = {
  id: "rail-fence",
  label: "Rail-fence cipher",
  secondsPerChar: 0.2,
  maxClauses: 2,
  generate(level, plain, rng) {
    if (level >= 5) {
      const rails = 2 + rng.int(3);
      return {
        display: railEncode(plain, rails),
        hint: "Rail-fence cipher (zigzag, starting on the top rail) with 2 to 4 rails.",
      };
    }
    const rails = 3 + rng.int(2);
    return {
      display: railEncode(plain, rails),
      hint: `Rail-fence cipher (zigzag, starting on the top rail) with ${rails} rails.`,
    };
  },
  candidates(display, hint) {
    const r = parseRange(hint, /with (\d+)(?: to (\d+))? rails\./, 2, 8);
    if (!r) return [];
    const out: string[] = [];
    for (let k = r[0]; k <= r[1]; k++) out.push(railDecode(display, k));
    return out;
  },
};

// --- Registry and policy ------------------------------------------------------------------

export const CIPHERS: Readonly<Record<CipherId, Cipher>> = {
  caesar,
  atbash,
  "reversed-words": reversedWords,
  a1z26,
  "keyboard-shift": keyboardShift,
  vigenere,
  morse,
  hex,
  base64,
  "rail-fence": railFence,
};

/** Which ciphers the scheduler may pick at each level. The level also tightens the key hint. */
export const LEVEL_CIPHERS: Readonly<Record<Level, readonly CipherId[]>> = {
  1: ["caesar", "atbash", "reversed-words"],
  2: ["caesar", "a1z26", "keyboard-shift"],
  3: ["vigenere", "morse", "hex"],
  4: ["vigenere", "rail-fence", "base64"],
  5: ["vigenere", "rail-fence", "morse"],
};

const LEVEL_CLAUSES: Readonly<Record<Level, number>> = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3 };

/** Memo length (see buildMemo) for a level, capped by what the cipher can keep inside the budget. */
export function memoClauses(level: Level, cipher: CipherId): number {
  return Math.min(LEVEL_CLAUSES[level], CIPHERS[cipher].maxClauses);
}

/** Heuristic seconds for a human (tools allowed) to solve `display`: 10 s to read + per-character cost. */
export function estimateSolveSeconds(cipher: CipherId, display: string): number {
  return 10 + display.length * CIPHERS[cipher].secondsPerChar;
}
