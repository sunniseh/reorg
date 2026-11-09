/**
 * The stage: one full-width PixiJS canvas under the DOM HUD (design §3, D19). Owns the Pixi
 * application, the camera input (drag/scroll pan, Ctrl+scroll zoom, tap-to-zoom on phones), the
 * frame loop and viewport culling. Everything it draws comes from the model it is given.
 */
import type { WalletId } from "@reorg/core";
import { Application, Container } from "pixi.js";
import { TOKENS } from "../theme/tokens";
import type { Atlas } from "./atlas";
import { RgBuilding, type BuildingHandlers, type SceneModel } from "./building";
import { Camera, type Insets } from "./camera";

const PAN_MS = 300;
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class RgStage {
  readonly app = new Application();
  readonly world = new Container();
  readonly camera = new Camera();
  building!: RgBuilding;
  private el!: HTMLElement;
  private pan: { from: number; to: number; t0: number; dur: number } | null = null;
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private suppressTapUntil = 0;
  private lastTap = { x: 0, y: 0 };
  private lastPointer = "mouse";
  private frameFns = new Set<() => void>();
  private clock: () => number = () => Date.now();
  private hasModel = false;
  reducedMotion = false;

  async init(el: HTMLElement, atlas: Atlas, handlers: BuildingHandlers, clock: () => number): Promise<void> {
    this.el = el;
    this.clock = clock;
    await this.app.init({
      resizeTo: el,
      background: TOKENS.sky,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      roundPixels: true,
      preference: "webgl",
    });
    el.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = "none";
    this.building = new RgBuilding(atlas, {
      select: (w) => this.onSelect(w, handlers),
      hover: handlers.hover,
      vault: () => !this.tapSuppressed() && handlers.vault(),
      caughtUp: (n) => handlers.caughtUp?.(n),
    });
    this.world.addChild(this.building);
    // Taps on empty space land on a catcher behind the world. The stage itself stays passive:
    // a static root would make Pixi hit-test every sprite as interactive and hide the desks.
    const backdrop = new Container();
    backdrop.eventMode = "static";
    backdrop.hitArea = this.app.screen;
    backdrop.on("pointertap", () => this.onSelect(null, handlers));
    this.app.stage.addChild(backdrop, this.world);
    this.bindInput();
    this.app.renderer.on("resize", () => this.layout());
    this.app.ticker.add(() => this.frame());
  }

  setInsets(insets: Insets): void {
    this.camera.insets = insets;
    this.layout();
  }

  update(m: SceneModel): void {
    const first = !this.hasModel;
    const before = this.building.worldHeight;
    this.building.update(m);
    this.hasModel = true;
    if (first || before !== this.building.worldHeight) this.layout(first);
  }

  /** Pans so the wallet's character sits in the middle of the free area (Go to my desk). */
  focus(wallet: WalletId, animate = true): boolean {
    const a = this.building.anchorOf(wallet);
    if (!a) return false;
    const to = this.camera.targetYFor(a.y);
    if (!animate || this.reducedMotion) {
      this.camera.y = to;
      this.pan = null;
    } else this.pan = { from: this.camera.y, to, t0: performance.now(), dur: PAN_MS };
    return true;
  }

  /** Screen position (CSS px, relative to the stage element) of a character's head. */
  screenOf(wallet: WalletId): { x: number; y: number } | null {
    const a = this.building.anchorOf(wallet);
    return a ? this.camera.toScreen(a.x, a.y) : null;
  }

  onFrame(fn: () => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }

  zoomBy(step: number): void {
    const z = Math.round(this.camera.zoom) + step;
    this.camera.zoomAt(z, this.camera.viewW / 2, this.camera.focusScreenY());
    this.apply();
  }

  resetZoom(): void {
    this.camera.resetZoom();
    this.apply();
  }

  skipAnimations(): void {
    this.building.skip();
  }

  private layout(initial = false): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.camera.resize(w, h, this.building.worldHeight || 600);
    if (initial) {
      // On load: the whole building if it fits, otherwise the top floors (design §10).
      this.camera.y = -Infinity;
      this.camera.clamp();
    }
    this.apply();
  }

  private apply(): void {
    const c = this.camera;
    this.world.scale.set(c.zoom);
    this.world.position.set(Math.round(-c.x * c.zoom), Math.round(-c.y * c.zoom));
    this.building.setZoom(c.zoom);
    const [y0, y1] = c.visibleY();
    this.building.cull(y0, y1);
  }

  private frame(): void {
    if (this.pan) {
      const p = Math.min(1, (performance.now() - this.pan.t0) / this.pan.dur);
      this.camera.y = this.pan.from + (this.pan.to - this.pan.from) * easeInOut(p);
      this.camera.clamp();
      if (p >= 1) this.pan = null;
    }
    this.apply();
    this.building.tick(this.clock());
    for (const fn of this.frameFns) fn();
  }

  private tapSuppressed(): boolean {
    return performance.now() < this.suppressTapUntil;
  }

  private onSelect(w: WalletId | null, handlers: BuildingHandlers): void {
    if (this.tapSuppressed() || this.drag?.moved) return;
    // Touch: the first tap on the building zooms in until rooms are ≥ 44 px (design §10).
    if (this.lastPointer === "touch" && this.camera.roomsTooSmall && !this.camera.zoomedIn) {
      this.camera.zoomAt(this.camera.readableZoom(), this.lastTap.x, this.lastTap.y);
      this.apply();
      return;
    }
    handlers.select(w);
  }

  private bindInput(): void {
    const cv = this.app.canvas;
    cv.addEventListener("pointerdown", (e) => {
      this.lastTap = this.local(e);
      this.lastPointer = e.pointerType;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      this.pan = null;
    });
    window.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 6) return;
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      this.camera.panBy(-dx, -dy);
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (this.drag?.id !== e.pointerId) return;
      if (this.drag.moved) this.suppressTapUntil = performance.now() + 120;
      this.drag = null;
    };
    // Capture phase: Pixi turns window pointerup into pointertap in its own capture listener,
    // so the drag must be marked before that or a pan would end in a tap.
    window.addEventListener("pointerup", end, { capture: true });
    window.addEventListener("pointercancel", end, { capture: true });
    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.pan = null;
        if (e.ctrlKey || e.metaKey) {
          const p = this.local(e);
          const step = e.deltaY < 0 ? 1 : -1;
          const z = this.camera.zoom < 1 && step > 0 ? this.camera.readableZoom() : Math.round(this.camera.zoom) + step;
          this.camera.zoomAt(z, p.x, p.y);
        } else {
          const k = e.deltaMode === 1 ? 16 : 1;
          this.camera.panBy(e.shiftKey ? e.deltaY * k : e.deltaX * k, e.shiftKey ? 0 : e.deltaY * k);
        }
        this.apply();
      },
      { passive: false },
    );
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}
