/**
 * The camera (roadmap W-03, design §10, §17.3): whole-number zoom that fits the 380 px building
 * width (at least 2× on a laptop), vertical pan, fit-width below 1× on phones, tap-to-zoom so
 * rooms reach 44 px, and the viewport range for culling. Pure math, no Pixi: unit-tested.
 * World units are sprite px; (x, y) is the world point at the screen's top-left corner.
 */
import { G } from "./geometry";

/** Phones: the first tap on a floor zooms until the narrowest room is at least this wide (px). */
export const MIN_ROOM_PX = 44;
const NARROWEST_ROOM = 24;
const SIDE_PAD = 8;
const MAX_ZOOM = 6;

export interface Insets {
  /** Screen px covered by the top bar. */
  top: number;
  /** Screen px covered by the dock or the bottom sheet. */
  bottom: number;
  /** Screen px covered on the right by the docked desk (wide layouts). */
  right?: number;
}

export class Camera {
  viewW = 1;
  viewH = 1;
  worldH = 1;
  insets: Insets = { top: 48, bottom: 0 };
  zoom = 1;
  x = 0;
  y = 0;
  /** A zoom chosen by the user (tap-to-zoom, Ctrl+scroll); null = the fit zoom. */
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

  /** True when the building is drawn below 1× (phones), where tap-to-zoom applies. */
  get fitsBelowOne(): boolean {
    return this.fitZoom() < 1;
  }

  /** True when the narrowest rooms are under 44 px on screen (design §10: tap-to-zoom applies). */
  get roomsTooSmall(): boolean {
    return this.zoom * NARROWEST_ROOM < MIN_ROOM_PX;
  }

  get zoomedIn(): boolean {
    return this.manual !== null && this.manual > this.fitZoom();
  }

  /** The zoom at which the narrowest room is ≥ 44 px (whole number). */
  readableZoom(): number {
    return Math.ceil(MIN_ROOM_PX / NARROWEST_ROOM);
  }

  resize(viewW: number, viewH: number, worldH: number, insets?: Insets): void {
    const keepCenter = this.toWorld(this.viewW / 2, this.focusScreenY());
    this.viewW = Math.max(1, viewW);
    this.viewH = Math.max(1, viewH);
    this.worldH = Math.max(1, worldH);
    if (insets) this.insets = insets;
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
    const save = { x: this.x, y: this.y };
    this.lookAt(this.x + this.viewW / 2 / this.zoom, wy);
    const y = this.y;
    this.x = save.x;
    this.y = save.y;
    return y;
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
    const nz = Math.max(Math.min(fit, 1), Math.min(MAX_ZOOM, z));
    this.manual = nz === fit ? null : nz;
    this.zoom = nz;
    this.x = w.x - sx / nz;
    this.y = w.y - sy / nz;
    this.clamp();
  }

  resetZoom(): void {
    const c = this.toWorld(this.viewW / 2, this.focusScreenY());
    this.manual = null;
    this.zoom = this.fitZoom();
    this.lookAt(c.x, c.y);
  }

  clamp(): void {
    const z = this.zoom;
    const visW = this.viewW / z;
    const freeW = (this.viewW - (this.insets.right ?? 0)) / z;
    // Center the building in the area the dock leaves free when it fits there, else in the view.
    if (G.width + (SIDE_PAD * 2) / z <= freeW) this.x = -(freeW - G.width) / 2;
    else if (G.width + (SIDE_PAD * 2) / z <= visW) this.x = -(visW - G.width) / 2;
    else this.x = Math.min(G.width + SIDE_PAD / z - visW, Math.max(-SIDE_PAD / z, this.x));
    const top = -this.insets.top / z - 24 / z;
    const bottom = this.worldH + this.insets.bottom / z - this.viewH / z + 8 / z;
    if (bottom <= top) {
      const freeH = (this.viewH - this.insets.top - this.insets.bottom) / z;
      this.y = -this.insets.top / z - (freeH - this.worldH) / 2;
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
