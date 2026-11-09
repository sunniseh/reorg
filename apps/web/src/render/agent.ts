/**
 * RgAgent (design §5.1, §15.2): one character drawn from at most three atlas sprites: the
 * fixed-color base, the grayscale shirt layer tinted with the body color, and the grayscale hair
 * layer tinted with the hair color. Origin = the frame's bottom center; profile frames face right
 * and are mirrored to face left. Optional: a prop at the hand point (paper, plant) and the
 * player's 1 px accent ring that follows the character (design §5.4). It never decides anything:
 * callers set the frame.
 */
import type { Appearance } from "@reorg/core";
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { TOKENS } from "../theme/tokens";
import type { Atlas } from "./atlas";
import { RIG } from "./geometry";

export class RgAgent extends Container {
  private readonly shadow = new Sprite(Texture.WHITE);
  private readonly base = new Sprite();
  private readonly shirt = new Sprite();
  private readonly hair = new Sprite();
  private readonly prop = new Sprite();
  private readonly flame = new Sprite();
  private readonly sweat = new Sprite();
  private flames = 0;
  private ring: Graphics | null = null;
  private ringH = 0;
  private frameName = "";
  private propName: string | null = null;
  private look: Appearance | null;

  constructor(
    private readonly atlas: Atlas,
    look: Appearance | null,
  ) {
    super();
    this.look = look;
    // A 1 px ground shadow under standing characters (art/scene.mjs).
    this.shadow.tint = TOKENS.bg;
    this.shadow.alpha = 0.45;
    this.shadow.setSize(12, 1);
    this.shadow.position.set(-6, -1);
    this.prop.visible = false;
    this.flame.visible = false;
    this.sweat.visible = false;
    this.addChild(this.shadow, this.flame, this.base, this.shirt, this.hair, this.prop, this.sweat);
    this.applyTints();
  }

  setLook(look: Appearance | null): void {
    if (look && this.look && look.body === this.look.body && look.hairColor === this.look.hairColor && look.hairStyle === this.look.hairStyle) return;
    if (!look && !this.look) return;
    this.look = look;
    this.applyTints();
    const f = this.frameName;
    this.frameName = "";
    if (f) this.show(f, this.scale.x < 0);
  }

  get frame(): string {
    return this.frameName;
  }

  /** Shows `frame`, mirrored to face left when `mirror`. Cheap when nothing changed. */
  show(frame: string, mirror = false): void {
    this.scale.x = mirror ? -1 : 1;
    if (frame === this.frameName) return;
    this.frameName = frame;
    const tex = this.atlas.tex(frame);
    const w = tex.frame.width;
    const h = tex.frame.height;
    this.base.texture = tex;
    this.base.position.set(-w / 2, -h);
    const shirtName = `${frame}#shirt`;
    this.shirt.visible = this.atlas.has(shirtName) && !!this.look;
    if (this.shirt.visible) {
      this.shirt.texture = this.atlas.tex(shirtName);
      this.shirt.position.set(-w / 2, -h);
    }
    const info = RIG.frames[frame];
    const style = this.look?.hairStyle;
    this.hair.visible = !!info && !!style && style !== "none";
    if (this.hair.visible && info && style) {
      this.hair.texture = this.atlas.tex(`hair.${style}.${info.view}`);
      const hy = RIG.hair[style]![info.view].y + info.headY;
      this.hair.position.set(-w / 2 + (info.headX ?? 0), -h + hy);
    }
    // Standing frames cast the ground shadow; seated ones are behind a desk.
    this.shadow.visible = h >= 24 && !frame.startsWith("emp.visitor");
    this.placeProp();
    if (this.ring) this.drawRing();
  }

  /** A carried prop at the hand point (`prop.paper`, `prop.plant`), or none. */
  setProp(name: string | null): void {
    if (name === this.propName) return;
    this.propName = name;
    this.prop.visible = !!name;
    if (name) this.prop.texture = this.atlas.tex(name);
    this.placeProp();
  }

  private placeProp(): void {
    if (!this.propName || !this.frameName) return;
    const tex = this.base.texture;
    const hand = RIG.frames[this.frameName]?.hand ?? [6, 18];
    const pw = this.prop.texture.frame.width;
    const ph = this.prop.texture.frame.height;
    this.prop.position.set(-tex.frame.width / 2 + hand[0] - Math.floor(pw / 2) + 1, -tex.frame.height + hand[1] - ph + 2);
  }

  /**
   * Character overlays (design §5.4, P1): a flame over the head, one size per streak milestone
   * reached, and a sweat drop while struggling (a miss in a row). Both say true state.
   */
  setMarks(flames: number, sweat: boolean, now: number): void {
    const h = this.base.texture.frame.height;
    const side = RIG.frames[this.frameName]?.view === "side";
    this.flames = Math.max(0, Math.min(3, flames));
    this.flame.visible = this.flames > 0;
    if (this.flame.visible) {
      this.flame.texture = this.atlas.tex(`fx.flame.${this.flames}.${Math.floor(now / 250) % 2}`);
      const f = this.flame.texture.frame;
      this.flame.position.set(-Math.floor(f.width / 2) + (side ? 1 : 0), -h - f.height + 1);
    }
    this.sweat.visible = sweat;
    if (sweat) {
      this.sweat.texture = this.atlas.tex("fx.sweat");
      // A drop that slides down the temple and starts again, every 1.6 s.
      const k = (now % 1600) / 1600;
      this.sweat.position.set(side ? -6 : 5, -h + 3 + Math.floor(k * 4));
      this.sweat.alpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
    }
  }

  /** The player's ring (design §5.4: 1 px accent outline that follows the character). */
  setRing(on: boolean): void {
    if (on === !!this.ring) return;
    if (on) {
      this.ring = new Graphics();
      this.addChildAt(this.ring, 0);
      this.ringH = 0;
      this.drawRing();
    } else {
      this.ring?.destroy();
      this.ring = null;
    }
  }

  private drawRing(): void {
    const h = this.base.texture.frame.height + 3;
    if (!this.ring || h === this.ringH) return;
    this.ringH = h;
    this.ring.clear().rect(-10, -h + 1, 20, h).stroke({ color: TOKENS.accent, width: 1, alignment: 1 });
  }

  private applyTints(): void {
    if (!this.look) return;
    this.shirt.tint = TOKENS.body[this.look.body]!;
    this.hair.tint = TOKENS.hair[this.look.hairColor]!;
  }
}
