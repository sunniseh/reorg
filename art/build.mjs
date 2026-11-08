// Builds the character atlas for the tower client, and a preview sheet.
// Run with `npm run art`.
//
// TODO(art): the sprites are placeholder art; see art/README.md.
//
// Outputs (in this folder):
//   characters.png    the atlas: every frame and layer, 1 sprite pixel = 1 px
//   characters.json   Pixi spritesheet data (frames, animations) + meta.rig
//   preview.png       every frame enlarged, and a sample floor, for review

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMES, RIG, bake, bakeCharacter, deskCellSvg, HAIR_STYLES } from "./sprites.mjs";
import { C, SPRITE } from "./palette.mjs";
import { encodePng, gridToSvg, hexToRgb, svgsToPngs } from "./lib.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const PAD = 2; // transparent gutter between frames, so linear filtering never bleeds

// ---------------------------------------------------------------------------
// Atlas: one texture per frame layer, shelf-packed.

const textures = [];
for (const [name, f] of Object.entries(FRAMES)) {
  for (const [layer, grid] of Object.entries(f.layers)) {
    // The main layer keeps the frame name; tint layers drawn over a base get a suffix.
    const isMain = layer === "base" || !f.layers.base;
    textures.push({ name: isMain ? name : `${name}#${layer}`, grid, w: f.w, h: f.h });
  }
}

const ATLAS_W = 256;
let x = PAD, y = PAD, rowH = 0;
for (const t of textures.sort((a, b) => b.h - a.h || a.name.localeCompare(b.name))) {
  if (x + t.w + PAD > ATLAS_W) {
    x = PAD;
    y += rowH + PAD;
    rowH = 0;
  }
  t.x = x;
  t.y = y;
  x += t.w + PAD;
  rowH = Math.max(rowH, t.h);
}
const ATLAS_H = y + rowH + PAD;

const rgba = new Uint8Array(ATLAS_W * ATLAS_H * 4);
for (const t of textures) {
  t.grid.forEach((row, ry) =>
    row.forEach((col, rx) => {
      if (!col) return;
      const [r, g, b] = hexToRgb(col);
      rgba.set([r, g, b, 255], ((t.y + ry) * ATLAS_W + (t.x + rx)) * 4);
    }),
  );
}
writeFileSync(join(OUT, "characters.png"), encodePng(ATLAS_W, ATLAS_H, rgba));

const frames = {};
for (const t of [...textures].sort((a, b) => a.name.localeCompare(b.name))) {
  frames[t.name] = {
    frame: { x: t.x, y: t.y, w: t.w, h: t.h },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: t.w, h: t.h },
    sourceSize: { w: t.w, h: t.h },
  };
}
const json = {
  frames,
  animations: Object.fromEntries(Object.entries(RIG.animations).map(([k, v]) => [k, v.frames])),
  meta: {
    app: "reorg art/build.mjs",
    image: "characters.png",
    format: "RGBA8888",
    size: { w: ATLAS_W, h: ATLAS_H },
    scale: "1",
    layers: "name = base layer; name#shirt and name#hair are grayscale tint layers drawn on top, same size and anchor",
    rig: RIG,
  },
};
writeFileSync(join(OUT, "characters.json"), JSON.stringify(json, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Preview sheet

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const label = (lx, ly, text, size = 13, fill = C.muted) =>
  `<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="${size}" fill="${fill}">${esc(text)}</text>`;

function cellsRow(items, x0, y0, px, gap, title) {
  let out = label(x0, y0, title, 15, C.ink);
  let cx = x0, maxH = 0;
  for (const { grid, name } of items) maxH = Math.max(maxH, grid.length * px);
  for (const { grid, name } of items) {
    const h = grid.length * px;
    out += gridToSvg(grid, cx, y0 + 16 + (maxH - h), px); // bottom-aligned
    out += label(cx, y0 + 16 + maxH + 16, name, 11);
    cx += Math.max(grid[0].length * px, name.length * 6) + gap;
  }
  return { svg: out, h: maxH + 52 };
}

const PX = 6;
const W = 1400;
let svg = "";
let py = 40;
svg += label(40, py, "REORG characters: placeholder art (TODO: replace with final art)", 20, C.ink);
py += 30;

const empPoses = [
  ["emp.sit.front", "front", 0],
  ["emp.type.0", "side", 3],
  ["emp.type.1", "side", 3],
  ["emp.walk.0", "side", 5],
  ["emp.walk.1", "side", 5],
  ["emp.walk.2", "side", 5],
  ["emp.walk.3", "side", 5],
  ["emp.carry.0", "side", 6],
  ["emp.carry.1", "side", 6],
];
let r = cellsRow(
  empPoses.map(([n, view, i]) => ({ ...bakeCharacter(n, { shirt: C.body[i], view }), name: n.replace("emp.", "") })),
  40, py, PX, 24, "Employee poses (shirt tinted by wallet hash)",
);
svg += r.svg;
py += r.h + 20;

r = cellsRow(
  [
    { grid: bake("boss.smug"), name: "boss smug (90%+)" },
    { grid: bake("boss.smile"), name: "boss smile (50-89%)" },
    { grid: bake("boss.twitchy"), name: "boss twitchy (<50%)" },
    { grid: bake("emp.visitor"), name: "visitor" },
  ],
  40, py, PX, 50, "Boss faces and lobby visitor",
);
svg += r.svg;
py += r.h + 20;

const hairItems = [];
HAIR_STYLES.forEach((style, si) => {
  for (const view of ["front", "side"]) {
    const base = view === "front" ? "emp.sit.front" : "emp.type.0";
    hairItems.push({
      ...bakeCharacter(base, { shirt: C.body[(si * 2 + 1) % 8], hair: SPRITE.hair[si % SPRITE.hair.length], style, view }),
      name: `${style} ${view}`,
    });
  }
});
r = cellsRow(hairItems, 40, py, PX, 18, "Hair styles (P1; color and style from wallet hash)");
svg += r.svg;
py += r.h + 20;

r = cellsRow(
  [
    "prop.chair.front", "prop.chair.side", "prop.monitor.off", "prop.monitor.on", "prop.monitor.flash",
    "prop.paper", "prop.box", "fx.sweat", "prop.coin.0", "prop.coin.1", "prop.coin.2", "prop.coin.3", "prop.desk",
  ].map((n) => ({ grid: bake(n), name: n.replace(/^(prop|fx)\./, "") })),
  40, py, PX, 14, "Props and effects",
);
svg += r.svg;
py += r.h + 30;

// A sample floor at 3x, the way the tower draws it.
const FS = 3;
const cellW = 44, cellH = 40;
const floorY = py + 20;
svg += label(40, py + 6, "In context: one Associates floor at 3x (desk cell 44 x 40 px)", 15, C.ink);
const desks = [
  { kind: "sit", i: 0, style: "short", label: "active" },
  { kind: "type", i: 1, style: "long", label: "working" },
  { kind: "type", i: 2, style: "curly", sweat: true, label: "struggling" },
  { kind: "laidoff", label: "laid off" },
  { kind: "sit", i: 4, style: "bun", you: true, label: "you" },
  { kind: "type", i: 5, style: "none", paper: true, label: "submitted" },
  { kind: "empty", label: "empty" },
  { kind: "sit", i: 7, style: "short", hair: 2, label: "new hire" },
];
const floorX = 40;
svg += `<rect x="${floorX}" y="${floorY}" width="${desks.length * cellW * FS}" height="${cellH * FS}" fill="${C.floor.associates}"/>`;
desks.forEach((d, n) => {
  const ox = floorX + n * cellW * FS;
  const cell = { ...d, shirt: C.body[d.i ?? 0], hair: SPRITE.hair[d.hair ?? (d.i ?? 0) % 6] };
  svg += deskCellSvg(cell, ox, floorY, FS, cellW);
  if (d.label === "new hire") {
    const x1 = ox + 2 * FS, y1 = floorY + 2 * FS;
    svg += `<rect x="${x1}" y="${y1}" width="${16 * FS}" height="${7 * FS}" rx="${FS}" fill="${C.ink}"/>`;
    svg += `<text x="${x1 + 8 * FS}" y="${y1 + 5.4 * FS}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${5.5 * FS}" fill="${C.bg}">NEW</text>`;
  }
  svg += label(ox + 6, floorY + cellH * FS + 18, d.label, 11);
});
py = floorY + cellH * FS + 60;

svg += label(40, py, "Penthouse at 3x", 15, C.ink);
const phY = py + 14;
svg += `<rect x="40" y="${phY}" width="${3 * 200}" height="${3 * 44}" fill="${C.floor.penthouse}"/>`;
["boss.smug", "boss.smile", "boss.twitchy"].forEach((b, i) => {
  svg += gridToSvg(bake(b), 40 + (20 + i * 60) * 3, phY + (44 - 28 - 2) * 3, 3);
});
py = phY + 44 * 3 + 30;

const H = py;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" fill="${C.bg}"/>${svg}</svg>\n`;
const ok = svgsToPngs([{ svg: sheet, out: join(OUT, "preview.png"), w: W, h: H, transparent: false }]);

console.log(
  `Atlas ${ATLAS_W}x${ATLAS_H}, ${textures.length} textures, ${Object.keys(FRAMES).length} frames.` +
    (ok ? " Preview written to art/preview.png." : " No Chrome found (set CHROME=...), preview skipped."),
);
