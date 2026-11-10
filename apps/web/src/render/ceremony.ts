/**
 * Ceremonies (roadmap W-15, design §9 "Crane", §12.3, §14.2 "Ceremony"): the 4 s construction
 * sequence when the company grows into a new building state (scaffolding up the walls, a crane
 * lowering the new sign onto the roof, the ribbon at the front doors cut), the For lease banners
 * when it shrinks, and the crane bringing a beam when a tier gets a new floor.
 *
 * Orientation only: each one plays after the model already changed, never delays the HUD, and a
 * tap skips it (the tweens jump to their end). The caller skips them under reduced motion
 * (design §14.5: a still frame with the boss's caption).
 */
import { Container, Sprite, Texture, TilingSprite } from "pixi.js";
import { TOKENS } from "../theme/tokens";
import type { Atlas } from "./atlas";
import { G, RIG, type Band, type BandStack } from "./geometry";

const C = RIG.building.construction;
/** design §14.2: a ceremony takes at most 4,000 ms. */
export const CEREMONY_MS = 4000;
const MAST_H = 50;
/** The jib's mast head is at this x of its tile (art/building.mjs craneJib). */
const JIB_HEAD = 31;

export interface CeremonyHost {
  readonly atlas: Atlas;
  /** The building's effects layer (world coordinates). */
  readonly fx: Container;
  addTween(dur: number, step: (p: number) => void, done?: () => void, delay?: number): void;
  /** The roof sign of the current state, in the roof band's coordinates (the crane lowers it). */
  readonly roofSign: Sprite | null;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class Ceremonies {
  constructor(private readonly host: CeremonyHost) {}

  /** A tween that stops touching its ceremony once the ceremony is destroyed (a tap skips all). */
  private tween(root: Container, dur: number, step: (p: number) => void, done?: () => void, delay = 0): void {
    this.host.addTween(dur, (p) => !root.destroyed && step(p), done && (() => !root.destroyed && done()), delay);
  }

  private begin(): Container {
    const root = new Container();
    root.eventMode = "none";
    this.host.fx.addChild(root);
    return root;
  }

  private sprite(parent: Container, name: string, x: number, y: number): Sprite {
    const s = new Sprite(this.host.atlas.tex(name));
    s.position.set(x, y);
    parent.addChild(s);
    return s;
  }

  private tile(parent: Container, name: string, x: number, y: number, w: number, h: number): TilingSprite {
    const t = new TilingSprite({ texture: this.host.atlas.tex(name), width: w, height: h });
    t.position.set(x, y);
    parent.addChild(t);
    return t;
  }

  /** A tower crane on the roof; `left` points the long arm over the roof instead of past the right wall. */
  private crane(parent: Container, roof: Band, left: boolean): { hookX: number; jibBottom: number; tip: number } {
    const parapet = roof.y + roof.h - 6;
    const mx = C.crane.x;
    this.tile(parent, C.crane.mast, mx, parapet - MAST_H, 10, MAST_H);
    const jib = this.sprite(parent, C.crane.jib, 0, parapet - MAST_H - 12);
    const w = jib.texture.frame.width;
    if (left) {
      jib.scale.x = -1;
      jib.x = mx + 5 + JIB_HEAD;
      return { hookX: 0, jibBottom: jib.y + 13, tip: jib.x - w + 4 };
    }
    jib.x = mx + 5 - JIB_HEAD;
    return { hookX: jib.x + C.crane.hookX, jibBottom: jib.y + 13, tip: jib.x + w - 4 };
  }

  /** A cable from the jib to a hook; only its length changes per frame. */
  private cable(parent: Container): Sprite {
    const s = new Sprite(Texture.WHITE);
    s.tint = TOKENS.deskEdge;
    s.width = 1;
    parent.addChild(s);
    return s;
  }

  private fadeOut(c: Container, at: number, dur: number, done?: () => void): void {
    this.tween(c, dur, (p) => (c.alpha = 1 - p), done, at);
  }

  /**
   * Growth into a new building state (design §12.3): scaffolding, the crane lowers the new sign,
   * then the ribbon is cut. 4 s; the shell has already crossfaded underneath.
   */
  grow(stack: BandStack): void {
    const roof = stack.byKey.get("roof")!;
    const street = stack.byKey.get("street")!;
    const lobby = stack.byKey.get("lobby")!;
    const root = this.begin();
    const kit = new Container();
    root.addChild(kit);
    const top = roof.y + roof.h - 10;
    for (const x of [-16, G.width]) this.tile(kit, "build.scaffold", x, top, 16, street.y - top);
    const crane = this.crane(kit, roof, true);
    const sign = this.host.roofSign;
    const cable = this.cable(kit);
    const hook = this.sprite(kit, C.crane.hook, 0, 0);
    kit.alpha = 0;
    this.tween(root, 300, (p) => (kit.alpha = p));
    if (sign) {
      // The sign is in the roof band's coordinates; the cable and the hook are in world coordinates.
      const home = sign.y;
      const cx = Math.max(crane.tip + 4, Math.round(sign.x + sign.width / 2));
      const start = crane.jibBottom + 12 - roof.y;
      const place = (local: number) => {
        if (sign.destroyed) return;
        sign.y = Math.round(local);
        const wy = sign.y + roof.y;
        hook.position.set(cx - 3, wy - 9);
        cable.position.set(cx, crane.jibBottom);
        cable.height = Math.max(1, wy - 9 - crane.jibBottom);
      };
      place(start);
      this.tween(root, 2200, (p) => place(start + (home - start) * ease(p)), () => place(home), 300);
      // The hook lets go and rides back up.
      const hookAt = home + roof.y - 9;
      this.tween(
        root,
        400,
        (p) => {
          hook.y = Math.round(hookAt - (hookAt - crane.jibBottom - 2) * p);
          cable.height = Math.max(1, hook.y - crane.jibBottom);
        },
        undefined,
        2600,
      );
    } else {
      hook.visible = false;
      cable.visible = false;
    }
    this.fadeOut(kit, 3000, 500);
    // The ribbon across the front doors: cut at 3.0 s, the halves fall away.
    const R = C.ribbon;
    const ry = lobby.y + R.y;
    const whole = this.sprite(root, R.tile, R.x, ry);
    this.tween(
      root,
      1,
      () => undefined,
      () => {
        whole.visible = false;
        const halves = [this.sprite(root, R.half, R.x, ry), this.sprite(root, R.half, R.x + 22, ry)];
        this.tween(root, 700, (p) => {
          halves[0]!.position.set(R.x - 8 * p, ry + 10 * p * p);
          halves[1]!.position.set(R.x + 22 + 8 * p, ry + 10 * p * p);
          for (const h of halves) h.alpha = 1 - p;
        });
      },
      3000,
    );
    this.host.addTween(1, () => undefined, () => root.destroy({ children: true }), CEREMONY_MS);
  }

  /** Shrinking into a smaller state: For lease banners outside the upper floors for 4 s. */
  shrink(stack: BandStack): void {
    const root = this.begin();
    const floors = stack.bands.filter((b) => b.kind === "floor").slice(0, 3);
    floors.forEach((b, i) => {
      const s = this.sprite(root, C.forLease.tile, i % 2 ? -30 : G.width + 2, b.y + 10);
      s.alpha = 0;
      this.tween(root, 200, (p) => (s.alpha = p), undefined, i * 150);
    });
    this.fadeOut(root, CEREMONY_MS - 400, 400, () => root.destroy({ children: true }));
  }

  /**
   * A tier filled and got a new floor (design §9 "Crane"): the crane lowers a beam past the right
   * wall to the new floor, which fades in as the beam arrives. About 2.5 s.
   */
  newFloor(stack: BandStack, band: Band, reveal: (alpha: number) => void): void {
    const roof = stack.byKey.get("roof")!;
    const root = this.begin();
    const crane = this.crane(root, roof, false);
    const cable = this.cable(root);
    const hook = this.sprite(root, C.crane.hook, crane.hookX - 3, 0);
    const beam = this.sprite(root, "build.beam", crane.hookX - 22, 0);
    const from = crane.jibBottom + 12;
    const to = band.y + band.h - 14;
    const at = (y: number) => {
      hook.y = Math.round(y) - 9;
      beam.y = Math.round(y);
      cable.position.set(crane.hookX, crane.jibBottom);
      cable.height = Math.max(1, hook.y - crane.jibBottom);
    };
    at(from);
    reveal(0);
    root.alpha = 0;
    this.tween(root, 250, (p) => (root.alpha = p));
    const dur = Math.min(1600, 400 + (to - from) * 1.5);
    this.tween(root, dur, (p) => at(from + (to - from) * ease(p)), () => at(to), 250);
    this.tween(root, 300, (p) => reveal(p), () => reveal(1), 250 + dur);
    this.fadeOut(root, 250 + dur + 300, 400, () => root.destroy({ children: true }));
  }
}
