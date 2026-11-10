// Generates the REORG brand kit: SVG sources, PNG exports (via headless Chrome)
// and the NEP-141 token icon data URI. Run with `npm run brand`.
//
// TODO(art): placeholder brand art. The wordmark, icon and social images will be
// replaced by the final art; see brand/README.md. The wordmark is the lobby.logo
// sprite and the characters come from art/sprites.mjs, so new art flows into the
// logo, icon and social images.
//
// Colors are the Blueprint tokens (docs/design/REORG Design Spec.md §6), from art/palette.mjs.
// All art is drawn from code (spec §13.1 rule 5): no fonts in the logo, no generated images.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "../art/palette.mjs";
import { bake } from "../art/sprites.mjs";
import { buildingSvg, sampleModel } from "../art/scene.mjs";
import { gridToSvg, gridToPaths, svgsToPngs } from "../art/lib.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ---------------------------------------------------------------------------
// Wordmark: the game's own logo. It is the `lobby.logo` sprite (art/building.mjs),
// the same pixel REORG that signs the lobby wall and sits in the client's top bar
// (design spec §3, §6: accent color, 1 px shade). Drawn in sprite pixels and scaled
// up, so the brand can never drift from the UI again: change the sprite, run `npm run brand`.

const LOGO_SCALE = 8;

/** { svg, w, h } for the wordmark: the lobby.logo sprite at LOGO_SCALE (472 x 120). */
function wordmarkGroup() {
  const logo = bake("lobby.logo");
  const w = logo[0].length * LOGO_SCALE;
  const h = logo.length * LOGO_SCALE;
  return { svg: `<g transform="scale(${LOGO_SCALE})" shape-rendering="crispEdges">${gridToPaths(logo)}</g>`, w, h };
}

function svgDoc(w, h, body, { title, viewBox, crisp } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox ?? `0 0 ${w} ${h}`}"` +
    `${crisp ? ' shape-rendering="crispEdges"' : ""}>${title ? `<title>${title}</title>` : ""}${body}</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// Icon: the boss, smug, from the chest up, on navy. Drawn in sprite pixels
// (viewBox units), so it stays crisp at any size and the SVG stays small.

const ICON_GRID = 24; // icon canvas in sprite pixels
function iconBody({ rounded }) {
  const boss = bake("boss.smug");
  const bx = (ICON_GRID - boss[0].length) / 2; // 18 wide -> 3
  const by = 3;
  const bg = rounded
    ? `<rect width="${ICON_GRID}" height="${ICON_GRID}" rx="5" fill="${C.bg}"/>`
    : `<rect width="${ICON_GRID}" height="${ICON_GRID}" fill="${C.bg}"/>`;
  // Rows past the canvas bottom are clipped by the viewBox: a portrait crop.
  return bg + gridToPaths(boss.slice(0, ICON_GRID - by), bx, by);
}

function iconSvg({ size = 512, rounded = true } = {}) {
  return svgDoc(size, size, iconBody({ rounded }), { title: "REORG", viewBox: `0 0 ${ICON_GRID} ${ICON_GRID}`, crisp: true });
}

// Square, no title: the NEP-141 `icon` field is stored on chain, so keep it small.
function tokenIconSvg() {
  return svgDoc(64, 64, iconBody({ rounded: false }), { viewBox: `0 0 ${ICON_GRID} ${ICON_GRID}`, crisp: true }).trimEnd();
}

// ---------------------------------------------------------------------------
// Social images show the building from the game (art/scene.mjs): the payday
// sample moment, illustrative, not live state.

function ogCard() {
  const W = 1200, H = 630;
  let out = `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  const wm = wordmarkGroup();
  const s = 1.0;
  out += `<g transform="translate(70 150) scale(${s})">${wm.svg}</g>`;
  const ty = 150 + wm.h * s + 70;
  out += `<text x="70" y="${ty}" font-family="${FONT}" font-size="34" font-weight="700" fill="${C.ink}" letter-spacing="-0.4">Hold the token. Get hired.</text>`;
  out += `<text x="70" y="${ty + 46}" font-family="${FONT}" font-size="34" font-weight="700" fill="${C.ink}" letter-spacing="-0.4">Survive the reorg.</text>`;
  out += `<text x="70" y="${ty + 108}" font-family="${FONT}" font-size="22" fill="${C.muted}">A memecoin where the token is a job. One task a day.</text>`;
  out += `<text x="70" y="${ty + 140}" font-family="${FONT}" font-size="22" fill="${C.muted}">Pass and get paid. Miss three and you are laid off.</text>`;
  const b = buildingSvg(sampleModel("office"), { px: 1, margin: 14, plaques: false });
  out += `<g transform="translate(${W - 44 - b.w} ${(H - b.h) / 2})">${b.svg}</g>`;
  return svgDoc(W, H, out, { crisp: false });
}

function xBanner() {
  const W = 1500, H = 500;
  let out = `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  // The four tier floors of the building at 2x, cropped from the full scene.
  const px = 2, margin = 0;
  const b = buildingSvg(sampleModel("office"), { px, margin });
  const top = b.bands["directors:0"] * px, bottom = b.bands.lobby * px;
  const cw = b.w, ch = bottom - top;
  out += `<svg x="${W - cw - 40}" y="${(H - ch) / 2}" width="${cw}" height="${ch}" viewBox="0 ${top} ${cw} ${ch}">${b.svg}</svg>`;
  const wm = wordmarkGroup();
  const sc = 0.72;
  out += `<g transform="translate(70 110) scale(${sc})">${wm.svg}</g>`;
  out += `<text x="70" y="${110 + wm.h * sc + 56}" font-family="${FONT}" font-size="30" font-weight="700" fill="${C.ink}">Hold the token. Get hired.</text>`;
  out += `<text x="70" y="${110 + wm.h * sc + 96}" font-family="${FONT}" font-size="30" font-weight="700" fill="${C.ink}">Survive the reorg.</text>`;
  return svgDoc(W, H, out, { crisp: true });
}

// README header lockup: wordmark and tagline on a navy plate (reads on GitHub light and dark).
function lockupSvg() {
  const wm = wordmarkGroup();
  const padX = 56, padTop = 44, padBottom = 40;
  const W = wm.w + padX * 2;
  const Hh = padTop + wm.h + 56 + padBottom;
  let out = `<rect width="${W}" height="${Hh}" rx="10" fill="${C.bg}"/>`;
  out += `<g transform="translate(${padX} ${padTop})">${wm.svg}</g>`;
  out += `<text x="${padX}" y="${padTop + wm.h + 44}" font-family="${FONT}" font-size="22" font-weight="600" fill="${C.ink}">Hold the token. Get hired. Survive the reorg.</text>`;
  return svgDoc(W, Hh, out, { title: "REORG: Hold the token. Get hired. Survive the reorg." });
}

function wordmarkSvg() {
  const g = wordmarkGroup();
  return svgDoc(g.w, g.h, g.svg, { title: "REORG" });
}

// ---------------------------------------------------------------------------
// Write SVGs, then rasterize.

function write(rel, content) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

const svgs = {
  "logo/reorg-wordmark.svg": wordmarkSvg(),
  "logo/reorg-lockup.svg": lockupSvg(),
  "icon/reorg-icon.svg": iconSvg(),
  "icon/reorg-icon-square.svg": iconSvg({ rounded: false }),
  "social/og-card.svg": ogCard(),
  "social/x-banner.svg": xBanner(),
};
for (const [rel, svg] of Object.entries(svgs)) write(rel, svg);

const tokenSvg = tokenIconSvg();
const dataUri = `data:image/svg+xml;base64,${Buffer.from(tokenSvg).toString("base64")}`;
write("icon/token-icon.svg", tokenSvg + "\n");
write("icon/token-icon.datauri.txt", dataUri + "\n");

// Web app manifest: served from the client's publicDir (brand/icon) next to the favicons.
write(
  "icon/site.webmanifest",
  JSON.stringify(
    {
      name: "REORG: Hold the token. Get hired. Survive the reorg.",
      short_name: "REORG",
      description: "A memecoin where the token is a job. Hold $REORG, get hired, survive the reorg.",
      start_url: "/",
      display: "standalone",
      background_color: "#0a1626",
      theme_color: "#0a1626",
      icons: [
        { src: "/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" },
        { src: "/reorg-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/reorg-icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    },
    null,
    2,
  ) + "\n",
);

const rasters = [
  // [source svg, output png, width, height, transparent]
  ["icon/reorg-icon.svg", "icon/favicon-32.png", 32, 32, true],
  ["icon/reorg-icon.svg", "icon/apple-touch-icon-180.png", 180, 180, true],
  ["icon/reorg-icon.svg", "icon/reorg-icon-512.png", 512, 512, true],
  ["icon/reorg-icon-square.svg", "social/x-avatar-400.png", 400, 400, false],
  ["logo/reorg-lockup.svg", "logo/reorg-lockup.png", null, null, true],
  ["social/og-card.svg", "social/og-card.png", 1200, 630, false],
  ["social/x-banner.svg", "social/x-banner.png", 1500, 500, false],
];

const jobs = rasters.map(([src, dst, w0, h0, transparent]) => {
  const svg = readFileSync(join(OUT, src), "utf8");
  const m = svg.match(/width="([\d.]+)" height="([\d.]+)"/);
  return { svg, out: join(OUT, dst), w: w0 ?? Math.ceil(+m[1]), h: h0 ?? Math.ceil(+m[2]), transparent };
});

if (!svgsToPngs(jobs)) {
  console.log("SVGs written. No Chrome found (set CHROME=/path/to/chrome) so PNGs were not rendered.");
} else {
  console.log(`Brand kit written to ${OUT} (token icon data URI: ${dataUri.length} bytes).`);
}
