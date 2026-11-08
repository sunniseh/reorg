// REORG character and prop sprites, drawn as ASCII pixel maps.
//
// TODO(art): placeholder art. Replace with the final character art before launch;
// keep the frame names, sizes, layers and RIG below so the renderer does not change.
// See art/README.md.
//
// One character = up to three stacked sprites from the same atlas, all the same
// size and anchor, so the renderer only sets textures and tints:
//   base   fixed colors (skin, face, trousers, props)
//   shirt  grayscale, tinted with the body token from the wallet hash
//   hair   grayscale, tinted with a hair color from the wallet hash (P1)
// See docs/design/REORG Design Spec.md §5.

import { C, SPRITE, TINT_BASE, TINT_SHADE } from "./palette.mjs";
import { multiply, gridToSvg } from "./lib.mjs";

// Legend: character -> [layer, color]
const LEGEND = {
  S: ["base", C.skin],
  s: ["base", SPRITE.skinShade],
  k: ["base", C.bg],
  c: ["base", C.ink],
  m: ["base", C.muted],
  l: ["base", C.line],
  D: ["base", C.deskEdge],
  n: ["base", C.panel],
  P: ["base", SPRITE.trousers],
  A: ["base", C.accent],
  a: ["base", SPRITE.accentShade],
  B: ["base", SPRITE.cardboard],
  b: ["base", SPRITE.cardboardShade],
  g: ["base", SPRITE.plant],
  G: ["base", SPRITE.plantDark],
  Y: ["base", C.coin],
  y: ["base", SPRITE.coinShade],
  W: ["shirt", TINT_BASE],
  w: ["shirt", TINT_SHADE],
  H: ["hair", TINT_BASE],
  h: ["hair", TINT_SHADE],
};

// ---------------------------------------------------------------------------
// Map helpers

function check(name, rows) {
  const w = rows[0].length;
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`${name}: row ${i} is ${r.length} wide, expected ${w}: "${r}"`);
    for (const ch of r) if (ch !== "." && !LEGEND[ch]) throw new Error(`${name}: unknown pixel "${ch}" in row ${i}`);
  });
  return rows;
}

/** Stacks maps vertically. */
const stack = (...parts) => parts.flat();

/** Paints `top` over `base` starting at row `at`. "." keeps the base; "_" clears it. */
function paint(base, top, at = 0) {
  const out = [...base];
  top.forEach((row, i) => {
    const r = out[at + i].split("");
    [...row].forEach((ch, j) => {
      if (ch === "_") r[j] = ".";
      else if (ch !== ".") r[j] = ch;
    });
    out[at + i] = r.join("");
  });
  return out;
}

const pad = (rows, left, right) => rows.map((r) => ".".repeat(left) + r + ".".repeat(right));

/** Splits a map into layer grids (rows of hex or null). */
function layers(name, rows) {
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

/** Inner outline of a map's silhouette, in one color: the visitor figure. */
function outline(rows, ch) {
  const h = rows.length, w = rows[0].length;
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== ".";
  return rows.map((row, y) =>
    [...row]
      .map((_, x) => (on(x, y) && (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)) ? ch : "."))
      .join(""),
  );
}

// ---------------------------------------------------------------------------
// Employee: 16 px wide. Head in rows 0-11 for every pose, so hair sprites line
// up without per-frame offsets. Faces right in profile; mirror to face left.

const HEAD_FRONT = [
  "................",
  "....SSSSSSSS....",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "..sSSkSSSSkSSs..",
  "..sSSkSSSSkSSs..",
  "...SSSSSSSSSS...",
  "...SSSSkkSSSS...",
  "....sSSSSSSs....",
  ".....ssssss.....",
  "......ssss......",
];

const HEAD_SIDE = [
  "................",
  "....SSSSSSS.....",
  "...SSSSSSSSS....",
  "...SSSSSSSSSS...",
  "...SSSSSSSSSS...",
  "...SSSsSSSkSS...",
  "...SSSsSSSkSSS..",
  "...SSSSSSSSSSS..",
  "...SSSSSSSSkS...",
  "....sSSSSSSS....",
  ".....sssssss....",
  "......sss.......",
];

// Seated, facing the viewer. Rows 12-19; the desk covers everything below row 19.
const TORSO_SIT_FRONT = [
  "...wWWcsscWWw...",
  "..wWWWckkcWWWw..",
  ".wWWWWWkkWWWWWw.",
  ".wWwWWWkkWWWwWw.",
  ".wWwWWWkkWWWwWw.",
  ".wWwWWWWWWWWwWw.",
  ".wWwWWWWWWWWwWw.",
  ".SSwWWWWWWWWwSS.",
];

// Seated in profile, typing (two frames).
const TORSO_TYPE = [
  [
    "....wWWWWcc.....",
    "...wWWWWWWck....",
    "...wWWWWWWWW....",
    "...wWwWWWWWW....",
    "...wWwWWWWWWWSS.",
    "...wWWwwwwwww...",
    "...wWWWWWWWW....",
    "...wWWWWWWWW....",
  ],
  [
    "....wWWWWcc.....",
    "...wWWWWWWck....",
    "...wWWWWWWWW....",
    "...wWwWWWWWW.SS.",
    "...wWwWWWWWWWW..",
    "...wWWwwwwwww...",
    "...wWWWWWWWW....",
    "...wWWWWWWWW....",
  ],
];

// Standing in profile: torso rows 12-19, legs rows 20-25.
const TORSO_STAND_SIDE = [
  "....wWWWWcc.....",
  "...wWWWWWWck....",
  "...wWWWWWWWW....",
  "...wWWWWWWWW....",
  "...wWWWWWWWW....",
  "...wWWWWWWWW....",
  "...wWWWWWWWW....",
  "...PPPPPPPPP....",
];

const ARM = {
  down: [
    "......w.........",
    "......w.........",
    "......w.........",
    "......w.........",
    "......w.........",
    "......SS........",
  ],
  fwd: [
    "......w.........",
    ".......w........",
    "........w.......",
    ".........w......",
    "..........wSS...",
    "................",
  ],
  back: [
    "......w.........",
    ".....w..........",
    "....w...........",
    "..ww............",
    "SS..............",
    "................",
  ],
};

const LEGS = {
  contact: [
    "...PPP...PPP....",
    "..PPP.....PPP...",
    "..PPP.....PPP...",
    ".PPP.......PPP..",
    ".PPP.......PPP..",
    "kkk.........kkkk",
  ],
  pass: [
    "....PPPPPP......",
    ".....PPPP.......",
    ".....PPPP.......",
    ".....PPPP.......",
    ".....PPPP.......",
    ".....kkkkkk.....",
  ],
};

// Holding the box on the way out: arms forward, a plant in the box.
const CARRY = [
  "...........gG...",
  "..........gGgG..",
  ".........BBBBBBB",
  ".........bBBBBBB",
  "......wwwSBBBBBB",
  ".........BBBBBBB",
  ".........BBBBBBB",
  ".........bbbbbbb",
];

// Standing, facing the viewer: the source of the visitor outline.
const STAND_FRONT = stack(HEAD_FRONT, [
  "...wWWcsscWWw...",
  "..wWWWckkcWWWw..",
  ".wWWWWWkkWWWWWw.",
  ".wWwWWWkkWWWwWw.",
  ".wWwWWWkkWWWwWw.",
  ".wWwWWWWWWWWwWw.",
  ".SwwWWWWWWWWwwS.",
  ".S.PPPPPPPPPP.S.",
  "...PPPPPPPPPP...",
  "...PPPP..PPPP...",
  "...PPPP..PPPP...",
  "...PPPP..PPPP...",
  "...PPPP..PPPP...",
  "..kkkkk..kkkkk..",
]);

const standSide = (arm, legs) => paint(stack(HEAD_SIDE, TORSO_STAND_SIDE, LEGS[legs]), ARM[arm], 13);
const carrySide = (legs) => paint(stack(HEAD_SIDE, TORSO_STAND_SIDE, LEGS[legs]), CARRY, 11);

// ---------------------------------------------------------------------------
// Hair (P1 styles; "short" is the P0 default). Same 16 px grid as the heads.
// `y` is the row offset from the head origin (negative = above the frame top).

const HAIR = {
  short: {
    front: {
      y: 0,
      rows: [
        "....HHHHHHHH....",
        "...HHHHHHHHHH...",
        "..HHHHHHHHHHHH..",
        "..HHHhHHHHHHHH..",
        "..HH.......hHH..",
      ],
    },
    side: {
      y: 0,
      rows: [
        "....HHHHHHH.....",
        "...HHHHHHHHH....",
        "..HHHHHHHHHHH...",
        "..HHHHHHHHHHh...",
        "..HHHHH.........",
        "..HHHH..........",
        "...hH...........",
      ],
    },
  },
  long: {
    front: {
      y: 0,
      rows: [
        "....HHHHHHHH....",
        "...HHHHHHHHHH...",
        "..HHHHHHHHHHHH..",
        "..HHHHhHHhHHHH..",
        "..HHH......HHH..",
        "..HH........HH..",
        "..HH........HH..",
        "..HH........HH..",
        "..hH........Hh..",
        "..hh........hh..",
        "..hh........hh..",
      ],
    },
    side: {
      y: 0,
      rows: [
        "....HHHHHHH.....",
        "...HHHHHHHHH....",
        "..HHHHHHHHHHH...",
        "..HHHHHHHHHHh...",
        "..HHHHHH........",
        "..HHHHH.........",
        "..HHHH..........",
        "..HHHH..........",
        "..HHHh..........",
        "..hHh...........",
        "..hh............",
      ],
    },
  },
  bun: {
    front: {
      y: -2,
      rows: [
        "......HHHH......",
        "......HhhH......",
        "....HHHHHHHH....",
        "...HHHHHHHHHH...",
        "..HHHHHHHHHHHH..",
        "..HHH......HHH..",
        "..HH........HH..",
      ],
    },
    side: {
      y: -2,
      rows: [
        "..HHH...........",
        ".HhhH...........",
        "..HHHHHHHH......",
        "..HHHHHHHHH.....",
        "..HHHHHHHHHHH...",
        "..HHHHHHHHHHh...",
        "..HHHH..........",
        "..HHH...........",
      ],
    },
  },
  curly: {
    front: {
      y: -1,
      rows: [
        "...H.HH..HH.H...",
        "..HhHHhHHhHHhH..",
        ".HHHHHHHHHHHHHH.",
        ".HhHHHHHHHHHHhH.",
        ".HHHhHHhHHhHHHH.",
        ".HH..........HH.",
        ".hH..........Hh.",
        "..h..........h..",
      ],
    },
    side: {
      y: -1,
      rows: [
        "....H.HH.H......",
        "...HhHHhHHH.....",
        "..HHHHHHHHHH....",
        ".HHhHHHHHHHHH...",
        ".HHHHHHhHHHh....",
        ".HhHHHH.........",
        ".HHHH...........",
        "..hH............",
      ],
    },
  },
};

export const HAIR_STYLES = ["short", "long", "bun", "curly", "none"];

// ---------------------------------------------------------------------------
// The boss: 18 px wide, standing, accent blazer, silver hair, lanyard, mug.
// Three faces (spec §17.1): smug >= 90% pass rate, forced smile 50-89%, twitchy below.

const mirror18 = (halves) => halves.map((h) => h + [...h].reverse().join(""));

const BOSS_BODY = stack(
  pad(HEAD_FRONT, 1, 1),
  mirror18([
    "....AAAcs",
    "...AAAAck",
    "..AAAAack",
    ".AAAAAack",
    ".AAAAAAck",
    ".AaAAAAck",
    ".AaAAAAAk",
    ".AaAAAAAA",
    ".SaAAAAAA",
    "..PPPPPPP",
    "..PPPPPPP",
    "...PPPP..",
    "...PPPP..",
    "...PPPP..",
    "...PPPP..",
    "..kkkkk..",
  ]),
);

const BOSS_HAIR = [
  "....mmmmmmmmmm....",
  "...mmmmmmmmmmmm...",
  "...mmmlmmmmmmmm...",
  "...mmmlmmmmmmmm...",
  "...m..........m...",
];

// Lanyard and badge on the left, mug held in the right hand. Starts at row 13.
const BOSS_PROPS = [
  ".......c..........",
  "......c...........",
  "......c...........",
  ".....ccc.....bbb..",
  ".....ckc.....cccm.",
  ".....ccc....Scccm.",
  ".............ccc..",
  "................A.",
];

// Face overlays start at row 4 (brows), eyes on rows 5-6, mouth on rows 8-9.
const FACES = {
  smug: [
    "..................",
    "......S....k......",
    ".....kk....S......",
    "............k.....",
    ".........kkk......",
    "..................",
  ],
  smile: [
    "......k......k....",
    "......k....k......",
    "......k....k......",
    "..................",
    ".......kcccck.....",
    "........kkkk......",
  ],
  twitchy: [
    "...........kk.....",
    ".....kk....S......",
    ".....kk....k......",
    "...............c..",
    ".......kkkkk...c..",
    ".......k...k......",
  ],
};

function bossFace(face) {
  const clearFace = [
    "..................",
    "......S....S......",
    "......S....S......",
    "..................",
    "........SS........",
    "..................",
  ];
  let rows = paint(BOSS_BODY, clearFace, 4);
  rows = paint(rows, FACES[face], 4);
  rows = paint(rows, BOSS_HAIR, 0);
  rows = paint(rows, BOSS_PROPS, 13);
  return rows;
}

// ---------------------------------------------------------------------------
// Props and effects

const CHAIR_FRONT = [
  "..llllllllllllll..",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
  ".llllllllllllllll.",
];

const CHAIR_SIDE = [
  ".ll...",
  "lll...",
  "lll...",
  "lll...",
  "lll...",
  "lll...",
  "lll...",
  "lll...",
  "llllll",
];

const monitor = (q) =>
  [
    "QDDD..",
    "QQDD..",
    "QQDD..",
    "QQDD..",
    "QQDD..",
    "QQDD..",
    "QDDD..",
    "..DD..",
    "..DD..",
    ".DDDD.",
  ].map((r) => r.replaceAll("Q", q));

// Desks vary in width with the floor, so the renderer draws them; this builds
// the same shape at any width (2 px top, panel, 1 px outline, 12 px tall).
export const deskRows = (w) => [
  "D".repeat(w),
  "D".repeat(w),
  ...Array(9).fill("D" + "n".repeat(w - 2) + "D"),
  "D".repeat(w),
];
const DESK = deskRows(28);

/** A desk front as a grid of hex colors, `w` sprite pixels wide. */
export const deskGrid = (w) => layers("desk", deskRows(w)).layers.base;

const PAPER = ["ccccc", "cllcc", "ccccc", "clllc", "ccccc"];
const SWEAT = [".c.", "ccc", "ccc", ".c."];
const BOX = ["cccccccc", "c.c..c.c", "cccccccc", "c......c", "c......c", "cccccccc"];
const COIN = [
  [".YYYY.", "YYyyYY", "YyYYyY", "YyYYyY", "YYyyYY", ".YYYY."],
  ["..YY..", ".YyYY.", ".YyYY.", ".YyYY.", ".YyYY.", "..YY.."],
  ["..Yy..", "..Yy..", "..Yy..", "..Yy..", "..Yy..", "..Yy.."],
  ["..YY..", ".YYyY.", ".YYyY.", ".YYyY.", ".YYyY.", "..YY.."],
];

// ---------------------------------------------------------------------------
// Frames, rig and animations

const RAW = {
  "emp.sit.front": stack(HEAD_FRONT, TORSO_SIT_FRONT),
  "emp.type.0": stack(HEAD_SIDE, TORSO_TYPE[0]),
  "emp.type.1": stack(HEAD_SIDE, TORSO_TYPE[1]),
  "emp.walk.0": standSide("back", "contact"),
  "emp.walk.1": standSide("down", "pass"),
  "emp.walk.2": standSide("fwd", "contact"),
  "emp.walk.3": standSide("down", "pass"),
  "emp.carry.0": carrySide("contact"),
  "emp.carry.1": carrySide("pass"),
  "emp.visitor": outline(STAND_FRONT, "D"),
  "boss.smug": bossFace("smug"),
  "boss.smile": bossFace("smile"),
  "boss.twitchy": bossFace("twitchy"),
  "prop.chair.front": CHAIR_FRONT,
  "prop.chair.side": CHAIR_SIDE,
  "prop.monitor.off": monitor("l"),
  "prop.monitor.on": monitor("m"),
  "prop.monitor.flash": monitor("c"),
  "prop.desk": DESK,
  "prop.paper": PAPER,
  "prop.box": BOX,
  "fx.sweat": SWEAT,
  ...Object.fromEntries(COIN.map((f, i) => [`prop.coin.${i}`, f])),
  ...Object.fromEntries(
    Object.entries(HAIR).flatMap(([style, views]) =>
      Object.entries(views).map(([view, h]) => [`hair.${style}.${view}`, h.rows]),
    ),
  ),
};

/** name -> { w, h, layers: { base?, shirt?, hair? } } */
export const FRAMES = Object.fromEntries(Object.entries(RAW).map(([k, rows]) => [k, layers(k, rows)]));

export const RIG = {
  units: "Sprite pixels. Anchor every character frame at its bottom center.",
  tint: {
    shirt: "body token: sha256(utf8(wallet))[0] mod 8 (spec §5)",
    hair: "hair color: sha256(utf8(wallet))[2] mod 6; style: sha256(utf8(wallet))[1] mod 5, where 4 = none (P1)",
  },
  poses: {
    "emp.sit.front": { view: "front", use: "Seated, between tasks; new hire" },
    "emp.type": { view: "side", use: "Working: turned to the monitor while a task is open" },
    "emp.walk": { view: "side", use: "Rehire walk-in; mirror with scale.x = -1 to face left" },
    "emp.carry": { view: "side", use: "Layoff walk-out with the box" },
    "emp.visitor": { view: "front", use: "Lobby visitor; outline only, never filled" },
    "boss.*": { view: "front", use: "Penthouse; face from the latest pass rate (§17.1)" },
  },
  hair: Object.fromEntries(
    Object.entries(HAIR).map(([style, v]) => [style, { front: { y: v.front.y }, side: { y: v.side.y } }]),
  ),
  attach: {
    // Offsets from the character frame's top-left, in sprite pixels.
    sweat: { "emp.sit.front": [13, 1], "emp.type": [1, 2] },
    chairFront: [-1, 11],
    chairSide: [0, 11],
  },
  desk: "Seated frames end at the desk top. Draw the chair, then the character, then the desk front.",
  animations: {
    "emp.type": { frames: ["emp.type.0", "emp.type.1"], fps: 4 },
    "emp.walk": { frames: ["emp.walk.0", "emp.walk.1", "emp.walk.2", "emp.walk.3"], fps: 8 },
    "emp.carry": { frames: ["emp.carry.0", "emp.carry.1"], fps: 6 },
    "prop.coin": { frames: ["prop.coin.0", "prop.coin.1", "prop.coin.2", "prop.coin.3"], fps: 12 },
  },
};

/**
 * Flattens a frame's layers into one grid of hex colors with the given tints.
 * Draw order: base, shirt, hair. For previews and brand art, not the game.
 */
export function bake(name, { shirt = C.body[3], hair = SPRITE.hair[0] } = {}) {
  const f = FRAMES[name];
  const grid = Array.from({ length: f.h }, () => Array(f.w).fill(null));
  for (const [layer, tint] of [["base", null], ["shirt", shirt], ["hair", hair]]) {
    const g = f.layers[layer];
    if (!g) continue;
    g.forEach((row, y) =>
      row.forEach((col, x) => {
        if (col) grid[y][x] = tint ? multiply(col, tint) : col;
      }),
    );
  }
  return grid;
}

/** Bakes a character frame with hair on top. Returns { grid, top } where top <= 0 is the extra rows added above. */
export function bakeCharacter(name, { shirt, hair = SPRITE.hair[0], style = "short", view = "front" } = {}) {
  const grid = bake(name, { shirt });
  if (style === "none") return { grid, top: 0 };
  const h = HAIR[style][view];
  const hairGrid = bake(`hair.${style}.${view}`, { hair });
  const top = Math.min(0, h.y);
  const out = [...Array.from({ length: -top }, () => Array(grid[0].length).fill(null)), ...grid.map((r) => [...r])];
  hairGrid.forEach((row, y) =>
    row.forEach((col, x) => {
      if (col) out[y + h.y - top][x] = col;
    }),
  );
  return { grid: out, top };
}

// ---------------------------------------------------------------------------
// One desk cell, as the tower lays it out (spec §4-5): chair, character, desk
// front, monitor, overlays. Used by the preview sheet and the brand art; the
// game renderer builds the same picture from atlas sprites.
//
// d = { kind: "sit" | "type" | "laidoff" | "empty", shirt, hair, style, paper, sweat, you }
// (ox, oy) = cell top-left in output px; px = output px per sprite px; cellW in sprite px.

export const CELL = { h: 40, deskTop: 25, deskInset: 4, charX: 6 };

export function deskCellSvg(d, ox, oy, px, cellW = 44, { floorTint = C.floor.associates } = {}) {
  const { deskTop, deskInset, charX } = CELL;
  const deskW = cellW - deskInset * 2;
  const P = (gx, gy) => [ox + gx * px, oy + gy * px];
  let svg = "";
  if (d.kind === "empty") {
    const rows = deskRows(deskW).map((r) => r.replaceAll("n", "."));
    return gridToSvg(layers("desk.empty", rows).layers.base, ...P(deskInset, deskTop), px);
  }
  const view = d.kind === "type" ? "side" : "front";
  if (d.kind !== "laidoff") {
    const [ax, ay] = view === "front" ? RIG.attach.chairFront : RIG.attach.chairSide;
    svg += gridToSvg(bake(view === "front" ? "prop.chair.front" : "prop.chair.side"), ...P(charX + ax, deskTop - 20 + ay), px);
    const { grid, top } = bakeCharacter(view === "front" ? "emp.sit.front" : "emp.type.0", {
      shirt: d.shirt ?? C.body[0],
      hair: d.hair ?? SPRITE.hair[0],
      style: d.style ?? "short",
      view,
    });
    svg += gridToSvg(grid, ...P(charX, deskTop - 20 + top), px);
    if (d.sweat) {
      const [wx, wy] = RIG.attach.sweat[view === "front" ? "emp.sit.front" : "emp.type"];
      svg += gridToSvg(bake("fx.sweat"), ...P(charX + wx, deskTop - 20 + wy), px);
    }
  }
  svg += gridToSvg(deskGrid(deskW), ...P(deskInset, deskTop), px);
  if (d.kind === "laidoff") {
    svg += gridToSvg(bake("prop.box"), ...P(deskInset + Math.floor(deskW / 2) - 4, deskTop - 6), px);
    svg += `<rect x="${ox}" y="${oy}" width="${cellW * px}" height="${CELL.h * px}" fill="${floorTint}" opacity="0.6"/>`;
    return svg;
  }
  svg += gridToSvg(bake(d.kind === "type" ? "prop.monitor.on" : "prop.monitor.off"), ...P(deskInset + deskW - 8, deskTop - 10), px);
  if (d.paper) svg += gridToSvg(bake("prop.paper"), ...P(deskInset + deskW - 15, deskTop - 5), px);
  if (d.you) {
    const [x1, y1] = P(1, 1);
    svg += `<rect x="${x1}" y="${y1}" width="${(cellW - 2) * px}" height="${(CELL.h - 2) * px}" fill="none" stroke="${C.accent}" stroke-width="${2 * px}"/>`;
  }
  return svg;
}
