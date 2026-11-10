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
/** Follow me eases toward the character with this time constant (ms); reduced motion jumps. */
const FOLLOW_TAU = 140;
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class RgStage {
  readonly app = new Application();
  readonly world = new Container();
  readonly camera = new Camera();
  building!: RgBuilding;
  private el!: HTMLElement;
  private pan: { from: { x: number; y: number }; to: { x: number; y: number }; t0: number; dur: number } | null = null;
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private suppressTapUntil = 0;
  private lastTap = { x: 0, y: 0 };
  private lastPointer = "mouse";
  /** Touch points on the canvas, for pinch zoom (design §10, P1). */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; z0: number; mid: { x: number; y: number } } | null = null;
  /** A pinch happened since the last finger went down alone: no finger of it may tap. */
  private pinched = false;
  /** Follow me (P1): the camera keeps this character centered until the user pans. */
  private follow: WalletId | null = null;
  private lastFrame = performance.now();
  /** Called when Follow me turns off by itself (the user panned, the character left). */
  onFollowEnd: (() => void) | null = null;
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
    const before = [this.building.worldHeight, this.camera.headroom, ...this.camera.span];
    this.building.update(m);
    this.hasModel = true;
    this.camera.headroom = this.building.headroom;
    this.camera.span = this.building.span;
    const after = [this.building.worldHeight, this.camera.headroom, ...this.camera.span];
    if (!first && after.some((v, i) => v !== before[i])) {
      // The skyline gained or lost towers: show every building again, unless the user is busy up close.
      const skyline = after[2] !== before[2] || after[3] !== before[3];
      if (skyline && this.camera.hasAnnexes && !this.camera.zoomedIn && !this.follow && !this.pan) {
        this.camera.resize(this.el.clientWidth, this.el.clientHeight, this.building.worldHeight || 600);
        return this.overview();
      }
    }
    if (first || after.some((v, i) => v !== before[i])) this.layout(first);
  }

  /** Pans so the wallet's character sits in the middle of the free area (Go to my desk). */
  focus(wallet: WalletId, animate = true): boolean {
    const a = this.building.anchorOf(wallet);
    if (!a) return false;
    // From the skyline overview, come back to the building first: a desk is too small to find out there.
    if (this.camera.zoomedOut) this.camera.resetZoom();
    // Sideways too: the view may be over an annex tower.
    const to = this.camera.targetFor(a.x, a.y);
    if (!animate || this.reducedMotion) {
      this.camera.x = to.x;
      this.camera.y = to.y;
      this.pan = null;
    } else this.pan = { from: { x: this.camera.x, y: this.camera.y }, to, t0: performance.now(), dur: PAN_MS };
    return true;
  }

  /**
   * Follow me (design §10, P1): keeps the character centered while it walks, rides and climbs. A
   * manual pan turns it off; zooming keeps it. Returns false if the character is not drawn.
   */
  setFollow(wallet: WalletId | null): boolean {
    if (wallet && !this.building.anchorOf(wallet)) return false;
    this.follow = wallet;
    this.pan = null;
    return true;
  }

  get following(): WalletId | null {
    return this.follow;
  }

  private stopFollow(): void {
    if (!this.follow) return;
    this.follow = null;
    this.onFollowEnd?.();
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

  /** One zoom step in or out (the ladder: overview, ½×, the phone fit, 1×…6×), around the view's center. */
  zoomBy(step: number): void {
    this.camera.zoomAt(this.camera.stepZoom(step), this.camera.viewW / 2, this.camera.focusScreenY());
    this.apply();
  }

  /** The skyline overview: the headquarters and every annex tower in view at once. */
  overview(): void {
    this.pan = null;
    this.stopFollow();
    this.camera.overview();
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
    if (initial && this.camera.hasAnnexes) {
      // On load with annex towers: the whole skyline, every building in view.
      this.camera.overview();
    } else if (initial) {
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
    const t = performance.now();
    const dt = Math.min(100, t - this.lastFrame);
    this.lastFrame = t;
    if (this.follow && !this.drag?.moved && !this.pinch) {
      const a = this.building.anchorOf(this.follow);
      if (!a) this.stopFollow();
      else {
        const to = this.camera.targetFor(a.x, a.y);
        const k = this.reducedMotion || this.pan ? 1 : 1 - Math.exp(-dt / FOLLOW_TAU);
        this.camera.x += (to.x - this.camera.x) * k;
        this.camera.y += (to.y - this.camera.y) * k;
        this.camera.clamp();
        this.pan = null;
      }
    }
    if (this.pan) {
      const p = Math.min(1, (performance.now() - this.pan.t0) / this.pan.dur);
      const e = easeInOut(p);
      this.camera.x = this.pan.from.x + (this.pan.to.x - this.pan.from.x) * e;
      this.camera.y = this.pan.from.y + (this.pan.to.y - this.pan.from.y) * e;
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
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, this.local(e));
        if (this.touches.size === 2) return this.startPinch();
        if (this.touches.size > 2) return;
      }
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      this.pan = null;
    });
    window.addEventListener("pointermove", (e) => {
      if (this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, this.local(e));
        if (this.pinch) return this.movePinch();
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 6) return;
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      this.stopFollow();
      this.camera.panBy(-dx, -dy);
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (this.touches.delete(e.pointerId) && this.pinched) {
        // The pinch is over: no finger of it pans or taps, however late it lifts.
        this.pinch = null;
        this.drag = null;
        this.suppressTapUntil = performance.now() + 250;
        if (this.touches.size === 0) this.pinched = false;
        return;
      }
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
          this.camera.zoomAt(this.camera.stepZoom(e.deltaY < 0 ? 1 : -1), p.x, p.y);
        } else {
          this.stopFollow();
          const k = e.deltaMode === 1 ? 16 : 1;
          this.camera.panBy(e.shiftKey ? e.deltaY * k : e.deltaX * k, e.shiftKey ? 0 : e.deltaY * k);
        }
        this.apply();
      },
      { passive: false },
    );
  }

  /** Two fingers down: a pinch replaces any drag (design §10, P1). */
  private startPinch(): void {
    const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    this.drag = null;
    this.pan = null;
    this.pinched = true;
    this.pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.camera.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private movePinch(): void {
    const p = this.pinch!;
    const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // The midpoint drags the view along, unless the camera is following someone.
    if (!this.follow) this.camera.panBy(p.mid.x - mid.x, p.mid.y - mid.y);
    p.mid = mid;
    const z = this.camera.pinchZoom(p.z0, Math.hypot(a.x - b.x, a.y - b.y) / p.d0);
    if (z !== this.camera.zoom) this.camera.zoomAt(z, mid.x, mid.y);
    this.apply();
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}
