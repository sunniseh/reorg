// Small helpers shared by art/build.mjs and brand/build.mjs: a dependency-free
// PNG encoder, pixel-grid to SVG, color math, and SVG to PNG through headless Chrome.

import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Alpha 0-255 of "#rrggbb" (opaque) or "#rrggbbaa". */
export const hexAlpha = (hex) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255);

export function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Multiply tint, as Pixi does: a grayscale layer pixel times the tint color. */
export function multiply(hex, tint) {
  const a = hexToRgb(hex), b = hexToRgb(tint);
  return rgbToHex(a.map((v, i) => Math.round((v * b[i]) / 255)));
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encodes RGBA pixels (Uint8Array, w*h*4) as a PNG buffer. */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Pixel grids as SVG ----------------------------------------------------

/**
 * A pixel grid is an array of rows; each cell is a hex color or null.
 * Returns <rect>s with horizontal runs merged, at offset (x, y) and pixel size px.
 */
export function gridToSvg(grid, x = 0, y = 0, px = 1, { mirror = false } = {}) {
  const out = [];
  const w = grid[0]?.length ?? 0;
  grid.forEach((row, ry) => {
    const r = mirror ? [...row].reverse() : row;
    let i = 0;
    while (i < w) {
      const col = r[i];
      if (!col) { i++; continue; }
      let j = i + 1;
      while (j < w && r[j] === col) j++;
      const fill = col.length === 9 ? `${col.slice(0, 7)}" fill-opacity="${(hexAlpha(col) / 255).toFixed(3)}` : col;
      out.push(`<rect x="${x + i * px}" y="${y + ry * px}" width="${(j - i) * px}" height="${px}" fill="${fill}"/>`);
      i = j;
    }
  });
  return out.join("");
}

/** Same picture as gridToSvg, as one <path> per color: much smaller for on-chain icons. */
export function gridToPaths(grid, x = 0, y = 0) {
  const byColor = new Map();
  grid.forEach((row, ry) => {
    let i = 0;
    while (i < row.length) {
      const col = row[i];
      if (!col) { i++; continue; }
      let j = i + 1;
      while (j < row.length && row[j] === col) j++;
      if (col.length === 9) throw new Error("gridToPaths: translucent pixels are not supported");
      byColor.set(col, (byColor.get(col) ?? "") + `M${x + i} ${y + ry}h${j - i}v1h-${j - i}z`);
      i = j;
    }
  });
  return [...byColor].map(([col, d]) => `<path fill="${col}" d="${d}"/>`).join("");
}

// --- SVG to PNG ------------------------------------------------------------

export function findChrome() {
  return [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
    .filter(Boolean)
    .find((c) => existsSync(c));
}

/** Renders each { svg, out, w, h, transparent } job to a PNG. Returns false if Chrome is missing. */
export function svgsToPngs(jobs) {
  const chrome = findChrome();
  if (!chrome) return false;
  const tmp = mkdtempSync(join(tmpdir(), "reorg-art-"));
  try {
    for (const { svg, out, w, h, transparent } of jobs) {
      const html = join(tmp, "page.html");
      writeFileSync(
        html,
        `<!doctype html><html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${w}" height="${h}" style="display:block;image-rendering:pixelated"></body></html>`,
      );
      execFileSync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
          `--window-size=${w},${h}`,
          ...(transparent ? ["--default-background-color=00000000"] : []),
          `--screenshot=${out}`,
          `file://${html}`,
        ],
        { stdio: "ignore" },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return true;
}
