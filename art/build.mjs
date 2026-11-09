// Builds the sprite atlas for the client, and the review images. Run with `npm run art`.
//
// TODO(art): the sprites are placeholder art; see art/README.md.
//
// Outputs (in this folder):
//   characters.png   the atlas: every frame and layer, 1 sprite pixel = 1 px, RGBA
//   characters.json  Pixi spritesheet data (frames, animations) + meta.rig
//   preview.png      every frame enlarged, grouped, for review
//   building.png     whole buildings composed from the tiles (scene.mjs), one per state
//   anim.html        every animation playing, tinted, with hair (open in a browser;
//                    add ?t=<ms> to freeze the clock)

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMES, RIG, bake, bakeCharacter, HAIR_STYLES } from "./sprites.mjs";
import { buildingSvg, sampleModel, workingModel } from "./scene.mjs";
import { C, SPRITE } from "./palette.mjs";
import { encodePng, gridToSvg, hexToRgb, hexAlpha, svgsToPngs } from "./lib.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const PAD = 2; // transparent gutter between frames, so linear filtering never bleeds

// ---------------------------------------------------------------------------
// Validate the rig: every frame it names must exist.

function validate() {
  const missing = [];
  const need = (name, where) => FRAMES[name] || missing.push(`${name} (${where})`);
  for (const [anim, a] of Object.entries(RIG.animations)) a.frames.forEach((f) => need(f, `animation ${anim}`));
  for (const f of Object.keys(RIG.frames)) need(f, "RIG.frames");
  for (const style of HAIR_STYLES.filter((s) => s !== "none")) for (const v of ["front", "side"]) need(`hair.${style}.${v}`, "hair");
  const walk = (o, path) => {
    if (typeof o === "string" && path.endsWith(".tile") && !o.includes("<")) need(o, path);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(RIG.building, "building");
  for (const s of Object.values(RIG.building.states)) {
    need(s.sign, "states.sign");
    for (const i of [0, 1, 2]) need(`${s.doors}.${i}`, "states.doors");
  }
  for (const t of Object.keys(RIG.building.rooms)) for (const p of ["back", "front", "empty"]) need(`room.${t}.${p}`, "rooms");
  for (const [k, info] of Object.entries(RIG.frames)) {
    const f = FRAMES[k];
    if (info.hand && (info.hand[0] >= f.w || info.hand[1] >= f.h)) missing.push(`${k}: hand point outside the frame`);
  }
  if (missing.length) throw new Error(`Rig references missing frames:\n  ${missing.join("\n  ")}`);
}
validate();

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

const ATLAS_W = 512;
let x = PAD, y = PAD, rowH = 0;
for (const t of textures.sort((a, b) => b.h - a.h || b.w - a.w || a.name.localeCompare(b.name))) {
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
      rgba.set([r, g, b, hexAlpha(col)], ((t.y + ry) * ATLAS_W + (t.x + rx)) * 4);
    }),
  );
}
const atlasPng = encodePng(ATLAS_W, ATLAS_H, rgba);
writeFileSync(join(OUT, "characters.png"), atlasPng);

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
// Preview sheet: every frame, grouped, bottom-aligned in wrapping rows.

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const label = (lx, ly, text, size = 13, fill = C.muted, weight = 400) =>
  `<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(text)}</text>`;

const SHEET_W = 1600;
let sheet = "";
let py = 44;

/** Lays out items ({ grid, name }) in rows that wrap at the sheet width. */
function section(title, items, px, gap = 18) {
  sheet += label(40, py, title, 16, C.ink, 600);
  py += 14;
  let cx = 40;
  let row = [];
  const flush = () => {
    if (!row.length) return;
    const maxH = Math.max(...row.map((r) => r.grid.length * px));
    for (const r of row) {
      sheet += gridToSvg(r.grid, r.x, py + (maxH - r.grid.length * px), px);
      sheet += label(r.x, py + maxH + 14, r.name, 11);
    }
    py += maxH + 30;
    row = [];
    cx = 40;
  };
  for (const it of items) {
    const w = Math.max(it.grid[0].length * px, it.name.length * 6);
    if (cx + w > SHEET_W - 40) flush();
    row.push({ ...it, x: cx });
    cx += w + gap;
  }
  flush();
  py += 12;
}

const names = Object.keys(FRAMES);
const by = (re) => names.filter((n) => re.test(n));
const short = (n, re) => n.replace(re, "");
const charItems = (list, i0 = 0) =>
  list.map((n, i) => {
    const { grid } = bakeCharacter(n, { shirt: C.body[(i0 + i) % 8], hair: SPRITE.hair[(i0 + i) % 6], style: HAIR_STYLES[(i0 + i) % 4] });
    return { grid, name: short(n, /^emp\./) };
  });

sheet += label(40, py - 14, "REORG sprites and building tiles: placeholder art (TODO: replace with final art)", 20, C.ink, 600);
py += 12;
section("Employees, seated (front and profile)", charItems(by(/^emp\.(sit|cheer|slump|stretch|type)/)), 5);
section("Employees, standing and moving", charItems(by(/^emp\.(stand|walk|carry|climb|drink|chat|bench|visitor)/), 3), 5);
section("The boss (front faces from the pass rate, §17.1; profile for walking, pointing, sipping)", by(/^boss\./).map((n) => ({ grid: bake(n), name: short(n, /^boss\./) })), 5);
section(
  "Hair: style and color from the wallet hash",
  HAIR_STYLES.flatMap((style, si) =>
    ["emp.sit.front", "emp.type.0"].map((base) => ({
      grid: bakeCharacter(base, { shirt: C.body[(si * 2 + 1) % 8], hair: SPRITE.hair[si % 6], style }).grid,
      name: `${style} ${RIG.frames[base].view}`,
    })),
  ),
  5,
);
section("Props and effects", by(/^(prop|fx)\./).map((n) => ({ grid: bake(n), name: short(n, /^(prop|fx)\./) })), 4, 14);
section("Shell per building state (§12.2): wall, window, slab, parapet; signs; roof", [
  ...["garage", "office", "tower"].flatMap((s) => ["wall", "window", "slab", "parapet"].map((p) => ({ grid: bake(`shell.${s}.${p}`), name: `${s} ${p}` }))),
  ...by(/^(sign|roof)\./).map((n) => ({ grid: bake(n), name: n })),
], 3, 14);
section("Street fronts for the lobby, per state", by(/^shell\..*\.front$/).map((n) => ({ grid: bake(n), name: n })), 2);
section("Core: stairs, shaft, tube, elevator cab and doors, floor indicator", by(/^core\./).map((n) => ({ grid: bake(n), name: short(n, /^core\./) })), 3, 14);
section("Back wall", by(/^wall\./).map((n) => ({ grid: bake(n), name: short(n, /^wall\./) })), 3, 12);
section("Rooms per tier: back, front, empty", by(/^room\./).map((n) => ({ grid: bake(n), name: short(n, /^room\./) })), 2, 14);
section("Amenity bay, lobby, street", by(/^(bay|furn|lobby|street)/).map((n) => ({ grid: bake(n), name: n })), 2, 14);
section("Basement and penthouse", by(/^(vault|server|pent)\./).map((n) => ({ grid: bake(n), name: n })), 2, 14);
section("Backdrop", [{ grid: bake("sky.skyline"), name: "sky.skyline (tiles horizontally)" }], 2);

const H = py;
const sheetSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${H}" viewBox="0 0 ${SHEET_W} ${H}" shape-rendering="crispEdges"><rect width="${SHEET_W}" height="${H}" fill="${C.bg}"/>${sheet}</svg>\n`;

// ---------------------------------------------------------------------------
// Building preview: the Small office at 2x, the garage and the tower at 1x.

const big = buildingSvg(sampleModel("office"), { px: 2 });
const garage = buildingSvg(sampleModel("garage"), { px: 1, plaques: false });
const tower = buildingSvg({ ...workingModel("tower"), doors: 2 }, { px: 1, plaques: false });
const BW = 40 + big.w + 24 + garage.w + 40;
const BH = Math.max(big.h, garage.h + tower.h + 40) + 70;
let bsvg = `<rect width="${BW}" height="${BH}" fill="${C.bg}"/>`;
bsvg += label(40, 34, "Small office (11 to 50 employees), payday: the reference composition (art/scene.mjs) at 2x", 15, C.ink, 600);
bsvg += `<g transform="translate(40 50)">${big.svg}</g>`;
const rx = 40 + big.w + 24;
bsvg += label(rx, 34, "Garage startup (1 to 10), 1x", 13, C.ink, 600);
bsvg += `<g transform="translate(${rx} 50)">${garage.svg}</g>`;
bsvg += label(rx, 50 + garage.h + 26, "Office tower (51 to 250), a task opens, 1x", 13, C.ink, 600);
bsvg += `<g transform="translate(${rx} ${50 + garage.h + 40})">${tower.svg}</g>`;
const buildingSheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${BH}" viewBox="0 0 ${BW} ${BH}" shape-rendering="crispEdges">${bsvg}</svg>\n`;

const ok = svgsToPngs([
  { svg: sheetSvg, out: join(OUT, "preview.png"), w: SHEET_W, h: H, transparent: false },
  { svg: buildingSheet, out: join(OUT, "building.png"), w: BW, h: BH, transparent: false },
]);

// ---------------------------------------------------------------------------
// Animation viewer: a self-contained page (atlas and rig inlined).

const viewerData = {
  frames: Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, v.frame])),
  rig: { animations: RIG.animations, frames: RIG.frames, hair: RIG.hair },
};
const viewer = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>REORG animations (placeholder art)</title>
<style>
  body { margin: 0; background: ${C.bg}; color: ${C.ink}; font: 13px ${FONT}; }
  h1 { font-size: 18px; margin: 20px 24px 4px; } p { margin: 0 24px 16px; color: ${C.muted}; }
  #grid { display: flex; flex-wrap: wrap; gap: 12px; padding: 0 24px 24px; align-items: flex-end; }
  figure { margin: 0; background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 8px; padding: 8px; }
  figcaption { color: ${C.muted}; font-size: 11px; margin-top: 4px; }
  canvas { image-rendering: pixelated; display: block; }
</style></head><body>
<h1>REORG animations</h1>
<p>Placeholder art from <code>art/sprites.mjs</code> and <code>art/building.mjs</code>, played from the atlas with the rig: shirt and hair tints, hair offsets per frame, fps from <code>meta.rig.animations</code>. One-shot animations replay after a pause. Add <code>?t=1234</code> to freeze the clock.</p>
<div id="grid"></div>
<script>
const DATA = ${JSON.stringify(viewerData)};
const BODY = ${JSON.stringify(C.body)}, HAIR = ${JSON.stringify(SPRITE.hair)}, STYLES = ["short", "long", "bun", "curly"];
const img = new Image();
img.src = "data:image/png;base64,${atlasPng.toString("base64")}";
const SCALE = 4;
const cache = new Map();
function layer(name, tint) {
  const key = name + (tint || "");
  if (cache.has(key)) return cache.get(key);
  const f = DATA.frames[name];
  const c = document.createElement("canvas");
  c.width = f.w; c.height = f.h;
  const x = c.getContext("2d");
  x.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  if (tint) {
    x.globalCompositeOperation = "multiply"; x.fillStyle = tint; x.fillRect(0, 0, f.w, f.h);
    x.globalCompositeOperation = "destination-in"; x.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  }
  cache.set(key, c);
  return c;
}
function drawChar(ctx, name, dx, dy, i) {
  ctx.drawImage(layer(name), dx, dy);
  ctx.drawImage(layer(name + "#shirt", BODY[i % 8]), dx, dy);
  const info = DATA.rig.frames[name];
  if (!info) return;
  const style = STYLES[i % 4];
  ctx.drawImage(layer("hair." + style + "." + info.view, HAIR[i % 6]), dx + (info.headX || 0), dy + DATA.rig.hair[style][info.view].y + info.headY);
}
const freeze = new URLSearchParams(location.search).get("t");
img.onload = () => {
  const cells = [];
  Object.entries(DATA.rig.animations).forEach(([name, a], i) => {
    const fs = a.frames.map((f) => DATA.frames[f]);
    const w = Math.max(...fs.map((f) => f.w)), h = Math.max(...fs.map((f) => f.h));
    const fig = document.createElement("figure");
    const cv = document.createElement("canvas");
    cv.width = (w + 4) * SCALE; cv.height = (h + 7) * SCALE;
    fig.append(cv);
    const cap = document.createElement("figcaption");
    cap.textContent = name + " · " + a.frames.length + " frames · " + a.fps + " fps" + (a.loop === false ? " · once" : "");
    fig.append(cap);
    document.getElementById("grid").append(fig);
    cells.push({ a, w, h, cv, i });
  });
  function tick(now) {
    const t = freeze != null ? +freeze : now;
    for (const c of cells) {
      const ctx = c.cv.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.cv.width, c.cv.height);
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      const n = c.a.frames.length;
      let k = Math.floor((t / 1000) * c.a.fps);
      if (c.a.loop === false) { k = k % (n + 4); if (k >= n) k = n - 1; }
      const name = c.a.frames[k % n];
      const f = DATA.frames[name];
      ctx.fillStyle = "${C.line}"; ctx.fillRect(0, c.h + 4, c.w + 4, 1);
      const dx = 2 + Math.floor((c.w - f.w) / 2), dy = 4 + c.h - f.h;
      if (DATA.frames[name + "#shirt"]) drawChar(ctx, name, dx, dy, c.i);
      else ctx.drawImage(layer(name), dx, dy);
    }
    if (freeze == null) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
};
</script></body></html>
`;
writeFileSync(join(OUT, "anim.html"), viewer);

console.log(
  `Atlas ${ATLAS_W}x${ATLAS_H}, ${textures.length} textures, ${Object.keys(FRAMES).length} frames, ${Object.keys(RIG.animations).length} animations.` +
    (ok ? " Previews written to art/preview.png and art/building.png." : " No Chrome found (set CHROME=...), previews skipped."),
);
