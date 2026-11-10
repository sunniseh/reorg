// Pixel maps: the legend that turns ASCII art into colored layers, and the small
// helpers every sprite and building tile is drawn with.
//
// A map is an array of equal-width strings. "." is transparent; every other
// character must be in LEGEND, which names its layer and color. Characters use
// three layers (base, shirt, hair; see sprites.mjs); building tiles use base only.

import { C, SPRITE, TINT_BASE, TINT_SHADE } from "./palette.mjs";

// Legend: character -> [layer, color]
export const LEGEND = {
  // Characters and props
  S: ["base", C.skin],
  s: ["base", SPRITE.skinShade],
  k: ["base", C.bg],
  c: ["base", C.ink],
  m: ["base", C.muted],
  l: ["base", C.line],
  D: ["base", C.deskEdge],
  n: ["base", C.panel],
  P: ["base", SPRITE.trousers],
  p: ["base", SPRITE.trousersShade],
  A: ["base", C.accent],
  a: ["base", SPRITE.accentShade],
  B: ["base", SPRITE.cardboard],
  b: ["base", SPRITE.cardboardShade],
  g: ["base", SPRITE.plant],
  G: ["base", SPRITE.plantDark],
  Y: ["base", C.coin],
  y: ["base", SPRITE.coinShade],
  N: ["base", C.good],
  E: ["base", C.bad],
  W: ["shirt", TINT_BASE],
  w: ["shirt", TINT_SHADE],
  H: ["hair", TINT_BASE],
  h: ["hair", TINT_SHADE],
  // Building
  "#": ["base", C.shell],
  "=": ["base", SPRITE.shellShade],
  "+": ["base", SPRITE.shellLight],
  q: ["base", C.glass],
  Q: ["base", SPRITE.glassLight],
  u: ["base", C.street],
  U: ["base", SPRITE.pavement],
  ";": ["base", SPRITE.pavementLine],
  o: ["base", C.ground],
  K: ["base", C.skyline],
  r: ["base", SPRITE.brick],
  R: ["base", SPRITE.brickLight],
  x: ["base", SPRITE.mortar],
  C: ["base", SPRITE.concrete],
  z: ["base", SPRITE.concreteShade],
  O: ["base", SPRITE.wood],
  d: ["base", SPRITE.woodShade],
  J: ["base", SPRITE.woodLight],
  t: ["base", SPRITE.steel],
  T: ["base", SPRITE.steelShade],
  Z: ["base", SPRITE.steelDark],
  "@": ["base", SPRITE.shaft],
  v: ["base", SPRITE.water],
  e: ["base", SPRITE.coffee],
  f: ["base", SPRITE.fabric],
  F: ["base", SPRITE.fabricShade],
  L: ["base", SPRITE.lamp],
  X: ["base", SPRITE.alarmOff],
  M: ["base", SPRITE.led],
  V: ["base", SPRITE.screen],
  // Translucent: glass panes seen face-on, their highlight streaks, soft shadows.
  "~": ["base", SPRITE.glassLight + "38"],
  "^": ["base", C.ink + "4d"],
  "%": ["base", C.bg + "66"],
};

export function check(name, rows) {
  if (!rows.length) throw new Error(`${name}: empty map`);
  const w = rows[0].length;
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`${name}: row ${i} is ${r.length} wide, expected ${w}: "${r}"`);
    for (const ch of r) if (ch !== "." && !LEGEND[ch]) throw new Error(`${name}: unknown pixel "${ch}" in row ${i}`);
  });
  return rows;
}

/** Stacks maps vertically. */
export const stack = (...parts) => parts.flat();

/** Paints `top` over `base` at row `at`, column `col`. "." keeps the base; "_" clears it. */
export function paint(base, top, at = 0, col = 0) {
  const out = [...base];
  top.forEach((row, i) => {
    const y = at + i;
    if (y < 0 || y >= out.length) return;
    const r = out[y].split("");
    [...row].forEach((ch, j) => {
      const x = col + j;
      if (x < 0 || x >= r.length) return;
      if (ch === "_") r[x] = ".";
      else if (ch !== ".") r[x] = ch;
    });
    out[y] = r.join("");
  });
  return out;
}

export const pad = (rows, left, right) => rows.map((r) => ".".repeat(left) + r + ".".repeat(right));
export const blank = (w, h) => Array.from({ length: h }, () => ".".repeat(w));
export const mirror = (rows) => rows.map((r) => [...r].reverse().join(""));
/** Replaces characters: recolor(rows, { W: "B" }). */
export const recolor = (rows, map) => rows.map((r) => [...r].map((ch) => map[ch] ?? ch).join(""));
/** Moves a map's content by (dx, dy) inside the same frame; what leaves the frame is cut. */
export function shift(rows, dx, dy) {
  const h = rows.length, w = rows[0].length;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const sx = x - dx, sy = y - dy;
      return sx >= 0 && sy >= 0 && sx < w && sy < h ? rows[sy][sx] : ".";
    }).join(""),
  );
}

/** Splits a map into layer grids (rows of hex or null). */
export function layers(name, rows) {
  check(name, rows);
  const h = rows.length, w = rows[0].length;
  const grids = {};
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const [layer, color] = LEGEND[ch];
      grids[layer] ??= Array.from({ length: h }, () => Array(w).fill(null));
      grids[layer][y][x] = color;
    });
  });
  return { w, h, layers: grids };
}

/** The inner outline of a map's silhouette, in one character. */
export function outline(rows, ch) {
  const h = rows.length, w = rows[0].length;
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== ".";
  return rows.map((row, y) =>
    [...row]
      .map((_, x) => (on(x, y) && (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)) ? ch : "."))
      .join(""),
  );
}

/**
 * A drawing surface for the larger tiles. Coordinates are sprite pixels from the
 * top-left; anything drawn outside the grid is clipped. Returns maps via rows().
 */
export class Grid {
  constructor(w, h, fill = ".") {
    this.w = w;
    this.h = h;
    this.px = Array.from({ length: h }, () => Array(w).fill(fill));
  }
  set(x, y, ch) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h && ch !== ".") this.px[y][x] = ch === "_" ? "." : ch;
    return this;
  }
  get(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y][x] : ".";
  }
  rect(x, y, w, h, ch) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, ch);
    return this;
  }
  box(x, y, w, h, ch) {
    this.hline(x, y, w, ch).hline(x, y + h - 1, w, ch);
    return this.vline(x, y, h, ch).vline(x + w - 1, y, h, ch);
  }
  hline(x, y, w, ch) {
    return this.rect(x, y, w, 1, ch);
  }
  vline(x, y, h, ch) {
    return this.rect(x, y, 1, h, ch);
  }
  /** Fills with fn(x, y) -> character for every pixel of the rectangle. */
  fill(x, y, w, h, fn) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, fn(i - x, j - y));
    return this;
  }
  /** Draws a map at (x, y): "." keeps what is there, "_" clears. */
  blit(rows, x = 0, y = 0) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => this.set(x + i, y + j, ch)));
    return this;
  }
  /** Draws text in a pixel font (FONT5, FONT3) at (x, y). */
  text(str, x, y, ch, font, { scale = 1, spacing = 1 } = {}) {
    let cx = x;
    for (const letter of str) {
      const g = font[letter];
      if (!g) throw new Error(`no glyph for "${letter}"`);
      g.forEach((row, j) =>
        [...row].forEach((on, i) => {
          if (on === "#") this.rect(cx + i * scale, y + j * scale, scale, scale, ch);
        }),
      );
      cx += (g[0].length + spacing) * scale;
    }
    return this;
  }
  rows() {
    return this.px.map((r) => r.join(""));
  }
}

/** Width of a string in a pixel font. */
export function textWidth(str, font, { scale = 1, spacing = 1 } = {}) {
  let w = 0;
  for (const letter of str) w += (font[letter][0].length + spacing) * scale;
  return w - spacing * scale;
}

// Pixel fonts for signage: only the letters the art needs. "#" is ink.
export const FONT5 = {
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  G: [".####", "#....", "#....", "#..##", "#...#", "#...#", ".###."],
  I: ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  " ": ["..", "..", "..", "..", "..", "..", ".."],
  // W-15: the ticker ($REORG), the CLOSED sign.
  $: [".###.", "#.#..", ".###.", "..#.#", "..#.#", "####.", "..#.."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
};

export const FONT3 = {
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  E: ["###", "#..", "##.", "#..", "###"],
  O: ["###", "#.#", "#.#", "#.#", "###"],
  G: ["###", "#..", "#.#", "#.#", "###"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  " ": [".", ".", ".", ".", "."],
  // W-15: FOR LEASE, the parking sign.
  F: ["###", "#..", "##.", "#..", "#.."],
  L: ["#..", "#..", "#..", "#..", "###"],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  S: ["###", "#..", "###", "..#", "###"],
  P: ["##.", "#.#", "##.", "#..", "#.."],
};
