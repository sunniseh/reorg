/**
 * Atlas sprites in the DOM HUD: the character's badge photo on cards, the dock and the staff list,
 * and small icons (coin, pass and miss dots, the company sign). The same frames, tints and rig as
 * the Pixi characters (render/agent.ts), painted once per look into a cached data URL and shown as
 * a pixelated <img>, so a list of two thousand people costs at most a few hundred paintings.
 * Purely cosmetic: the look comes from the wallet hash (design §5.1) and implies no state.
 */
import { appearanceOf, type Appearance, type WalletId } from "@reorg/core";
import atlasJson from "../../../../art/characters.json";
import atlasPng from "../../../../art/characters.png";
import { RIG } from "../render/geometry";
import { HEX } from "../theme/tokens";
import { h } from "./dom";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const FRAMES = (atlasJson as unknown as { frames: Record<string, { frame: Rect }> }).frames;

/** Floor backdrops of the badge photo, by tier (0 = Directors); visitors stand in the lobby. */
const BACKDROP = [HEX.floor.directors, HEX.floor.managers, HEX.floor.associates, HEX.floor.interns];

let sheet: HTMLImageElement | null = null;
let loading: Promise<HTMLImageElement> | null = null;
const urls = new Map<string, string>();

function loadSheet(): Promise<HTMLImageElement> {
  loading ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      sheet = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error("atlas image failed to load"));
    img.src = atlasPng;
  });
  return loading;
}

function canvas(w: number, hgt: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Draws a frame at (x, y); a tint multiplies it like a Pixi tint and keeps its alpha. */
function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement, name: string, x: number, y: number, tint?: string): void {
  const f = FRAMES[name]?.frame;
  if (!f) return;
  if (!tint) {
    ctx.drawImage(img, f.x, f.y, f.w, f.h, x, y, f.w, f.h);
    return;
  }
  const [t, tc] = canvas(f.w, f.h);
  tc.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  tc.globalCompositeOperation = "multiply";
  tc.fillStyle = tint;
  tc.fillRect(0, 0, f.w, f.h);
  tc.globalCompositeOperation = "destination-in";
  tc.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  ctx.drawImage(t, x, y);
}

/** An <img> whose source is painted once per key: now if the sheet is loaded, else on load. */
function painted(key: string, w: number, hgt: number, scale: number, attrs: Record<string, string>, paint: (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => void): HTMLImageElement {
  const el = h("img", { width: w * scale, height: hgt * scale, draggable: "false", ...attrs });
  const fill = (img: HTMLImageElement) => {
    let url = urls.get(key);
    if (!url) {
      const [c, ctx] = canvas(w, hgt);
      paint(ctx, img);
      url = c.toDataURL();
      urls.set(key, url);
    }
    el.src = url;
  };
  if (sheet) fill(sheet);
  else void loadSheet().then(fill, () => undefined);
  return el;
}

export type PortraitKind = "employee" | "visitor";

/** Badge photo size in sprite pixels: head and shoulders of the 12 px standing frame, room for a bun. */
const PW = 14;
const PH = 16;
/** The photo is a close-up: drawn half again as large as the caller's scale (whole pixels only). */
const PHOTO_ZOOM = 1.5;

/**
 * The wallet's character on its floor's color: the badge photo. `tier` picks the backdrop (null:
 * the lobby). Visitors get the outline the street queue shows (design §5.2).
 */
export function portrait(wallet: WalletId, opts: { tier: number | null; kind?: PortraitKind; scale?: number; label?: string }): HTMLImageElement {
  const kind = opts.kind ?? "employee";
  const look: Appearance = appearanceOf(wallet);
  const bg = opts.tier === null ? HEX.floor.lobby : (BACKDROP[opts.tier] ?? HEX.floor.lobby);
  const key = kind === "visitor" ? `p|visitor|${bg}` : `p|${bg}|${look.body}|${look.hairStyle}|${look.hairColor}`;
  const attrs: Record<string, string> = { class: "px portrait", alt: opts.label ?? "" };
  if (!opts.label) attrs["aria-hidden"] = "true";
  return painted(key, PW, PH, Math.floor((opts.scale ?? 2) * PHOTO_ZOOM), attrs, (ctx, img) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, PW, PH);
    const frame = kind === "visitor" ? "emp.visitor" : "emp.stand.front";
    const f = FRAMES[frame]!.frame;
    const x = Math.floor((PW - f.w) / 2);
    const y = 2;
    draw(ctx, img, frame, x, y);
    if (kind === "visitor") return;
    draw(ctx, img, `${frame}#shirt`, x, y, HEX.body[look.body]);
    const info = RIG.frames[frame];
    if (look.hairStyle !== "none" && info) {
      const hy = RIG.hair[look.hairStyle]!.front.y + info.headY;
      draw(ctx, img, `hair.${look.hairStyle}.front`, x + (info.headX ?? 0), y + hy, HEX.hair[look.hairColor]);
    }
  });
}

/** A single atlas frame as a pixel-crisp icon (decorative unless labeled). */
export function icon(name: string, opts: { scale?: number; label?: string; class?: string } = {}): HTMLImageElement {
  const f = FRAMES[name]?.frame ?? { x: 0, y: 0, w: 1, h: 1 };
  const attrs: Record<string, string> = { class: `px icon ${opts.class ?? ""}`.trim(), alt: opts.label ?? "" };
  if (!opts.label) attrs["aria-hidden"] = "true";
  return painted(`i|${name}`, f.w, f.h, opts.scale ?? 2, attrs, (ctx, img) => draw(ctx, img, name, 0, 0));
}

/** Starts loading the sheet early so the first portraits paint without a flash. */
export function preloadSprites(): void {
  void loadSheet().catch(() => undefined);
}
