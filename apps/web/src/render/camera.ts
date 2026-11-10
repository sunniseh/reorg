/**
 * The camera (roadmap W-03, design §10, §17.3): whole-number zoom that fits the 380 px building
 * width (at least 2× on a laptop), vertical pan, fit-width below 1× on phones, tap-to-zoom so
 * rooms reach 44 px, pinch zoom and Follow me (P1), the skyline overview (zoomed out until the
 * headquarters and its annex towers fit; where the client opens when there are annexes, and every
 * zoom can pan across them), and the viewport range for culling. Pure math, no Pixi: unit-tested.
 * World units are sprite px; (x, y) is the world point at the screen's top-left corner.
 */
import { G } from "./geometry";

/** Phones: the first tap on a floor zooms until the narrowest room is at least this wide (px). */
export const MIN_ROOM_PX = 44;
const NARROWEST_ROOM = 24;
const SIDE_PAD = 8;
const MAX_ZOOM = 6;
/** The overview never draws the world smaller than this. */
const MIN_ZOOM = 0.2;
/** World px of sky kept around the skyline in the overview. */
const OVERVIEW_PAD = 24;
const EPS = 1e-6;

export interface Insets {
  /** Screen px covered by the top bar. */
  top: number;
  /** Screen px covered by the dock or the bottom sheet. */
  bottom: number;
  /** Screen px covered on the right by the docked desk (wide layouts). */
  right?: number;
  /** Screen px covered on the left by the staff list (wide layouts). */
  left?: number;
}

export class Camera {
  viewW = 1;
  viewH = 1;
  worldH = 1;
  insets: Insets = { top: 48, bottom: 0 };
  zoom = 1;
  x = 0;
  y = 0;
  /** World px above the roof band that may be shown (the Skyscraper's antenna, W-15). */
  headroom = 0;
  /** World x range of the headquarters and its annex towers; zoomed out past the fit zoom, the camera frames it. */
  span: [number, number] = [0, G.width];
  /** A zoom chosen by the user (tap-to-zoom, Ctrl+scroll, Overview); null = the fit zoom. */
  manual: number | null = null;

  /** The default zoom for this viewport (design §10). */
  fitZoom(): number {
    const avail = this.viewW - SIDE_PAD * 2;
    const zW = Math.floor(avail / G.width);
    if (zW < 1) return avail / G.width; // phones: fit the width (linear filtering)
    const freeH = this.viewH - this.insets.top - this.insets.bottom;
    const zH = Math.floor(freeH / this.worldH);
    return Math.min(zW, MAX_ZOOM, Math.max(Math.min(2, zW), zH));
  }

  /** The zoom at which the whole skyline (headquarters, annexes, antenna) fits the free area. */
  overviewZoom(): number {
    const freeW = this.viewW - (this.insets.left ?? 0) - (this.insets.right ?? 0);
    const freeH = this.viewH - this.insets.top - this.insets.bottom;
    const w = this.span[1] - this.span[0] + OVERVIEW_PAD * 2;
    const h = this.worldH + this.headroom + OVERVIEW_PAD * 2;
    return Math.max(MIN_ZOOM, Math.min(freeW / w, freeH / h));
  }

  /**
   * The smallest zoom the user can reach: the overview, or 1× (the fit on phones) when that shows
   * nearly everything already.
   */
  minZoom(): number {
    const base = Math.min(this.fitZoom(), 1);
    const ov = this.overviewZoom();
    return ov < base * 0.85 ? ov : base;
  }

  /** True when the building is drawn below 1× (phones), where tap-to-zoom applies. */
  get fitsBelowOne(): boolean {
    return this.fitZoom() < 1;
  }

  /** True when the narrowest rooms are under 44 px on screen (design §10: tap-to-zoom applies). */
  get roomsTooSmall(): boolean {
    return this.zoom * NARROWEST_ROOM < MIN_ROOM_PX;
  }

  get zoomedIn(): boolean {
    return this.manual !== null && this.manual > this.fitZoom() + EPS;
  }

  /** True when zoomed out past the fit zoom (toward the skyline overview). */
  get zoomedOut(): boolean {
    return this.manual !== null && this.manual < this.fitZoom() - EPS;
  }

  /** True when the skyline has more than the headquarters (annex towers beside it). */
  get hasAnnexes(): boolean {
    return this.span[0] < -EPS || this.span[1] > G.width + EPS;
  }

  /** True when there is more to see than the fit zoom shows (an Overview control is useful). */
  get canZoomOut(): boolean {
    return this.minZoom() < this.fitZoom() - EPS;
  }

  /** The zoom at which the narrowest room is ≥ 44 px (whole number). */
  readableZoom(): number {
    return Math.ceil(MIN_ROOM_PX / NARROWEST_ROOM);
  }

  /**
   * The zoom steps for buttons and Ctrl+scroll: the overview, ½× when the overview is far below it,
   * the fit zoom on phones, then whole numbers up to 6×.
   */
  zoomLevels(): number[] {
    const min = this.minZoom();
    const fit = this.fitZoom();
    const out = [min];
    if (min < 0.45) out.push(0.5);
    if (fit < 1) out.push(fit);
    for (let z = 1; z <= MAX_ZOOM; z++) out.push(z);
    return [...new Set(out.filter((z) => z >= min - EPS))].sort((a, b) => a - b);
  }

  /** The next zoom step in `dir` (+1 in, −1 out) from the current zoom; the current zoom at either end. */
  stepZoom(dir: number): number {
    const levels = this.zoomLevels();
    const z = this.zoom;
    if (dir > 0) return levels.find((l) => l > z + EPS) ?? z;
    return [...levels].reverse().find((l) => l < z - EPS) ?? z;
  }

  resize(viewW: number, viewH: number, worldH: number, insets?: Insets): void {
    const keepCenter = this.toWorld(this.viewW / 2, this.focusScreenY());
    this.viewW = Math.max(1, viewW);
    this.viewH = Math.max(1, viewH);
    this.worldH = Math.max(1, worldH);
    if (insets) this.insets = insets;
    // A manual zoom that is no longer reachable (the skyline shrank, the view grew) snaps back in range.
    if (this.manual !== null) this.manual = Math.max(this.minZoom(), Math.min(MAX_ZOOM, this.manual));
    if (this.manual !== null && Math.abs(this.manual - this.fitZoom()) < EPS) this.manual = null;
    this.zoom = this.manual ?? this.fitZoom();
    this.lookAt(keepCenter.x, keepCenter.y);
  }

  /** The screen y where a focused point should land: the middle of the area the HUD leaves free. */
  focusScreenY(): number {
    return this.insets.top + (this.viewH - this.insets.top - this.insets.bottom) / 2;
  }

  /** Centers world point (wx, wy) in the free area, then clamps. */
  lookAt(wx: number, wy: number): void {
    this.x = wx - this.viewW / 2 / this.zoom;
    this.y = wy - this.focusScreenY() / this.zoom;
    this.clamp();
  }

  /** Target y (world) that would center `wy`, after clamping, without moving. */
  targetYFor(wy: number): number {
    return this.targetFor(this.x + this.viewW / 2 / this.zoom, wy).y;
  }

  /** Camera position that would center world point (wx, wy), after clamping, without moving. */
  targetFor(wx: number, wy: number): { x: number; y: number } {
    const save = { x: this.x, y: this.y };
    this.lookAt(wx, wy);
    const out = { x: this.x, y: this.y };
    this.x = save.x;
    this.y = save.y;
    return out;
  }

  /**
   * Pinch zoom (design §10, P1): the zoom for a pinch that started at `z0` and has spread by
   * `ratio`. Whole numbers from 1× up; below 1× the nearest zoom step (the fit on phones, ½×, the
   * overview), never in between.
   */
  pinchZoom(z0: number, ratio: number): number {
    const z = z0 * ratio;
    if (z < 1) {
      const below = this.zoomLevels().filter((l) => l <= 1 + EPS);
      return below.reduce((best, l) => (Math.abs(Math.log(z / l)) < Math.abs(Math.log(z / best)) ? l : best), below[0]!);
    }
    return Math.max(1, Math.min(MAX_ZOOM, Math.round(z)));
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.x += dxScreen / this.zoom;
    this.y += dyScreen / this.zoom;
    this.clamp();
  }

  /** Zooms to `z`, keeping the world point under (sx, sy) fixed on screen. */
  zoomAt(z: number, sx: number, sy: number): void {
    const w = this.toWorld(sx, sy);
    const fit = this.fitZoom();
    const nz = Math.max(this.minZoom(), Math.min(MAX_ZOOM, z));
    this.manual = Math.abs(nz - fit) < EPS ? null : nz;
    this.zoom = nz;
    this.x = w.x - sx / nz;
    this.y = w.y - sy / nz;
    this.clamp();
  }

  /** The skyline overview: zoomed out until the headquarters and its annexes fit, centered. */
  overview(): void {
    const z = this.minZoom();
    const fit = this.fitZoom();
    this.manual = Math.abs(z - fit) < EPS ? null : z;
    this.zoom = z;
    this.lookAt((this.span[0] + this.span[1]) / 2, this.worldH / 2);
  }

  /** Back to the fit zoom around the view's center; from the overview, back to the headquarters. */
  resetZoom(): void {
    const c = this.toWorld(this.viewW / 2, this.focusScreenY());
    if (this.zoomedOut) c.x = G.width / 2;
    this.manual = null;
    this.zoom = this.fitZoom();
    this.lookAt(c.x, c.y);
  }

  clamp(): void {
    const z = this.zoom;
    const visW = this.viewW / z;
    const left = this.insets.left ?? 0;
    const freeW = (this.viewW - left - (this.insets.right ?? 0)) / z;
    // Every zoom can reach the whole skyline: the headquarters and each annex tower beside it.
    const [l0, r0] = this.span;
    const w = r0 - l0;
    // Center it in the area the dock and the list leave free when it fits there, else in the view.
    if (w + (SIDE_PAD * 2) / z <= freeW) this.x = l0 - left / z - (freeW - w) / 2;
    else if (w + (SIDE_PAD * 2) / z <= visW) this.x = l0 - (visW - w) / 2;
    else this.x = Math.min(r0 + SIDE_PAD / z - visW, Math.max(l0 - SIDE_PAD / z, this.x));
    const top = -this.insets.top / z - 24 / z - this.headroom;
    const bottom = this.worldH + this.insets.bottom / z - this.viewH / z + 8 / z;
    if (bottom <= top) {
      const freeH = (this.viewH - this.insets.top - this.insets.bottom) / z;
      this.y = -this.insets.top / z - (freeH - this.worldH - this.headroom) / 2 - this.headroom;
    } else this.y = Math.min(bottom, Math.max(top, this.y));
  }

  /** The world y range on screen (for culling). */
  visibleY(): [number, number] {
    return [this.y, this.y + this.viewH / this.zoom];
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.x + sx / this.zoom, y: this.y + sy / this.zoom };
  }
}
