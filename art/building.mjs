// REORG building tiles (roadmap A-01): the shell for the first three building
// states, the vertical core, per-tier rooms, the amenity bay, lobby, street,
// basement, penthouse and roof, plus the geometry the renderer lays them out with.
// See docs/design/REORG Design Spec.md §4 (the building) and §12 (states).
//
// TODO(art): placeholder art, drawn from code like the characters. Keep the tile
// names and the geometry in BUILDING.rig when replacing it.
//
// Every tile is a pixel map in the shared legend (pixmap.mjs). Big tiles are drawn
// on a Grid; small props are ASCII. Coordinates are sprite pixels, y down.
// scene.mjs composes a whole building from these tiles: it is the reference for
// how the renderer stacks them (apps/web, roadmap W-05).

import { Grid, FONT5, FONT3, textWidth, outline } from "./pixmap.mjs";

// ---------------------------------------------------------------------------
// Geometry (spec §4.2-§4.3). x is from the building's left edge.

const W = 380;
const FLOOR_H = 48; // interior, ceiling to floor
const SLAB = 4;
const DESK_TOP = 38; // first row of the desk top, from the ceiling
const DESK_H = FLOOR_H - DESK_TOP;
const STATES = ["garage", "office", "tower", "skyscraper", "megacorp"];

export const GEOM = {
  width: W,
  wall: 4,
  stairs: { x: 4, w: 20 },
  tube: { x: 24, w: 4 },
  shaft: { x: 28, w: 20 },
  core: { x: 4, w: 44 },
  rooms: { x: 48, w: 288 },
  bay: { x: 336, w: 40 },
  floor: { h: FLOOR_H, slab: SLAB, pitch: FLOOR_H + SLAB, deskTop: DESK_TOP },
  penthouse: { h: 64 },
  lobby: { h: FLOOR_H },
  street: { h: 32, standY: 24 },
  basement: { h: 56 },
  roof: { h: 44 },
};

// ---------------------------------------------------------------------------
// Small helpers

/** A straight 1 px line from (x0, y0) to (x1, y1). */
function line(g, x0, y0, x1, y1, ch) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    g.set(x0, y0, ch);
    if (x0 === x1 && y0 === y1) return g;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** A filled disc. */
function disc(g, cx, cy, r, ch) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) g.set(cx + x, cy + y, ch);
  return g;
}

/** Deterministic pseudo-random numbers for texture (never for layout or state). */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------------------
// Backdrop: flat skyline bands (spec §4.1 layer 0). Tiles horizontally.

function skyline(lit = false) {
  const w = 128, h = 48;
  const g = new Grid(w, h);
  const r = rng(11);
  let x = 0;
  while (x < w) {
    const bw = Math.min(8 + Math.floor(r() * 14), w - x);
    const bh = 12 + Math.floor(r() * 30);
    g.rect(x, h - bh, bw, bh, "K");
    if (bw > 9 && r() < 0.35) g.vline(x + (bw >> 1), h - bh - 6, 6, "K");
    // Night (W-15): the same windows, lit. The draw order is the same, so the tiles line up.
    for (let wy = h - bh + 3; wy < h - 2; wy += 4)
      for (let wx = x + 2; wx < x + bw - 2; wx += 3) if (r() < 0.14) g.set(wx, wy, lit ? "L" : "l");
    x += bw + (r() < 0.25 ? 3 : 0);
  }
  return g.rows();
}

// ---------------------------------------------------------------------------
// Shell, one set per building state (spec §12.2). Outer walls are seen edge-on,
// 4 px wide: `wall` tiles vertically (8 rows), `window` replaces 24 rows of it,
// `slab` is the floor line where it meets the wall, `parapet` tiles along the
// roof, `front` is the lobby's street front.

const SHELL = {
  garage: {
    wall: ["RxRR", "rxrr", "rxrr", "xxxx", "RRRx", "rrrx", "rrrx", "xxxx"],
    window: [
      "RxRR", "rxrr", "rxrr", "xxxx", "CCCC",
      ...Array(13).fill("rqQr"),
      "CCCC", "zzzz", "RRRx", "rrrx", "rrrx", "xxxx",
    ],
    slab: ["CCCC", "CCCC", "zzzz", "zzzz"],
    parapet: ["CCCC", "zzzz", "RxRR", "rxrr", "xxxx", "RRRx"],
  },
  office: {
    wall: ["CCCz", "CCCz", "CCCz", "CCCz", "CCCz", "CCCz", "CCCz", "zzzz"],
    window: [
      "CCCz", "CCCz", "cccc",
      ...Array(18).fill("cqQc"),
      "cccc", "CCCz", "zzzz",
    ],
    slab: ["zzzz", "CCCC", "CCCC", "zzzz"],
    parapet: ["DDDD", "CCCC", "CCCC", "CCCC", "CCCz", "zzzz"],
  },
  tower: {
    wall: ["TqQZ", "TqqZ", "TqqZ", "TqqZ", "TQqZ", "TqqZ", "TqqZ", "TqqZ"],
    window: Array.from({ length: 24 }, (_, i) => (i % 6 === 2 ? "TQQZ" : i % 6 === 3 ? "TqQZ" : "TqqZ")),
    slab: ["ZZZZ", "TTTT", "ZZZZ", "ZZZZ"],
    parapet: ["TTTT", "qQqq", "qqQq", "qqqQ", "qqqq", "ZZZZ"],
  },
  // W-15 (Later): a dark curtain wall with steel mullions.
  skyscraper: {
    wall: ["ZqQZ", "ZqqZ", "ZqqZ", "ZTTZ", "ZqqZ", "ZQqZ", "ZqqZ", "ZTTZ"],
    window: Array.from({ length: 24 }, (_, i) => (i % 8 === 3 ? "ZQQZ" : i % 8 === 7 ? "ZTTZ" : "ZqqZ")),
    slab: ["ZZZZ", "tttt", "ZZZZ", "ZZZZ"],
    parapet: ["tttt", "ZZZZ", "qQqq", "qqQq", "ZZZZ", "ZZZZ"],
  },
  // W-15 (Later): the flagship, light steel and blue glass.
  megacorp: {
    wall: ["tqQt", "tqqt", "tqqt", "tTTt", "tqqt", "tQqt", "tqqt", "tTTt"],
    window: Array.from({ length: 24 }, (_, i) => (i % 8 === 3 ? "tQQt" : i % 8 === 7 ? "tTTt" : "tqqt")),
    slab: ["tttt", "TTTT", "tttt", "TTTT"],
    parapet: ["tttt", "TTTT", "qQqq", "qqQq", "TTTT", "tttt"],
  },
};

/** Storefront frame and shade per state (the garage has none). */
const FRONT_FRAME = { office: ["C", "z"], tower: ["T", "Z"], skyscraper: ["Z", "T"], megacorp: ["t", "T"] };

/** The lobby's street front for one 72 px bay: a pier, a transom, glass. */
function storefront(state) {
  const g = new Grid(72, FLOOR_H);
  if (state === "garage") {
    // Brick pier and lintel; the garage front is open.
    g.fill(0, 0, 5, FLOOR_H, (x, y) => SHELL.garage.wall[y % 8][x % 4]);
    g.fill(0, 0, 72, 5, (x, y) => SHELL.garage.wall[y % 8][x % 4]);
    g.hline(0, 5, 72, "C");
    return g.rows();
  }
  const [frame, shade] = FRONT_FRAME[state];
  g.rect(3, 3, 69, FLOOR_H - 3, "~");
  // Two highlight streaks so the pane reads as glass.
  for (let i = 0; i < 9; i++) g.set(44 + i, 30 - i * 2, "^").set(45 + i, 30 - i * 2, "^");
  for (let i = 0; i < 5; i++) g.set(52 + i, 32 - i * 2, "^");
  g.rect(0, 0, 3, FLOOR_H, frame).vline(2, 0, FLOOR_H, shade);
  g.rect(0, 0, 72, 3, frame).hline(0, 2, 72, shade);
  g.hline(3, FLOOR_H - 1, 69, frame);
  return g.rows();
}

// ---------------------------------------------------------------------------
// Slab across the rooms (tiles horizontally): floor line, slab, ceiling shadow.

const SLAB_TILE = ["++++", "####", "####", "===="];

// ---------------------------------------------------------------------------
// Vertical core (spec §4.4): stairs, pneumatic tube, elevator.

/** One floor of stairs, 20 x 52: two flights with a landing, rising left to right, then right to left. */
function stairs() {
  const g = new Grid(20, FLOOR_H + SLAB);
  g.rect(0, 0, 20, FLOOR_H, "=");
  // Lower flight: a solid wedge of 6 steps (rise 4, run 2), then the landing.
  for (let i = 0; i < 6; i++) {
    const x = 1 + 2 * i, y = 44 - 4 * i;
    g.rect(x, y, 3, FLOOR_H - y, "#").hline(x, y, 3, "+");
  }
  g.rect(13, 20, 7, 4, "#").hline(13, 20, 7, "+").vline(18, 24, FLOOR_H - 24, "Z");
  // Upper flight: 5 steps rising to the left, a stringer below.
  for (let j = 0; j < 5; j++) {
    const x = 11 - 2 * j, y = 16 - 4 * j;
    g.rect(x, y, 3, 6, "#").hline(x, y, 3, "+");
  }
  // Handrails, 6 px above the step noses.
  line(g, 1, 38, 13, 14, "T");
  line(g, 13, 10, 3, -10, "T");
  g.vline(19, 13, 7, "T");
  // Slab: the flight from the floor below arrives on it at the left.
  g.hline(0, FLOOR_H, 20, "+").rect(0, FLOOR_H + 1, 20, 2, "#").hline(0, FLOOR_H + 3, 20, "=");
  return g.rows();
}

/** The penthouse stairwell (20 x 68): the last flight arrives; a roof door. */
function stairsTop() {
  const h = 64;
  const g = new Grid(20, h + SLAB);
  g.rect(0, 0, 20, h, "=");
  g.rect(3, h - 28, 13, 28, "Z").rect(4, h - 27, 11, 27, "T").vline(13, h - 15, 2, "Z");
  g.rect(2, h - 36, 16, 7, "Z").text("EXIT", 3, h - 35, "L", FONT3);
  g.hline(0, h, 20, "+").rect(0, h + 1, 20, 2, "#").hline(0, h + 3, 20, "=");
  return g.rows();
}

/** The elevator shaft, one floor (20 x pitch). The cab runs over it. */
function shaft(h = FLOOR_H) {
  const g = new Grid(20, h + SLAB);
  g.rect(0, 0, 20, h + SLAB, "@");
  g.vline(1, 0, h + SLAB, "Z").vline(18, 0, h + SLAB, "Z");
  for (const y of [6, h - 16]) g.hline(0, y, 2, "T").hline(18, y, 2, "T");
  // The landing door frame on the shaft's far wall.
  g.hline(3, h - 30, 14, "Z").vline(3, h - 30, 30, "Z").vline(16, h - 30, 30, "Z");
  // Slab stubs either side of the cab.
  for (const x of [0, 17]) g.rect(x, h, 3, SLAB, "#").hline(x, h, 3, "+");
  return g.rows();
}

/** The penthouse shaft with the hoist sheave at the top. */
function shaftTop() {
  const rows = shaft(64);
  const g = new Grid(20, rows.length);
  g.blit(rows);
  disc(g, 10, 6, 4, "T");
  disc(g, 10, 6, 1, "Z");
  g.vline(6, 7, 14, "Z").vline(14, 7, 6, "Z");
  return g.rows();
}

// Tube: glass between steel rails; one bracket per floor. Tiles vertically.
const TUBE = Array.from({ length: FLOOR_H + SLAB }, (_, y) => (y === 22 || y === 23 ? "ZZZZ" : y % 9 === 4 ? "TQqT" : "TqqT"));
const TUBE_OUTLET = ["TTTTT.", "TZZZZT", "TZ@@@@", "TZ@@@@", "TZZZZT", "TTTTT."];
const TUBE_CAP = ["ZZZZZZ", ".TTTT.", ".TqqT."];
// The pump at the foot of the tube in the basement: coins leave the vault here.
function tubeFoot() {
  const g = new Grid(14, 18);
  g.rect(5, 0, 4, 6, "T").rect(6, 0, 2, 6, "q");
  g.rect(0, 6, 14, 12, "Z").box(0, 6, 14, 12, "T");
  disc(g, 7, 11, 2, "t");
  g.set(7, 11, "Z").set(8, 10, "Y");
  g.hline(2, 15, 10, "T");
  return g.rows();
}

/** The elevator cab (18 x 32), interior. Riders stand on row 30; the doors go on top. */
function cab() {
  const g = new Grid(18, 32);
  g.rect(0, 0, 18, 32, "Z");
  g.hline(0, 0, 18, "T").hline(0, 1, 18, "t");
  g.vline(0, 0, 32, "T").vline(17, 0, 32, "T");
  g.hline(6, 2, 6, "L");
  g.hline(1, 18, 16, "T");
  g.hline(0, 30, 18, "t").hline(0, 31, 18, "T");
  return g.rows();
}

/** Cab doors, open = 0 (closed) .. 1 (open). Same size as the cab. */
function cabDoors(open) {
  const g = new Grid(18, 32);
  const pw = Math.max(1, Math.round(8 * (1 - open)));
  for (const [x0, dir] of [[1, 1], [16, -1]]) {
    const xa = dir > 0 ? x0 : x0 - pw + 1;
    g.rect(xa, 2, pw, 28, "t");
    g.vline(dir > 0 ? xa + pw - 1 : xa, 2, 28, "T");
  }
  return g.rows();
}

/** Floor indicator above the shaft: up and down arrows; lit = "up" | "down" | null. */
function indicator(lit) {
  const u = lit === "up" ? "L" : "T", d = lit === "down" ? "L" : "T";
  const g = new Grid(9, 5);
  g.rect(0, 0, 9, 5, "Z");
  g.set(2, 1, u).hline(1, 2, 3, u);
  g.hline(5, 2, 3, d).set(6, 3, d);
  return g.rows();
}

// ---------------------------------------------------------------------------
// Back-wall details (spec §4.1 layer 2)

function backWindow(w, h, seed) {
  const g = new Grid(w, h);
  g.rect(0, 0, w, h, "q");
  // Skyline seen through the window.
  const r = rng(seed);
  for (let x = 1; x < w - 1; ) {
    const bw = 3 + Math.floor(r() * 6), bh = 3 + Math.floor(r() * (h * 0.55));
    g.rect(x, h - 1 - bh, Math.min(bw, w - 1 - x), bh, "K");
    x += bw + (r() < 0.4 ? 1 : 0);
  }
  for (let i = 0; i < h; i++) g.set(w - 8 - i, i, "Q").set(w - 7 - i, i, "Q");
  const panes = Math.max(1, Math.round(w / 24));
  for (let p = 1; p < panes; p++) g.vline(Math.round((p * w) / panes), 0, h, "D");
  g.box(0, 0, w, h, "D");
  return g.rows();
}

const POSTERS = [
  // "Achieve": a summit and a flag.
  (() => {
    const g = new Grid(14, 18);
    g.rect(0, 0, 14, 18, "n").box(0, 0, 14, 18, "D");
    for (let i = 0; i < 6; i++) g.hline(7 - i, 7 + i, 1 + 2 * i, i < 2 ? "c" : "m");
    g.vline(7, 3, 4, "c").hline(8, 3, 3, "c").hline(8, 4, 2, "c");
    g.hline(3, 15, 8, "m");
    return g.rows();
  })(),
  // "Growth": a chart that goes up, then very much down.
  (() => {
    const g = new Grid(14, 18);
    g.rect(0, 0, 14, 18, "n").box(0, 0, 14, 18, "D");
    g.vline(2, 3, 11, "m").hline(2, 13, 10, "m");
    line(g, 3, 12, 6, 8, "c");
    line(g, 6, 8, 8, 9, "c");
    line(g, 8, 9, 10, 4, "c");
    line(g, 10, 4, 11, 12, "c");
    g.hline(3, 15, 8, "m");
    return g.rows();
  })(),
  // Employee of the month: the frame is empty.
  (() => {
    const g = new Grid(14, 18);
    g.rect(0, 0, 14, 18, "J").rect(1, 1, 12, 16, "n");
    g.rect(3, 3, 8, 9, "l");
    g.rect(5, 4, 4, 4, "n").rect(4, 8, 6, 4, "n");
    g.set(7, 14, "L").hline(6, 15, 3, "L");
    return g.rows();
  })(),
];

function clockFace() {
  const g = new Grid(9, 9);
  disc(g, 4, 4, 4, "D");
  disc(g, 4, 4, 3, "c");
  for (const [x, y] of [[4, 1], [7, 4], [4, 7], [1, 4]]) g.set(x, y, "m");
  g.set(4, 4, "k");
  return g.rows();
}
/** Clock hand overlays: 8 directions, 0 = 12 o'clock, clockwise. */
const CLOCK_HANDS = [[0, -3], [2, -2], [3, 0], [2, 2], [0, 3], [-2, 2], [-3, 0], [-2, -2]].map(([dx, dy]) => {
  const g = new Grid(9, 9);
  return line(g, 4, 4, 4 + dx, 4 + dy, "k").rows();
});

function whiteboard() {
  const g = new Grid(22, 14);
  g.rect(0, 0, 22, 12, "c").box(0, 0, 22, 12, "D");
  g.hline(2, 12, 18, "T").hline(14, 11, 4, "m");
  g.set(4, 13, "Z").set(17, 13, "Z");
  return g.rows();
}

/** A manager's whiteboard: a meeting's worth of arrows. */
function boardSmall() {
  const g = new Grid(16, 12);
  g.rect(0, 0, 16, 11, "c").box(0, 0, 16, 11, "D").hline(1, 11, 14, "T");
  g.box(2, 2, 4, 3, "m").box(10, 2, 4, 3, "m").box(6, 6, 4, 3, "m");
  line(g, 6, 3, 9, 3, "m");
  line(g, 4, 5, 6, 7, "m");
  line(g, 12, 5, 10, 7, "m");
  return g.rows();
}

const ALARM_OFF = ["..TTT..", ".XXXXX.", ".XXXXX.", "..XXX..", "......."];
const ALARM_ON = ["..TTT..", "^EEEEE^", "^EEEEE^", ".^EEE^.", "..^.^.."];
const LAMP = ["TTTTTTTTTT", ".LLLLLLLL."];

// ---------------------------------------------------------------------------
// Rooms (spec §4.3). Each tier has a back tile (behind the seated character),
// a front tile (in front: desk front, partition or glass), and an empty front
// (furniture outlines in Desk edge, spec §4.3 "Empty rooms"). The anchors in
// ROOM_ANCHORS tell the renderer where the seated character and the overlays go.

/** A desk front, w x DESK_H, its top on DESK_TOP. */
function deskFront(w, style) {
  const h = DESK_H;
  const g = new Grid(w, h);
  if (style === "exec") {
    g.rect(0, 0, w, h, "O").hline(0, 0, w, "J").hline(0, 1, w, "O");
    g.vline(0, 1, h - 1, "d").vline(w - 1, 1, h - 1, "d").hline(0, h - 1, w, "d");
    const dx = w - 11;
    g.box(dx, 2, 9, 4, "d").box(dx, 5, 9, 4, "d").hline(dx + 3, 3, 3, "J").hline(dx + 3, 6, 3, "J");
    g.box(2, 2, dx - 4, 6, "d");
  } else if (style === "panel") {
    g.rect(0, 0, w, h, "n").hline(0, 0, w, "D").hline(0, 1, w, "D");
    g.vline(0, 0, h, "D").vline(w - 1, 0, h, "D").hline(0, h - 1, w, "D");
    const dx = w - 8;
    g.vline(dx, 2, h - 3, "D").hline(dx + 2, 4, 3, "m");
  } else if (style === "cubicle") {
    g.rect(0, 0, w, h, "n").hline(0, 0, w, "D").hline(0, 1, w, "D");
    g.vline(0, 0, h, "D").vline(w - 1, 0, h, "D").hline(0, h - 1, w, "D");
  } else if (style === "table") {
    // One seat of the interns' long shared table: tiles edge to edge.
    g.rect(0, 0, w, h, "C").hline(0, 0, w, "t").hline(0, 1, w, "T").hline(0, h - 1, w, "z");
    g.vline(0, 2, h - 3, "z");
  }
  return g.rows();
}

const keyboard = (g, x) => g.hline(x, DESK_TOP - 1, 5, "Z").hline(x + 1, DESK_TOP - 1, 3, "T");

function floorPlant() {
  return ["..gG..", ".gGgG.", "gGgGgG", ".GgGg.", "gGgGgG", ".gGgG.", "..Gg..", "..G...", ".BBBB.", "BBBBBB", ".bBBb.", ".bbbb."];
}

/** Builds one tier's tiles; `frontFn(g, empty)` draws the front or its empty outline. */
function room(w, backFn, frontFn) {
  const back = new Grid(w, FLOOR_H);
  backFn(back);
  const front = new Grid(w, FLOOR_H);
  frontFn(front, false);
  const empty = new Grid(w, FLOOR_H);
  frontFn(empty, true);
  return { back: back.rows(), front: front.rows(), empty: empty.rows() };
}

/** Draws a desk, or its outline in Desk edge for an empty room. */
function placeDesk(g, x, w, style, empty) {
  const d = deskFront(w, style);
  g.blit(empty ? outline(d, "D") : d, x, DESK_TOP);
}

// The door height in the rooms: a standing employee (20 px) plus headroom.
const DOOR_TOP = 22;

// Directors: private offices, 48 wide. Paneled wall with a doorway on the left,
// the door swung open against the back wall, a window, an executive desk, a plant.
const DIRECTOR = room(
  48,
  (g) => {
    g.blit(LAMP, 21, 0);
    g.blit(backWindow(14, 13, 3), 28, 6);
    // Open door leaf against the back wall.
    g.rect(5, DOOR_TOP, 10, FLOOR_H - DOOR_TOP, "O").box(5, DOOR_TOP, 10, FLOOR_H - DOOR_TOP, "d");
    g.box(7, DOOR_TOP + 2, 6, 9, "J").box(7, DOOR_TOP + 13, 6, 10, "J").set(13, DOOR_TOP + 13, "Y");
  },
  (g, empty) => {
    // Wall header above the doorway, and the door frame.
    g.rect(0, 0, 4, DOOR_TOP, "O").vline(0, 0, DOOR_TOP, "d").vline(3, 0, DOOR_TOP, "d").hline(0, DOOR_TOP - 1, 4, "d");
    g.vline(0, DOOR_TOP, FLOOR_H - DOOR_TOP, "d").vline(3, DOOR_TOP, FLOOR_H - DOOR_TOP, "d");
    placeDesk(g, 16, 26, "exec", empty);
    const plant = floorPlant();
    g.blit(empty ? outline(plant, "D") : plant, 42, FLOOR_H - plant.length);
    if (!empty) keyboard(g, 28);
  },
);

// The partition alone, to close the last Directors' office against the bay.
const DIRECTOR_WALL = (() => {
  const g = new Grid(4, FLOOR_H);
  g.rect(0, 0, 4, DOOR_TOP, "O").vline(0, 0, DOOR_TOP, "d").vline(3, 0, DOOR_TOP, "d").hline(0, DOOR_TOP - 1, 4, "d");
  g.rect(0, DOOR_TOP, 4, FLOOR_H - DOOR_TOP, "O").vline(0, DOOR_TOP, FLOOR_H - DOOR_TOP, "d").vline(3, DOOR_TOP, FLOOR_H - DOOR_TOP, "d");
  return g.rows();
})();

// Managers: glass offices, 32 wide. Glass front with a door, a whiteboard.
const MANAGER = room(
  32,
  (g) => {
    g.blit(LAMP, 5, 0);
    g.blit(boardSmall(), 15, 5);
  },
  (g, empty) => {
    placeDesk(g, 3, 22, "panel", empty);
    if (!empty) keyboard(g, 13);
    // Glass front: frame on the left and top, a pane, and the door opening.
    g.rect(2, 2, 30, FLOOR_H - 2, "~");
    g.rect(26, DOOR_TOP, 5, FLOOR_H - DOOR_TOP, "_");
    g.rect(0, 0, 2, FLOOR_H, "T").vline(1, 0, FLOOR_H, "Z");
    g.rect(0, 0, 32, 2, "T").hline(0, 1, 32, "Z");
    g.vline(25, DOOR_TOP - 1, FLOOR_H - DOOR_TOP + 1, "T").vline(31, DOOR_TOP - 1, FLOOR_H - DOOR_TOP + 1, "T").hline(25, DOOR_TOP - 1, 7, "T");
    for (let i = 0; i < 5; i++) g.set(9 + i, 32 - i * 2, "^").set(10 + i, 32 - i * 2, "^");
  },
);

// Associates: cubicles, 24 wide. A fabric back panel and a low side post.
const ASSOCIATE = room(
  24,
  (g) => {
    g.blit(LAMP.map((r) => r.slice(1, 9)), 4, 0);
    g.rect(1, 27, 23, FLOOR_H - 27, "f").hline(1, 27, 23, "F").hline(1, 28, 23, "F");
    g.vline(1, 27, FLOOR_H - 27, "F");
  },
  (g, empty) => {
    placeDesk(g, 3, 21, "cubicle", empty);
    if (!empty) keyboard(g, 10);
    const post = ["FF", "ff", ...Array(FLOOR_H - 27).fill("Ff")];
    g.blit(empty ? outline(post, "D") : post, 0, 25);
  },
);

// Interns: one seat of the long shared table, 16 wide. Laptops, not monitors.
const INTERN = room(
  16,
  (g) => {
    g.blit(LAMP.map((r) => r.slice(2, 8)), 4, 0);
  },
  (g, empty) => {
    placeDesk(g, 0, 16, "table", empty);
  },
);

// Anchors per tier, from the room's top-left (the ceiling). `seat` is the seated
// character's frame left edge; the frame's bottom sits on deskTop. Overlays:
// monitor (or laptop) top-left, paper top-left, result dot top-left (floats above
// the desk's top-right), streak number and NEW chip on the desk front's top-left,
// nameplate centered on the desk front, laid-off box on the desk top.
// Rooms per floor (perFloor) must match ROOMS_PER_FLOOR in packages/core/src/tower.ts.
const ROOM_ANCHORS = {
  directors: { w: 48, perFloor: 6, desk: { x: 16, w: 26 }, seat: 20, chair: "exec", screen: "monitor", monitor: [32, 31], paper: [37, 32], dot: [36, 22], streak: [18, 41], chip: [18, 41], plate: [29, 44], box: [22, 32] },
  managers: { w: 32, perFloor: 9, desk: { x: 3, w: 22 }, seat: 4, chair: "standard", screen: "monitor", monitor: [16, 31], paper: [19, 32], dot: [18, 22], streak: [5, 41], chip: [5, 41], plate: [14, 44], box: [7, 32] },
  associates: { w: 24, perFloor: 12, desk: { x: 3, w: 21 }, seat: 3, chair: "standard", screen: "monitor", monitor: [15, 31], paper: [18, 32], dot: [17, 22], streak: [4, 41], chip: [4, 41], plate: [13, 44], box: [5, 32] },
  interns: { w: 16, perFloor: 18, desk: { x: 0, w: 16 }, seat: 1, chair: "standard", screen: "laptop", monitor: [9, 33], paper: [11, 32], dot: [9, 22], streak: [1, 41], chip: [1, 41], plate: [8, 44], box: [3, 32] },
};

// ---------------------------------------------------------------------------
// The amenity bay (spec §4.2, right of the rooms, 40 wide): water cooler,
// printer with the outbox, coffee machine. The clock and the floor whiteboard
// hang above it (separate sprites so the clock hand can move).

function bay() {
  const g = new Grid(40, FLOOR_H);
  // Water cooler.
  g.rect(3, 13, 6, 10, "v").vline(4, 14, 7, "c").hline(3, 13, 6, "T").rect(5, 11, 2, 2, "T");
  g.rect(1, 23, 10, 25, "t").vline(10, 23, 25, "T").hline(1, 23, 10, "T");
  g.rect(4, 27, 4, 2, "Z").set(5, 29, "T").rect(3, 31, 6, 1, "T");
  g.hline(1, 47, 10, "T");
  // Counter.
  g.rect(12, 36, 28, 12, "n").box(12, 36, 28, 12, "D").hline(12, 37, 28, "D");
  g.vline(26, 38, 9, "D").set(24, 42, "m").set(28, 42, "m");
  // Printer.
  g.rect(13, 27, 11, 9, "t").hline(13, 27, 11, "T").rect(14, 25, 9, 2, "c").hline(15, 31, 7, "Z");
  g.vline(23, 27, 9, "T").set(21, 29, "M");
  // Outbox tray (the stack of sheets is prop.sheets.<n>, drawn above it).
  g.hline(24, 35, 7, "T").set(24, 34, "T").set(30, 34, "T");
  // Coffee machine.
  g.rect(32, 22, 8, 14, "Z").box(32, 22, 8, 14, "T").rect(33, 23, 6, 3, "T");
  g.set(37, 24, "M").rect(34, 28, 4, 1, "T").rect(34, 32, 3, 3, "c").hline(33, 35, 6, "T");
  return g.rows();
}

/** The outbox stack: one sheet per submission from the floor, capped at 6. */
const SHEETS = [1, 2, 3, 4, 5, 6].map((n) => {
  const g = new Grid(7, 6);
  for (let i = 0; i < n; i++) g.hline(i % 2, 5 - i, 6, i === n - 1 ? "c" : "m");
  return g.rows();
});

// ---------------------------------------------------------------------------
// Lobby (spec §4.5)

function cafe() {
  const g = new Grid(36, 30);
  // Espresso machine on the counter, two cups.
  g.rect(4, 4, 14, 10, "Z").box(4, 4, 14, 10, "T").rect(6, 6, 10, 3, "T").set(14, 7, "M");
  g.hline(7, 11, 2, "T").hline(12, 11, 2, "T").rect(20, 11, 3, 3, "c").rect(25, 11, 3, 3, "c");
  // Menu board above.
  g.rect(22, 0, 12, 8, "k").box(22, 0, 12, 8, "D").hline(24, 2, 6, "m").hline(24, 4, 8, "m");
  // Counter.
  g.rect(0, 14, 36, 16, "O").hline(0, 14, 36, "J").hline(0, 15, 36, "d");
  g.vline(0, 14, 16, "d").vline(35, 14, 16, "d").hline(0, 29, 36, "d");
  for (let x = 4; x < 34; x += 6) g.vline(x, 18, 9, "d");
  return g.rows();
}

const STOOL = ["eeeeee", ".ZZZZ.", "..ZZ..", "..ZZ..", "..ZZ..", "..ZZ..", "..ZZ..", ".ZZZZ."];
function table() {
  const g = new Grid(14, 14);
  g.hline(0, 0, 14, "J").hline(1, 1, 12, "d");
  g.rect(6, 2, 2, 11, "Z").hline(3, 13, 8, "Z");
  return g.rows();
}

function hrDoor() {
  const g = new Grid(20, 36);
  g.rect(4, 0, 12, 7, "n").box(4, 0, 12, 7, "D").text("HR", 7, 1, "c", FONT3);
  g.rect(1, 9, 18, 27, "D").rect(2, 10, 16, 26, "O");
  g.box(4, 12, 12, 9, "d").box(4, 23, 12, 10, "d").rect(15, 22, 2, 2, "Y");
  return g.rows();
}

function reception() {
  const g = new Grid(60, 20);
  g.rect(0, 2, 60, 18, "O").hline(0, 2, 60, "J").hline(0, 3, 60, "J").hline(0, 4, 60, "d");
  g.vline(0, 2, 18, "d").vline(59, 2, 18, "d").hline(0, 19, 60, "d");
  g.box(6, 8, 48, 9, "d").box(8, 10, 44, 5, "J");
  // The bell. Nobody answers it.
  g.hline(47, 1, 4, "Y").set(48, 0, "Y").set(49, 0, "Y");
  return g.rows();
}

/** The company name on the lobby wall, in the accent (signage, spec §12). */
function lobbyLogo() {
  const opts = { scale: 2, spacing: 1 };
  const w = textWidth("REORG", FONT5, opts);
  const g = new Grid(w + 1, 15);
  g.text("REORG", 1, 1, "a", FONT5, opts);
  g.text("REORG", 0, 0, "A", FONT5, opts);
  return g.rows();
}

function lobbyPlant() {
  const g = new Grid(14, 28);
  g.blit(floorPlant().slice(0, 12), 3, 0);
  g.blit(["..g.....", ".gG.gG..", "gGgGgGg."], 0, 6);
  g.rect(2, 16, 10, 12, "C").hline(2, 16, 10, "t").vline(11, 17, 11, "z").hline(2, 27, 10, "z");
  return g.rows();
}

/** The front doors in the street front, under the bay: sliding glass, open = 0..1. */
function glassDoors(open) {
  const g = new Grid(40, FLOOR_H);
  // Transom with the name.
  g.rect(3, 3, 34, 9, "~").hline(3, 11, 34, "T");
  g.text("REORG", 11, 5, "A", FONT3);
  const leaf = Math.max(2, Math.round(17 * (1 - open)));
  for (const left of [true, false]) {
    const x = left ? 3 : 37 - leaf;
    g.rect(x, 12, leaf, FLOOR_H - 12, "~");
    g.vline(left ? x + leaf - 1 : x, 12, FLOOR_H - 12, "T");
    g.hline(x, FLOOR_H - 1, leaf, "T");
    if (leaf > 6) g.rect(left ? x + leaf - 4 : x + 2, 27, 2, 6, "t");
  }
  g.rect(0, 0, 40, 3, "T").hline(0, 2, 40, "Z");
  g.rect(0, 0, 3, FLOOR_H, "T").rect(37, 0, 3, FLOOR_H, "T");
  return g.rows();
}

/** The garage's roll-up door (Garage startup state): open = 0..1. */
function rollup(open) {
  const g = new Grid(40, FLOOR_H);
  g.fill(0, 0, 40, 6, (x, y) => SHELL.garage.wall[y % 8][x % 4]);
  g.rect(0, 6, 4, FLOOR_H - 6, "Z").rect(36, 6, 4, FLOOR_H - 6, "Z");
  g.rect(3, 4, 34, 4, "z").hline(3, 4, 34, "C");
  const down = Math.round((FLOOR_H - 8) * (1 - open));
  for (let y = 0; y < down; y++) g.hline(4, 8 + y, 32, y % 3 === 2 ? "z" : "C");
  if (down > 2) g.hline(4, 8 + down - 1, 32, "Z").rect(18, 8 + down - 3, 4, 1, "T");
  return g.rows();
}

// ---------------------------------------------------------------------------
// Street (spec §4.5): the sidewalk in front of the lobby. Characters on it stand
// on row standY and overlap the lobby's street front, which is behind them.

function pavement() {
  // Building line, the sidewalk seen from a little above (two rows of slabs),
  // the curb, the road edge. Feet stand on row standY.
  const g = new Grid(16, GEOM.street.h);
  g.hline(0, 0, 16, "+").hline(0, 1, 16, "#").hline(0, 2, 16, "=");
  g.rect(0, 3, 16, 23, "U").vline(15, 3, 11, ";").vline(7, 14, 12, ";").hline(0, 13, 16, ";");
  g.hline(0, 26, 16, "D").hline(0, 27, 16, "T");
  g.rect(0, 28, 16, 4, "u");
  return g.rows();
}

function bench() {
  const g = new Grid(52, 10);
  g.hline(1, 0, 50, "O").hline(1, 1, 50, "d").hline(1, 2, 50, "O");
  for (const x of [2, 49]) g.vline(x, 0, 10, "Z");
  g.hline(0, 4, 52, "J").hline(0, 5, 52, "O").hline(0, 6, 52, "d");
  for (const x of [4, 26, 46]) g.rect(x, 6, 2, 4, "Z");
  return g.rows();
}

function streetLamp() {
  const g = new Grid(14, 64);
  g.rect(1, 0, 12, 3, "T").hline(0, 3, 14, "Z").rect(2, 4, 10, 2, "L");
  g.rect(6, 6, 2, 54, "Z").rect(4, 58, 6, 6, "Z").hline(3, 63, 8, "Z");
  return g.rows();
}

// A strip of tape for the crowd sign's corners; the sign itself is drawn with text.
const TAPE = ["^^^^^", "^mmm^", "^^^^^"];

// ---------------------------------------------------------------------------
// Basement (spec §4.6): the vault, the coin pile, the reserve bar, the server room.

function vaultDoor() {
  const g = new Grid(36, 36);
  g.rect(0, 0, 36, 36, "Z").box(0, 0, 36, 36, "T");
  disc(g, 18, 18, 15, "T");
  disc(g, 18, 18, 13, "t");
  disc(g, 18, 18, 11, "T");
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    g.set(18 + Math.round(Math.cos(t) * 12), 18 + Math.round(Math.sin(t) * 12), "Z");
  }
  // The wheel.
  disc(g, 18, 18, 3, "Z");
  line(g, 11, 18, 25, 18, "Z");
  line(g, 18, 11, 18, 25, "Z");
  line(g, 13, 13, 23, 23, "Z");
  line(g, 13, 23, 23, 13, "Z");
  disc(g, 18, 18, 1, "t");
  // Hinges.
  g.rect(0, 7, 3, 4, "T").rect(0, 25, 3, 4, "T");
  return g.rows();
}

/** Coin pile for a fill level 0..5 (the renderer picks it from the bar's fill). */
function coinPile(level) {
  const w = 48;
  const h = [2, 5, 8, 11, 14, 18][level];
  const g = new Grid(w, h);
  const r = rng(40 + level);
  for (let x = 0; x < w; x++) {
    const t = Math.abs(x - w / 2) / (w / 2);
    const colH = Math.max(1, Math.round(h * (1 - t * t) - r() * 1.5));
    for (let y = h - colH; y < h; y++) g.set(x, y, (x + y) % 5 === 0 ? "y" : "Y");
    g.set(x, h - colH, r() < 0.3 ? "L" : "Y");
  }
  return g.rows();
}

function vaultBar() {
  const g = new Grid(44, 14);
  g.rect(0, 0, 44, 14, "Z").box(0, 0, 44, 14, "T");
  g.rect(2, 2, 40, 10, "@");
  return g.rows();
}

/** Safe-deposit boxes on the vault wall. */
function depositBoxes() {
  const g = new Grid(31, 21);
  g.rect(0, 0, 31, 21, "Z");
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 5; x++) {
      g.box(1 + x * 6, 1 + y * 5, 5, 4, "T");
      g.set(3 + x * 6, 2 + y * 5 + 1, "t");
    }
  return g.rows();
}

function rack(stalled) {
  const g = new Grid(14, 40);
  g.rect(0, 0, 14, 40, "Z").box(0, 0, 14, 40, "T");
  for (let u = 0; u < 8; u++) {
    const y = 2 + u * 4;
    g.rect(2, y, 10, 3, "@").hline(2, y, 10, "T");
    g.set(3, y + 1, "M");
    if (u % 2 === 0) g.set(5, y + 1, "M");
  }
  if (stalled) g.set(3, 3, "E").set(5, 3, "E").set(3, 11, "E").set(3, 19, "E");
  g.rect(1, 38, 3, 2, "T").rect(10, 38, 3, 2, "T");
  return g.rows();
}

// ---------------------------------------------------------------------------
// Penthouse (spec §4.3): the boss's office.

function bossDesk() {
  const g = new Grid(56, 17);
  // Monitor (back to us), mug and nameplate on the desk top.
  g.rect(40, 0, 10, 4, "Z").rect(44, 4, 2, 1, "Z");
  g.rect(8, 1, 3, 4, "c").set(11, 2, "c").set(11, 3, "c").hline(8, 1, 3, "e");
  g.rect(22, 2, 12, 3, "J").hline(23, 3, 10, "d");
  // The desk.
  g.rect(0, 5, 56, 12, "O").hline(0, 5, 56, "J").hline(0, 6, 56, "J");
  g.vline(0, 5, 12, "d").vline(55, 5, 12, "d").hline(0, 16, 56, "d");
  g.box(4, 8, 14, 7, "d").box(38, 8, 14, 7, "d").box(21, 8, 14, 7, "d");
  g.hline(9, 11, 4, "J").hline(43, 11, 4, "J");
  return g.rows();
}

function bookshelf() {
  const g = new Grid(24, 42);
  g.rect(0, 0, 24, 42, "d").rect(2, 2, 20, 38, "e");
  const colors = ["n", "D", "B", "m", "f", "l", "J"];
  for (let s = 0; s < 4; s++) {
    const y = 2 + s * 10;
    g.hline(1, y + 9, 22, "O");
    let x = 3;
    let k = s * 3;
    while (x < 21) {
      const bw = 2 + ((k * 7) % 3);
      const bh = 6 + ((k * 5) % 3);
      g.rect(x, y + 9 - bh, Math.min(bw, 21 - x), bh, colors[k % colors.length]);
      x += bw;
      k++;
    }
  }
  return g.rows();
}

/** The org chart: the boss at the top, in the accent. */
function orgChart() {
  const g = new Grid(32, 22);
  g.rect(0, 0, 32, 22, "n").box(0, 0, 32, 22, "D");
  g.rect(12, 2, 8, 4, "A");
  g.vline(15, 6, 3, "m").hline(5, 8, 22, "m");
  for (const x of [3, 13, 23]) {
    g.vline(x + 2, 8, 2, "m").rect(x, 10, 6, 3, "c");
    g.vline(x + 2, 13, 2, "m").rect(x + 1, 15, 4, 2, "l").rect(x + 1, 18, 4, 2, "l");
  }
  return g.rows();
}

// ---------------------------------------------------------------------------
// Roof (spec §12.2): the sign per state, the water tank, the elevator machine room.

function signGarage() {
  // A cardboard sign propped on the roof, the name in accent marker.
  const tw = textWidth("REORG", FONT5);
  const g = new Grid(tw + 10, 16);
  g.rect(1, 0, tw + 8, 12, "B").hline(1, 11, tw + 8, "b").vline(tw + 8, 0, 12, "b");
  g.set(1, 0, "_").set(tw + 8, 11, "_");
  g.text("REORG", 5, 2, "A", FONT5);
  g.rect(3, 12, 2, 4, "d").rect(tw + 5, 12, 2, 4, "d");
  g.hline(0, 1, 3, "^").hline(tw + 7, 1, 3, "^");
  return g.rows();
}

function signOffice() {
  const tw = textWidth("REORG INC.", FONT5);
  const g = new Grid(tw + 12, 20);
  g.rect(0, 0, tw + 12, 13, "n").box(0, 0, tw + 12, 13, "D").box(1, 1, tw + 10, 11, "l");
  g.text("REORG INC.", 6, 3, "A", FONT5);
  g.rect(6, 13, 2, 7, "Z").rect(tw + 4, 13, 2, 7, "Z");
  return g.rows();
}

function signTower() {
  const opts = { scale: 2, spacing: 1 };
  const tw = textWidth("REORG", FONT5, opts);
  const g = new Grid(tw + 12, 30);
  // Lit letters on a steel truss.
  g.text("REORG", 6, 1, "a", FONT5, opts);
  g.text("REORG", 5, 0, "A", FONT5, opts);
  g.hline(0, 16, tw + 12, "T").hline(0, 22, tw + 12, "T");
  for (let x = 0; x < tw + 12; x += 6) {
    line(g, x, 16, Math.min(x + 6, tw + 11), 22, "Z");
    g.vline(x, 16, 7, "T");
  }
  g.vline(tw + 11, 16, 7, "T");
  g.rect(4, 23, 2, 7, "T").rect(tw + 6, 23, 2, 7, "T").rect((tw + 12) >> 1, 23, 2, 7, "T");
  // Floodlights aimed up at the letters.
  for (const x of [8, tw + 2]) g.rect(x, 15, 3, 1, "L");
  return g.rows();
}

function waterTank() {
  const g = new Grid(22, 32);
  for (let y = 0; y < 6; y++) g.hline(11 - y * 2, y, 1 + y * 4, "z");
  g.rect(1, 6, 20, 16, "O");
  for (let x = 1; x < 21; x += 3) g.vline(x, 6, 16, "d");
  for (const y of [8, 14, 20]) g.hline(0, y, 22, "Z");
  for (const x of [3, 17]) g.rect(x, 22, 2, 10, "Z");
  line(g, 4, 23, 17, 31, "Z");
  line(g, 17, 23, 4, 31, "Z");
  return g.rows();
}

function machineRoom() {
  const g = new Grid(28, 14);
  g.rect(0, 0, 28, 14, "C").hline(0, 0, 28, "t").vline(27, 0, 14, "z");
  g.rect(4, 4, 8, 6, "Z");
  for (let y = 5; y < 10; y += 2) g.hline(5, y, 6, "T");
  g.rect(16, 3, 7, 11, "z").set(21, 8, "t");
  return g.rows();
}


// ---------------------------------------------------------------------------
// W-15 (Later; spec §9, §12.2, §12.3, §14.3): per-state surroundings and vault
// art, the Skyscraper and Megacorp roofs, the construction sequence, night and
// bankruptcy. Every decoration shows state (the building's size, the time, the
// reserve) or gives the eye somewhere to go; there are no people in any of it.

/** Nearer city blocks behind the Office tower and up (tiles horizontally). */
function blocks(lit = false) {
  const w = 160, h = 96;
  const g = new Grid(w, h);
  const r = rng(23);
  let x = 0;
  while (x < w) {
    const bw = Math.min(14 + Math.floor(r() * 18), w - x);
    const bh = 30 + Math.floor(r() * 62);
    g.rect(x, h - bh, bw, bh, "=").hline(x, h - bh, bw, "#");
    for (let wy = h - bh + 4; wy < h - 3; wy += 5)
      for (let wx = x + 2; wx < x + bw - 3; wx += 4) {
        const on = r() < 0.25;
        g.rect(wx, wy, 2, 2, on ? (lit ? "L" : "l") : "K");
      }
    x += bw + 2 + Math.floor(r() * 4);
  }
  return g.rows();
}

/** A flat cloud: puffs on a flat base, a lighter top edge. */
function cloud(w, seed) {
  const g = new Grid(w, 14);
  const r = rng(seed);
  for (let i = 0; i < Math.floor(w / 9); i++) disc(g, 6 + Math.floor(r() * (w - 12)), 8, 3 + Math.floor(r() * 3), "l");
  g.rect(3, 8, w - 6, 4, "l");
  for (let y = 0; y < 14; y++) for (let x = 0; x < w; x++) if (g.get(x, y) === "l" && g.get(x, y - 1) === ".") g.set(x, y, "D");
  return g.rows();
}

/** The Megacorp blimp: the envelope carries the boss's latest announcement on its panel. */
function blimp() {
  const g = new Grid(100, 34);
  for (let y = 0; y < 25; y++)
    for (let x = 0; x < 92; x++) {
      const dx = (x - 46) / 46, dy = (y - 12) / 12.5;
      if (dx * dx + dy * dy <= 1) g.set(x + 8, y, y >= 18 ? "z" : "C");
    }
  // Tail fins on the left.
  for (let i = 0; i < 7; i++) g.hline(i, 2 + i, 12 - i, "z").hline(i, 22 - i, 12 - i, "z");
  // The announcement panel (the renderer writes on it) with an accent rule: company signage.
  g.rect(24, 5, 60, 13, "n").box(24, 5, 60, 13, "D").hline(25, 16, 58, "A");
  // Gondola.
  g.vline(52, 25, 2, "T").vline(62, 25, 2, "T");
  g.rect(48, 27, 18, 6, "Z").hline(48, 27, 18, "T");
  for (const x of [51, 55, 59]) g.rect(x, 29, 2, 2, "q");
  return g.rows();
}

/** The empty lot beside the Garage startup: a chain-link fence (tiles horizontally). */
function fence() {
  const g = new Grid(16, 18);
  for (let y = 2; y < 17; y++) for (let x = 2; x < 16; x++) if ((x + y) % 4 === 0 || (x - y + 64) % 4 === 0) g.set(x, y, "Z");
  g.rect(0, 0, 2, 18, "T").hline(0, 1, 16, "T").hline(0, 17, 16, "T");
  return g.rows();
}

function tree() {
  const g = new Grid(34, 54);
  g.rect(15, 30, 4, 24, "d").vline(16, 30, 24, "O");
  line(g, 17, 38, 9, 30, "d");
  line(g, 17, 36, 25, 28, "d");
  disc(g, 17, 18, 13, "G");
  disc(g, 9, 24, 8, "G");
  disc(g, 25, 23, 8, "G");
  disc(g, 15, 14, 9, "g");
  disc(g, 22, 20, 6, "g");
  disc(g, 8, 22, 5, "g");
  return g.rows();
}

/** A parked car in profile for the Small office's lot. */
function car(body, shade) {
  const g = new Grid(30, 14);
  g.rect(8, 1, 13, 1, body).rect(7, 2, 15, 4, body);
  g.rect(8, 2, 6, 4, "q").rect(15, 2, 6, 4, "q").set(8, 2, body).set(20, 2, body);
  g.set(9, 3, "Q").set(16, 3, "Q");
  g.rect(1, 6, 28, 5, body).hline(1, 10, 28, shade);
  g.set(28, 7, "L").set(1, 7, "b");
  disc(g, 7, 11, 2, "Z").set(7, 11, "t");
  disc(g, 22, 11, 2, "Z").set(22, 11, "t");
  return g.rows();
}

function parkingSign() {
  const g = new Grid(9, 28);
  g.rect(0, 0, 9, 9, "c").box(0, 0, 9, 9, "D");
  g.text("P", 3, 2, "f", FONT3);
  g.rect(4, 9, 1, 19, "T");
  return g.rows();
}

/** The coffee cart (nobody minds it: there are no extra people, spec §4.5). */
function coffeeCart() {
  const g = new Grid(36, 38);
  for (let y = 0; y < 6; y++) {
    const half = 3 + y * 3;
    for (let x = 18 - half; x <= 18 + half; x++) g.set(x, y, Math.floor((x + 2) / 4) % 2 ? "B" : "c");
  }
  g.hline(0, 6, 36, "b");
  g.vline(18, 7, 13, "T");
  g.rect(22, 15, 7, 5, "t").rect(23, 16, 2, 2, "Z");
  g.rect(8, 17, 3, 3, "c").hline(8, 17, 3, "e");
  g.rect(4, 20, 28, 12, "O").box(4, 20, 28, 12, "d").hline(4, 20, 28, "J");
  g.rect(12, 23, 12, 6, "n").box(12, 23, 12, 6, "D");
  g.rect(16, 24, 3, 3, "c").set(19, 25, "c").hline(16, 27, 3, "e");
  line(g, 32, 22, 35, 18, "T");
  disc(g, 10, 34, 3, "Z").set(10, 34, "t");
  disc(g, 26, 34, 3, "Z").set(26, 34, "t");
  return g.rows();
}

/** The second Megacorp tower: one floor of its facade (tiles vertically), dark or lit. */
function twinFacade(lit) {
  const g = new Grid(32, FLOOR_H + SLAB);
  g.rect(0, 0, 32, FLOOR_H + SLAB, "t");
  for (const x of [3, 17]) {
    g.rect(x, 6, 12, 38, "q").vline(x + 10, 6, 38, "Q");
    if (lit) g.hline(x, 6, 12, "L").hline(x, 7, 12, "L");
  }
  g.vline(15, 0, FLOOR_H, "T").vline(31, 0, FLOOR_H, "T");
  g.rect(0, FLOOR_H, 32, SLAB, "T").hline(0, FLOOR_H, 32, "t");
  return g.rows();
}

function twinParapet() {
  const g = new Grid(32, 8);
  g.rect(0, 0, 32, 8, "t").hline(0, 0, 32, "T").hline(0, 7, 32, "T");
  return g.rows();
}

/** The enclosed sky bridge between the twin towers (tiles horizontally). */
function skyBridge() {
  const g = new Grid(16, 14);
  g.rect(0, 0, 16, 3, "t").rect(0, 11, 16, 3, "t");
  g.rect(0, 3, 16, 8, "q").hline(0, 4, 16, "Q");
  g.vline(0, 3, 8, "T");
  g.hline(0, 2, 16, "T").hline(0, 11, 16, "T");
  return g.rows();
}

// Roofs of the last two states.

/** The ticker: an LED board reading $REORG (spec §12.2), the signage from the Skyscraper on. */
function ticker(lines) {
  const widths = lines.map((l) => textWidth(l, FONT5));
  const tw = Math.max(...widths);
  const bh = lines.length * 9 + 5;
  const g = new Grid(tw + 14, bh + 8);
  g.rect(0, 0, tw + 14, bh, "Z").box(0, 0, tw + 14, bh, "T");
  g.rect(2, 2, tw + 10, bh - 4, "k");
  for (let y = 3; y < bh - 3; y += 2) for (let x = 3; x < tw + 11; x += 2) g.set(x, y, "l");
  lines.forEach((l, i) => g.text(l, 7 + ((tw - widths[i]) >> 1), 4 + i * 9, "A", FONT5));
  g.rect(5, bh, 2, 8, "T").rect(tw + 7, bh, 2, 8, "T");
  return g.rows();
}

function antenna() {
  const g = new Grid(9, 70);
  g.rect(3, 4, 3, 66, "T").vline(4, 4, 66, "Z");
  for (let y = 12; y < 64; y += 10) g.hline(1, y, 7, "T");
  line(g, 0, 69, 3, 48, "T");
  line(g, 8, 69, 5, 48, "T");
  g.rect(3, 0, 3, 3, "L").set(4, 3, "T");
  return g.rows();
}

function helipad() {
  const g = new Grid(60, 16);
  g.rect(0, 6, 60, 3, "t").hline(0, 9, 60, "T");
  for (let x = 2; x < 56; x += 6) g.set(x, 5, "L");
  for (const x of [4, 28, 52]) g.rect(x, 10, 2, 6, "Z");
  line(g, 6, 10, 26, 15, "Z");
  line(g, 34, 15, 52, 10, "Z");
  g.vline(58, 0, 6, "T");
  for (let x = 51; x < 58; x++) g.set(x, 0, x % 2 ? "B" : "c").set(x, 1, x % 2 ? "B" : "c");
  return g.rows();
}

// Vault art per state (spec §12.2); the Office tower keeps the round door.

function cashBox() {
  const g = new Grid(30, 22);
  g.rect(0, 10, 30, 12, "O").box(0, 10, 30, 12, "d").hline(0, 15, 30, "d");
  line(g, 1, 11, 28, 20, "d");
  g.rect(5, 2, 20, 8, "T").box(5, 2, 20, 8, "Z").hline(5, 5, 20, "Z");
  g.rect(13, 0, 4, 2, "Z").rect(14, 6, 2, 2, "Y");
  return g.rows();
}

function wallSafe() {
  const g = new Grid(30, 30);
  g.rect(0, 0, 30, 30, "z").box(0, 0, 30, 30, "Z");
  g.rect(3, 3, 24, 24, "T").box(3, 3, 24, 24, "Z");
  disc(g, 15, 13, 5, "t");
  disc(g, 15, 13, 3, "Z");
  for (let a = 0; a < 8; a++) {
    const t = (a / 8) * Math.PI * 2;
    g.set(15 + Math.round(Math.cos(t) * 5), 13 + Math.round(Math.sin(t) * 5), "Z");
  }
  g.set(15, 13, "t").rect(19, 21, 6, 2, "t");
  g.rect(3, 7, 2, 4, "t").rect(3, 19, 2, 4, "t");
  return g.rows();
}

function wheel(g, cx, cy, r) {
  disc(g, cx, cy, r, "Z");
  disc(g, cx, cy, r - 2, "t");
  line(g, cx - r + 2, cy, cx + r - 2, cy, "Z");
  line(g, cx, cy - r + 2, cx, cy + r - 2, "Z");
  disc(g, cx, cy, 1, "Z");
}

function walkIn() {
  const g = new Grid(40, 38);
  g.rect(0, 0, 40, 38, "Z").box(0, 0, 40, 38, "T");
  g.rect(4, 3, 32, 35, "T").box(4, 3, 32, 35, "Z").rect(7, 6, 26, 29, "t").box(7, 6, 26, 29, "T");
  wheel(g, 20, 18, 7);
  for (let y = 8; y < 34; y += 6) g.set(9, y, "Z").set(30, y, "Z");
  g.rect(36, 8, 3, 5, "t").rect(36, 26, 3, 5, "t");
  g.rect(24, 28, 7, 2, "Z");
  return g.rows();
}

function doubleDoors() {
  const g = new Grid(42, 38);
  g.rect(0, 0, 42, 38, "Z").box(0, 0, 42, 38, "T");
  for (const x0 of [3, 21]) {
    g.rect(x0, 3, 18, 35, "t").box(x0, 3, 18, 35, "T");
    for (let y = 7; y < 35; y += 7) g.set(x0 + 2, y, "T").set(x0 + 15, y, "T");
  }
  g.vline(20, 3, 35, "Z").vline(21, 3, 35, "Z");
  wheel(g, 21, 17, 6);
  g.rect(15, 25, 2, 6, "Z").rect(25, 25, 2, 6, "Z");
  return g.rows();
}

// The construction sequence (spec §12.3, §9 "Crane") and the For lease banners.

function scaffold() {
  const g = new Grid(16, 16);
  g.vline(0, 0, 16, "T").vline(15, 0, 16, "T");
  line(g, 1, 13, 14, 1, "Z");
  g.rect(0, 14, 16, 2, "O").hline(0, 15, 16, "d");
  return g.rows();
}

/** A tower crane's mast (tiles vertically), in cardboard tan so it reads as equipment, not coins. */
function craneMast() {
  const g = new Grid(10, 10);
  g.vline(0, 0, 10, "B").vline(9, 0, 10, "B").hline(0, 0, 10, "b");
  line(g, 1, 9, 8, 1, "b");
  return g.rows();
}

function craneJib() {
  const w = 132;
  const g = new Grid(w, 14);
  g.hline(0, 4, w, "B").hline(0, 12, w, "B").hline(0, 13, w, "b");
  for (let x = 0; x < w - 4; x += 8) line(g, x, 12, x + 4, 4, "b"), line(g, x + 4, 4, x + 8, 12, "b");
  // Counterweight on the short arm, the cab under the mast head, the apex.
  g.rect(2, 6, 14, 7, "Z").hline(2, 6, 14, "T");
  g.rect(26, 5, 10, 8, "B").rect(28, 7, 6, 3, "q");
  line(g, 31, 0, 6, 4, "T");
  line(g, 31, 0, w - 2, 4, "T");
  g.rect(30, 0, 3, 4, "b");
  return g.rows();
}

function craneHook() {
  const g = new Grid(7, 9);
  g.rect(0, 0, 7, 4, "Z").hline(0, 0, 7, "T");
  g.vline(3, 4, 3, "T").hline(3, 7, 3, "T").set(5, 6, "T");
  return g.rows();
}

/** A steel beam on the hook: what the crane brings when a tier gets a new floor. */
function beam() {
  const g = new Grid(44, 5);
  g.rect(0, 0, 44, 5, "T").hline(0, 0, 44, "t").hline(0, 4, 44, "Z");
  for (let x = 4; x < 44; x += 8) g.set(x, 2, "Z");
  return g.rows();
}

/** The ribbon across the front doors, and one cut half of it. */
function ribbon(half) {
  const w = half ? 22 : 44;
  const g = new Grid(w, 10);
  g.hline(0, 3, w, "c").hline(0, 4, w, "m");
  if (!half) {
    disc(g, 22, 4, 3, "c");
    g.set(22, 4, "m");
    line(g, 21, 6, 17, 9, "c");
    line(g, 23, 6, 27, 9, "c");
  }
  return g.rows();
}

function forLease() {
  const g = new Grid(28, 22);
  line(g, 4, 0, 1, 6, "T");
  line(g, 23, 0, 26, 6, "T");
  g.rect(0, 6, 28, 16, "c").box(0, 6, 28, 16, "D");
  g.text("FOR", 9, 8, "k", FONT3);
  g.text("LEASE", 4, 15, "k", FONT3);
  return g.rows();
}

/** Bankruptcy (spec §14.3, Later): the sign flips to a cardboard CLOSED. */
function signClosed() {
  const tw = textWidth("CLOSED", FONT5);
  const g = new Grid(tw + 10, 16);
  g.rect(1, 0, tw + 8, 12, "B").hline(1, 11, tw + 8, "b").vline(tw + 8, 0, 12, "b");
  g.text("CLOSED", 5, 2, "k", FONT5);
  g.rect(3, 12, 2, 4, "d").rect(tw + 5, 12, 2, 4, "d");
  return g.rows();
}

// ---------------------------------------------------------------------------
// Tile table

const ROOM_TILES = { directors: DIRECTOR, managers: MANAGER, associates: ASSOCIATE, interns: INTERN };

export const TILES = {
  "sky.skyline": skyline(),
  "bldg.slab": SLAB_TILE,
  ...Object.fromEntries(
    STATES.flatMap((s) => [
      [`shell.${s}.wall`, SHELL[s].wall],
      [`shell.${s}.window`, SHELL[s].window],
      [`shell.${s}.slab`, SHELL[s].slab],
      [`shell.${s}.parapet`, SHELL[s].parapet],
      [`shell.${s}.front`, storefront(s)],
    ]),
  ),
  "sign.garage": signGarage(),
  "sign.office": signOffice(),
  "sign.tower": signTower(),
  "sign.skyscraper": ticker(["$REORG"]),
  "sign.megacorp": ticker(["REORG INC.", "$REORG"]),
  "sign.closed": signClosed(),
  "roof.antenna": antenna(),
  "roof.helipad": helipad(),
  "sky.skyline.lit": skyline(true),
  "sky.blocks": blocks(),
  "sky.blocks.lit": blocks(true),
  "sky.cloud.0": cloud(48, 5),
  "sky.cloud.1": cloud(30, 9),
  "sky.blimp": blimp(),
  "surr.fence": fence(),
  "surr.tree": tree(),
  "surr.car.0": car("f", "F"),
  "surr.car.1": car("C", "z"),
  "surr.car.2": car("B", "b"),
  "surr.parking": parkingSign(),
  "surr.cart": coffeeCart(),
  "twin.facade": twinFacade(false),
  "twin.facade.lit": twinFacade(true),
  "twin.parapet": twinParapet(),
  "twin.bridge": skyBridge(),
  "vault.cashbox": cashBox(),
  "vault.safe": wallSafe(),
  "vault.walkin": walkIn(),
  "vault.double": doubleDoors(),
  "build.scaffold": scaffold(),
  "build.crane.mast": craneMast(),
  "build.crane.jib": craneJib(),
  "build.crane.hook": craneHook(),
  "build.beam": beam(),
  "build.ribbon": ribbon(false),
  "build.ribbon.half": ribbon(true),
  "build.forlease": forLease(),
  "roof.tank": waterTank(),
  "roof.machine": machineRoom(),
  "core.stairs": stairs(),
  "core.stairs.top": stairsTop(),
  "core.shaft": shaft(),
  "core.shaft.top": shaftTop(),
  "core.tube": TUBE,
  "core.tube.outlet": TUBE_OUTLET,
  "core.tube.cap": TUBE_CAP,
  "core.tube.foot": tubeFoot(),
  "core.cab": cab(),
  "core.cab.door.0": cabDoors(0),
  "core.cab.door.1": cabDoors(0.5),
  "core.cab.door.2": cabDoors(1),
  "core.indicator.off": indicator(null),
  "core.indicator.up": indicator("up"),
  "core.indicator.down": indicator("down"),
  "wall.window": backWindow(24, 17, 3),
  "wall.window.big": backWindow(96, 30, 9),
  ...Object.fromEntries(POSTERS.map((p, i) => [`wall.poster.${i}`, p])),
  "wall.clock": clockFace(),
  ...Object.fromEntries(CLOCK_HANDS.map((h, i) => [`wall.clock.hand.${i}`, h])),
  "wall.whiteboard": whiteboard(),
  "wall.board.small": boardSmall(),
  "wall.alarm.off": ALARM_OFF,
  "wall.alarm.on": ALARM_ON,
  "wall.lamp": LAMP,
  ...Object.fromEntries(
    Object.entries(ROOM_TILES).flatMap(([tier, t]) => [
      [`room.${tier}.back`, t.back],
      [`room.${tier}.front`, t.front],
      [`room.${tier}.empty`, t.empty],
    ]),
  ),
  "room.directors.wall": DIRECTOR_WALL,
  "furn.plant.floor": floorPlant(),
  bay: bay(),
  ...Object.fromEntries(SHEETS.map((s, i) => [`prop.sheets.${i + 1}`, s])),
  "lobby.cafe": cafe(),
  "lobby.stool": STOOL,
  "lobby.table": table(),
  "lobby.door.hr": hrDoor(),
  "lobby.reception": reception(),
  "lobby.logo": lobbyLogo(),
  "lobby.plant": lobbyPlant(),
  "lobby.door.glass.0": glassDoors(0),
  "lobby.door.glass.1": glassDoors(0.5),
  "lobby.door.glass.2": glassDoors(1),
  "lobby.rollup.0": rollup(0),
  "lobby.rollup.1": rollup(0.5),
  "lobby.rollup.2": rollup(1),
  "street.pavement": pavement(),
  "street.bench": bench(),
  "street.lamp": streetLamp(),
  "prop.tape": TAPE,
  "vault.door": vaultDoor(),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`vault.pile.${i}`, coinPile(i)])),
  "vault.bar": vaultBar(),
  "vault.boxes": depositBoxes(),
  "server.rack": rack(false),
  "server.rack.stalled": rack(true),
  "pent.desk": bossDesk(),
  "pent.shelf": bookshelf(),
  "pent.orgchart": orgChart(),
};

// ---------------------------------------------------------------------------
// Rig: geometry and placement for the renderer (and scene.mjs).

const STAND = GEOM.street.standY;

export const BUILDING = {
  animations: {
    "core.cab.open": { frames: ["core.cab.door.0", "core.cab.door.1", "core.cab.door.2"], fps: 5, loop: false },
    "core.cab.close": { frames: ["core.cab.door.2", "core.cab.door.1", "core.cab.door.0"], fps: 5, loop: false },
    "lobby.door.glass.open": { frames: ["lobby.door.glass.0", "lobby.door.glass.1", "lobby.door.glass.2"], fps: 7.5, loop: false },
    "lobby.door.glass.close": { frames: ["lobby.door.glass.2", "lobby.door.glass.1", "lobby.door.glass.0"], fps: 7.5, loop: false },
    "lobby.rollup.open": { frames: ["lobby.rollup.0", "lobby.rollup.1", "lobby.rollup.2"], fps: 5, loop: false },
    "lobby.rollup.close": { frames: ["lobby.rollup.2", "lobby.rollup.1", "lobby.rollup.0"], fps: 5, loop: false },
    // Three pulses when a task opens (spec §9); never more than 3 flashes per second.
    "wall.alarm.pulse": { frames: ["wall.alarm.on", "wall.alarm.off", "wall.alarm.on", "wall.alarm.off", "wall.alarm.on", "wall.alarm.off"], fps: 4, loop: false },
  },
  rig: {
    units: "Sprite pixels from the building's left edge (x) and each band's ceiling (y), y down.",
    geometry: GEOM,
    states: {
      // vault: the reserve's art per state, bottom on the basement floor (y 54) unless it hangs on the wall.
      // roof: extra roof tiles standing on the parapet line. surroundings: what stands beside the building.
      garage: { employees: [1, 10], sign: "sign.garage", doors: "lobby.rollup", vault: { tile: "vault.cashbox", x: 58, y: 32 }, roof: [], surroundings: "lot" },
      office: { employees: [11, 50], sign: "sign.office", doors: "lobby.door.glass", vault: { tile: "vault.safe", x: 58, y: 12 }, roof: [], surroundings: "parking" },
      tower: { employees: [51, 250], sign: "sign.tower", doors: "lobby.door.glass", vault: { tile: "vault.door", x: 56, y: 18 }, roof: [], surroundings: "city" },
      skyscraper: {
        employees: [251, 1000],
        sign: "sign.skyscraper",
        doors: "lobby.door.glass",
        vault: { tile: "vault.walkin", x: 54, y: 16 },
        roof: [{ tile: "roof.antenna", x: 60 }, { tile: "roof.helipad", x: 232 }],
        surroundings: "clouds",
      },
      megacorp: {
        employees: [1001, 2000],
        sign: "sign.megacorp",
        doors: "lobby.door.glass",
        vault: { tile: "vault.double", x: 53, y: 16 },
        roof: [{ tile: "roof.antenna", x: 60 }, { tile: "roof.helipad", x: 232 }],
        surroundings: "skyline",
      },
    },
    /**
     * W-15 (Later): what stands beside the building, per surroundings set (states[].surroundings).
     * x is from the building's left edge (negative: left of it); props stand on the street line
     * (the street band's top) and `w` tiles one horizontally. The layers say which sets show them.
     */
    surroundings: {
      props: {
        lot: [
          { tile: "surr.fence", x: -236, w: 208 },
          { tile: "surr.tree", x: -140 },
          { tile: "surr.fence", x: 412, w: 192 },
        ],
        parking: [
          { tile: "surr.car.0", x: -196 },
          { tile: "surr.car.1", x: -160 },
          { tile: "surr.car.2", x: -124 },
          { tile: "surr.parking", x: -64 },
          { tile: "surr.cart", x: 420 },
          { tile: "surr.tree", x: 480 },
        ],
        city: [{ tile: "surr.cart", x: 420 }],
        clouds: [{ tile: "surr.cart", x: 420 }],
        skyline: [],
      },
      blocks: { tile: "sky.blocks", lit: "sky.blocks.lit", sets: ["city", "clouds", "skyline"], note: "nearer city blocks, tiled behind the building in front of sky.skyline" },
      clouds: { tiles: ["sky.cloud.0", "sky.cloud.1"], speed: 4, sets: ["clouds", "skyline"], note: "drift right at speed px/s past the upper floors and wrap; still under reduced motion" },
      blimp: { tile: "sky.blimp", panel: { x: 24, y: 5, w: 60, h: 11 }, sets: ["skyline"], note: "right of the building near the top, in front of the second tower; the panel carries the boss's latest line" },
      twin: {
        facade: "twin.facade",
        lit: "twin.facade.lit",
        parapet: "twin.parapet",
        bridge: "twin.bridge",
        gap: 40,
        columns: 5,
        sets: ["skyline"],
        note: "a second tower right of the building, gap px away, columns × 32 px wide; it rises with the employee count (1,001 → 2,000), joined by the sky bridge two floors below its top",
      },
    },
    construction: {
      scaffold: "build.scaffold tiles up both outer walls, 16 px out, while the 4 s construction sequence plays (spec §12.3)",
      crane: { mast: "build.crane.mast", jib: "build.crane.jib", hook: "build.crane.hook", x: 280, hookX: 120, note: "the mast stands on the roof at x; the jib's mast head is at its x 31; the hook hangs from jib x hookX on a cable" },
      beam: "build.beam: carried on the hook to a new floor's level outside the right wall (spec §9 Crane)",
      ribbon: { tile: "build.ribbon", half: "build.ribbon.half", x: 334, y: 30, note: "across the front doors in the lobby band; it splits into two halves that fall away" },
      forLease: { tile: "build.forlease", note: "hung outside the outer walls on the upper floors while the building right-sizes" },
    },
    closed: { tile: "sign.closed", note: "bankruptcy (Later): replaces the roof sign" },
    bands: "Top to bottom: roof, penthouse, tier floors (Directors, Managers, Associates, Interns), lobby, street, basement. A floor band is floor.h tall plus a slab of floor.slab rows below it; feet stand on the slab's first row (y = floor.h).",
    shell: {
      wall: "shell.<state>.wall tiles down both outer walls (x 0 and x 376) over each band's interior; shell.<state>.window on the right wall at y 12 of every floor (the bay's window point); shell.<state>.slab where each slab meets the wall",
      parapet: "shell.<state>.parapet along the roof line, above the penthouse",
      front: "shell.<state>.front, one per 72 px across the lobby's rooms from x 48, then the doors in the bay: in front of lobby characters, behind street characters",
      slab: "bldg.slab tiles across x 48..376 under every floor; the core tiles carry their own slab",
    },
    core: {
      stairs: "core.stairs at (stairs.x, floor top) on every floor from the lobby to the top tier; core.stairs.top in the penthouse. Climb: from (x 2, floor line) up the lower flight to the landing, then up the upper flight to (x 2, y -4), the next floor's line. Mirror the character on the upper flight.",
      landing: { x: 14, y: 20 },
      tube: "core.tube at (tube.x, band top) on every band from the basement to the top tier; core.tube.cap on top; core.tube.foot in the basement",
      outlet: { x: 28, y: 27, mouth: [34, 29], note: "core.tube.outlet on every tier floor: coins pop out of the mouth and arc to the desks" },
      shaft: "core.shaft on every floor from the lobby to the top tier; core.shaft.top in the penthouse",
      cab: { x: 29, floorRow: 30, note: "core.cab top-left = (29, floor line - 30); riders stand on its row 30, inside x 30..45; core.cab.door.<0|1|2> over the riders" },
      indicator: { x: 34, y: 4, note: "core.indicator.<off|up|down> above the shaft on every floor" },
    },
    floor: {
      alarm: { x: 50, y: 0 },
      clock: { x: 337, y: 3, note: "wall.clock, then wall.clock.hand.<0..7> for the share of the window left (0 = full)" },
      whiteboard: { x: 350, y: 3, text: { x: 2, y: 2, w: 18, h: 8, note: "the task number" } },
      bay: { x: 336, y: 0, points: { cooler: 343, printer: 355, outbox: 360, coffee: 362, window: 368 } },
      outboxSheets: { x: 360, y: 29, note: "prop.sheets.<1..6>, one sheet per submission from the floor" },
      plaque: { x: 50, y: 6, note: "tier name and headcount in screen-size text, on the first floor of each tier" },
      posters: { y: 3, note: "wall.poster.<0..2> on the interns' back wall, one per 72 px from x 102 (decoration)" },
    },
    rooms: ROOM_ANCHORS,
    roomTiles: "room.<tier>.back behind the chair; room.<tier>.front (or .empty) in front of the seated character; rooms start at rooms.x and repeat every rooms[tier].w. Directors' rooms close with room.directors.wall at the right end (x 332).",
    penthouse: {
      h: GEOM.penthouse.h,
      window: { tile: "wall.window.big", x: 150, y: 10 },
      shelf: { tile: "pent.shelf", x: 70, y: 22 },
      orgchart: { tile: "pent.orgchart", x: 272, y: 12 },
      desk: { tile: "pent.desk", x: 170, y: 47 },
      chair: { tile: "prop.chair.exec.front", x: 189, y: 40 },
      boss: { home: 206, paceFrom: 110, paceTo: 330, window: 196, note: "the boss stands on the penthouse floor line, y 64" },
    },
    lobby: {
      logo: { tile: "lobby.logo", x: 182, y: 6 },
      reception: { tile: "lobby.reception", x: 180, y: 28 },
      cafe: { tile: "lobby.cafe", x: 56, y: 18, stools: [96, 108], table: { x: 120, y: 34 } },
      hrDoor: { tile: "lobby.door.hr", x: 146, y: 12 },
      plants: [{ tile: "lobby.plant", x: 258, y: 20 }],
      doors: { x: 336, y: 0, point: 356, note: "lobby.door.glass.<n> (lobby.rollup.<n> in the garage) fill the bay, in the street front's layer" },
      points: { stairs: 10, elevator: 38, cafe: 72, hr: 156, reception: 210, door: 356 },
      crowdSign: { x: 276, y: 8, w: 56, h: 22, note: "paper sign taped on the glass left of the doors (spec §12.5); prop.tape at its top corners; text in the 13 px label style" },
    },
    street: {
      h: GEOM.street.h,
      standY: STAND,
      tile: "street.pavement",
      note: "street.pavement tiles across the full stage width; the sidewalk is in front of the lobby, so street characters overlap the lobby's street front",
      bench: { tile: "street.bench", x: 120, y: STAND - 10, seats: [122, 134, 146, 158], note: "up to 4 laid-off employees (emp.bench), then a +n sign; prop.box.full beside the last seat" },
      lamp: { tile: "street.lamp", x: 186, y: STAND - 64 },
      queue: { spots: [338, 320, 302, 284, 266], note: "visitors (emp.visitor) facing the doors, up to 5, then +n" },
      door: { x: 356, note: "characters step out of the doors (the lobby floor line) and down to the sidewalk (standY) in 0.4 s: walking toward the viewer" },
    },
    basement: {
      h: GEOM.basement.h,
      ceiling: "the first 3 rows are the ground-floor slab under the sidewalk (concrete shade)",
      tubeFoot: { tile: "core.tube.foot", x: 19, y: 38 },
      vaultDoor: { tile: "vault.door", x: 56, y: 18 },
      boxes: { tile: "vault.boxes", x: 100, y: 8 },
      bar: { tile: "vault.bar", x: 140, y: 10, fill: { x: 2, y: 2, w: 40, h: 10 }, note: "fill = min(1, runway_tasks / 30) in the coin color, Bad when low (spec §4.6)" },
      pile: { tile: "vault.pile.<0..5>", x: 138, bottom: 56, note: "level = round(fill * 5)" },
      partition: { x: 232 },
      racks: [{ tile: "server.rack", x: 252, y: 16 }, { tile: "server.rack", x: 270, y: 16 }, { tile: "server.rack", x: 288, y: 16 }],
    },
    roof: {
      h: GEOM.roof.h,
      sign: "sign.<state>, centered on the rooms, standing on the roof line",
      tank: { tile: "roof.tank", x: 300 },
      machine: { tile: "roof.machine", x: 22, note: "above the elevator shaft" },
    },
  },
};
