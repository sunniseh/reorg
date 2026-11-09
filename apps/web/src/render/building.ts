/**
 * RgBuilding (roadmap W-05, W-07; design §4, §5, §15.2): the side-on cutaway drawn from the
 * atlas, band by band, exactly as art/scene.mjs composes it, with every wallet as a living agent.
 *
 * Layers (design §4.1) are building-wide, so characters can walk, climb and ride between bands:
 * backdrop → band backs (cached) → chairs → seated characters → desk fronts (cached) and live desk
 * props → hit areas → the elevator cab with its riders and doors → aisle characters → the lobby's
 * street front and the sidewalk → street characters → effects → screen-size labels. Each band
 * puts one container in each layer it uses; culling hides a band's containers together.
 *
 * The renderer holds no game logic: `TowerLayout` (packages/core) says who sits where and what
 * each desk shows; the director (W-08) turns model changes into scripts and timed effects; the
 * cast and the idle schedule (W-21) say where each character is at any moment.
 */
import type { TierIndex, TowerCharacter, TowerLayout, WalletId } from "@reorg/core";
import { Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite, type FederatedPointerEvent } from "pixi.js";
import { Cast } from "../agents/cast";
import { ANIM, type Layer, type Pose } from "../agents/track";
import { Director, homesOf, lifeOf, type DirectorModel } from "../director";
import { payout, plural, TIER_PLURALS } from "../format";
import { Nav } from "../nav";
import { effectiveStatus, type Snapshot } from "../state/types";
import { TOKENS } from "../theme/tokens";
import { RgAgent } from "./agent";
import type { Atlas } from "./atlas";
import { clockHand, vaultModel } from "./derive";
import { bandsOf, G, RIG, roomOf, TIER_KEYS, type Band, type BandStack } from "./geometry";

const B = RIG.building;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Sky and street reach this far past the building on each side (sprite px). */
export const SIDE = 1200;
type ShellState = "garage" | "office" | "tower";

export interface SceneModel {
  layout: TowerLayout;
  snap: Snapshot;
  you: WalletId | null;
  /** Corrected wall clock (ms). */
  now: number;
  /** Boss line to show in the bubble, if any. */
  bubble: string | null;
  /** False on the first model (late joiners see state, not history). */
  animate: boolean;
  reducedMotion: boolean;
}

export interface BuildingHandlers {
  select(wallet: WalletId | null): void;
  hover(wallet: WalletId | null, x: number, y: number): void;
  vault(): void;
  /** Many moves were skipped at once (catch-up): the feed says so in one line. */
  caughtUp?(moves: number): void;
}

// ------------------------------------------------------------------ small helpers

interface Tween {
  t0: number;
  dur: number;
  step(p: number): void;
  done?: () => void;
}

class Tweens {
  private list: Tween[] = [];
  add(now: number, dur: number, step: (p: number) => void, done?: () => void, delay = 0): void {
    this.list.push({ t0: now + delay, dur, step, ...(done ? { done } : {}) });
  }
  update(now: number): void {
    if (!this.list.length) return;
    // Tweens added while stepping (chained effects) start on the next frame.
    const list = this.list;
    this.list = [];
    const keep: Tween[] = [];
    for (const t of list) {
      if (now < t.t0) {
        keep.push(t);
        continue;
      }
      const p = Math.min(1, (now - t.t0) / Math.max(1, t.dur));
      t.step(p);
      if (p < 1) keep.push(t);
      else t.done?.();
    }
    this.list.push(...keep);
  }
  /** Jumps every running tween (and the ones they chain) to its end (tap to skip, design §14.1 rule 4). */
  finish(): void {
    for (let guard = 0; guard < 4 && this.list.length; guard++) {
      const list = this.list;
      this.list = [];
      for (const t of list) {
        t.step(1);
        t.done?.();
      }
    }
    this.list = [];
  }
}

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

function text(str: string, size: number, opts: { weight?: string; fill?: number; resolution?: number } = {}): Text {
  return new Text({
    text: str,
    style: { fontFamily: FONT, fontSize: size, fontWeight: (opts.weight ?? "600") as "600", fill: opts.fill ?? TOKENS.ink },
    ...(opts.resolution ? { resolution: opts.resolution } : {}),
  });
}

/** A label drawn at screen size whatever the zoom (design §7): it counter-scales by 1/zoom. */
class ScreenLabel extends Container {
  constructor() {
    super();
    this.eventMode = "none";
  }
}

function chip(str: string, fill: number, ink: number, size = 9): ScreenLabel {
  const c = new ScreenLabel();
  const t = text(str, size, { weight: "700", fill: ink });
  const g = new Graphics().roundRect(0, 0, t.width + 8, t.height + 2, 4).fill(fill);
  t.position.set(4, 1);
  c.addChild(g, t);
  return c;
}

const LAYERS = ["backdrop", "backs", "chairs", "seated", "fronts", "tops", "hits", "cab", "aisle", "lobbyFront", "street", "fx", "labels"] as const;
type LayerName = (typeof LAYERS)[number];

/** A drawn character: its sprites and the layer it is in. */
interface AgentView {
  sprite: RgAgent;
  layer: Layer | null;
  char: TowerCharacter | null;
}

// ------------------------------------------------------------------ the building

export class RgBuilding extends Container {
  private stack: BandStack | null = null;
  private shell: ShellState | null = null;
  private floorKeys = "";
  private bands = new Map<string, BandView>();
  private readonly tweens = new Tweens();
  readonly layer = {} as Record<LayerName, Container>;
  private zoom = 1;
  private model: SceneModel | null = null;
  readonly labels = new Set<ScreenLabel>();

  // The life system.
  nav: Nav | null = null;
  cast: Cast | null = null;
  private director: Director | null = null;
  private readonly views = new Map<WalletId, AgentView>();
  private readonly poses = new Map<WalletId, Pose>();
  private readonly bossView: RgAgent;
  private readonly riders = new Container();
  private readonly cab: Sprite;
  private readonly cabDoors: Sprite;
  private cabState: { y: number; doors: 0 | 1 | 2; dir: -1 | 0 | 1 } = { y: 0, doors: 0, dir: 0 };
  /** Desk overlays switch to the new model from these times (director). */
  private readonly deskAt = new Map<WalletId, number>();
  /** Desk status (dim and box) switches at these times. */
  private readonly statusAt = new Map<WalletId, number>();
  /** Carried sheets land in the outbox at these times. */
  private readonly outboxAt = new Map<WalletId, number>();
  private alarmAt = -Infinity;
  private vaultPulseAt = -Infinity;
  private bubbleNotBefore = -Infinity;
  private bubble: ScreenLabel | null = null;
  private bubbleText: string | null = null;
  private bubbleShown = 0;
  private viewY: [number, number] = [-Infinity, Infinity];

  constructor(
    readonly atlas: Atlas,
    readonly handlers: BuildingHandlers,
  ) {
    super();
    for (const n of LAYERS) {
      const c = new Container();
      c.label = n;
      if (n === "fx" || n === "labels") c.eventMode = "none";
      this.layer[n] = c;
      this.addChild(c);
    }
    this.cab = new Sprite(atlas.tex("core.cab"));
    this.cabDoors = new Sprite(atlas.tex("core.cab.door.0"));
    this.layer.cab.addChild(this.cab, this.riders, this.cabDoors);
    this.bossView = new RgAgent(atlas, null);
    this.layer.aisle.addChild(this.bossView);
  }

  get worldHeight(): number {
    return this.stack?.height ?? 0;
  }

  get bandStack(): BandStack | null {
    return this.stack;
  }

  /** Registers a screen-size label (scaled 1/zoom). */
  track<T extends ScreenLabel>(l: T): T {
    l.scale.set(this.labelScale());
    this.labels.add(l);
    l.on("destroyed", () => this.labels.delete(l));
    return l;
  }

  /** Screen-size labels shrink a little when the building is drawn small (phones, design §10). */
  private labelScale(): number {
    return (this.zoom < 1.5 ? 0.8 : 1) / this.zoom;
  }

  setZoom(z: number): void {
    if (z === this.zoom) return;
    this.zoom = z;
    const k = this.labelScale();
    for (const l of this.labels) l.scale.set(k);
  }

  /** Shows only the bands (and characters) that intersect [y0, y1] (world px). */
  cull(y0: number, y1: number): void {
    this.viewY = [y0 - 40, y1 + 40];
    if (!this.stack) return;
    for (const b of this.stack.bands) this.bands.get(b.key)?.setVisible(b.y + b.h + 30 > y0 && b.y - 30 < y1);
  }

  /** Tap to skip (design §14.1 rule 4): effects and scripts jump to their end. */
  skip(): void {
    const now = Math.max(this.clock, this.model?.now ?? 0);
    this.tweens.finish();
    this.director?.skip(now);
    this.alarmAt = -Infinity;
    this.bubbleNotBefore = -Infinity;
    for (const k of this.outboxAt.keys()) this.outboxAt.set(k, -Infinity);
  }

  update(m: SceneModel): void {
    const prev = this.model;
    this.model = m;
    const shell = shellOf(m.layout.state);
    const keys = m.layout.floors.map((f) => f.key).join(",");
    if (!this.stack || keys !== this.floorKeys || shell !== this.shell) this.rebuild(m, shell, keys);
    this.chars = new Map(m.layout.characters.map((c) => [c.wallet, c]));
    // The director first: it sets the desk and outbox times the bands read.
    this.director!.apply(prev ? dm(prev) : null, dm(m), this.nav!);
    for (const v of this.bands.values()) v.update(m, prev);
  }

  /** Per frame: characters, the cab, desks, effects. Only visible bands do work. */
  tick(now: number): void {
    this.clock = now;
    this.tweens.update(now);
    const m = this.model;
    if (!m || !this.cast) return;
    this.cast.prune(now);
    this.cabState = this.cast.elevator.state(now);
    this.cab.position.set(B.core.cab.x, Math.round(this.cabState.y) - B.core.cab.floorRow);
    this.cabDoors.position.copyFrom(this.cab.position);
    this.cabDoors.texture = this.atlas.tex(`core.cab.door.${this.cabState.doors}`);
    this.tickAgents(now, m);
    this.tickBubble(now, m);
    for (const v of this.bands.values()) if (v.visible) v.tick(now, m);
  }

  addTween(dur: number, step: (p: number) => void, done?: () => void, delay = 0): void {
    this.tweens.add(Math.max(this.clock, this.model?.now ?? 0), dur, step, done, delay);
  }

  /** The frame clock (tweens chained from other tweens start now, not at the last model). */
  private clock = 0;

  /** World position of a character's head (the card, the tooltip and Go to my desk follow it). */
  anchorOf(wallet: WalletId): { x: number; y: number } | null {
    const p = this.poses.get(wallet);
    if (!p) return null;
    const h = this.atlas.tex(p.frame).frame.height;
    return { x: p.x, y: p.y - h };
  }

  /** The pose of a character this frame (bands read it for chairs and monitors). */
  poseOf(wallet: WalletId): Pose | null {
    return this.poses.get(wallet) ?? null;
  }

  /** When a desk shows its new state (default: at once). */
  deskSwitchAt(wallet: WalletId): number {
    return this.deskAt.get(wallet) ?? -Infinity;
  }

  /** When a desk shows its new status (dimmed or bright). */
  statusSwitchAt(wallet: WalletId): number {
    return this.statusAt.get(wallet) ?? -Infinity;
  }

  /** Whether the wallet's sheet is in the outbox at `now`. */
  inOutbox(wallet: WalletId, now: number): boolean {
    return now >= (this.outboxAt.get(wallet) ?? -Infinity);
  }

  get alarmStart(): number {
    return this.alarmAt;
  }

  get vaultPulseStart(): number {
    return this.vaultPulseAt;
  }

  get cabDir(): -1 | 0 | 1 {
    return this.cabState.dir;
  }

  get doorFrame(): 0 | 1 | 2 {
    return this.cast?.doorFrame(this.model?.now ?? 0) ?? 0;
  }

  // ---------------------------------------------------------------- agents

  private tickAgents(now: number, m: SceneModel): void {
    const cast = this.cast!;
    const [y0, y1] = this.viewY;
    for (const [w, ctl] of cast.ctls) {
      if (ctl.retireAt !== null && now > ctl.retireAt) {
        cast.ctls.delete(w);
        continue;
      }
      const pose = ctl.pose(now, cast.life);
      this.poses.set(w, pose);
      let v = this.views.get(w);
      if (!v) {
        v = this.makeView(w);
        this.views.set(w, v);
      }
      const c = this.chars.get(w) ?? v.char;
      if (c !== v.char) {
        v.char = c;
        v.sprite.setLook(c && c.status !== "visitor" ? c.look : null);
      }
      this.place(v, pose, y0, y1, !!c && c.wallet === m.you && c.status !== "visitor");
      // Marks carry state, so reduced motion keeps them, still (design §14.5).
      if (v.sprite.visible) v.sprite.setMarks(c?.flames ?? 0, c?.status === "struggling", m.reducedMotion ? 0 : now);
    }
    for (const [w, v] of this.views) {
      if (cast.ctls.has(w)) continue;
      v.sprite.destroy({ children: true });
      this.views.delete(w);
      this.poses.delete(w);
    }
    // The boss.
    const bp = cast.boss.pose(now, cast.nav);
    const parent = bp.layer === "cab" ? this.riders : this.layer.aisle;
    if (this.bossView.parent !== parent) parent.addChild(this.bossView);
    this.placeSprite(this.bossView, bp, y0, y1);
    this.poses.set(BOSS, bp);
  }

  private chars = new Map<WalletId, TowerCharacter>();

  private makeView(w: WalletId): AgentView {
    const sprite = new RgAgent(this.atlas, null);
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    sprite.hitArea = new Rectangle(-8, -26, 16, 26);
    sprite.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.handlers.select(w);
    });
    sprite.on("pointerover", (e: FederatedPointerEvent) => this.handlers.hover(w, e.global.x, e.global.y));
    sprite.on("pointerout", () => this.handlers.hover(null, 0, 0));
    return { sprite, layer: null, char: null };
  }

  private place(v: AgentView, pose: Pose, y0: number, y1: number, you: boolean): void {
    if (pose.layer !== v.layer) {
      v.layer = pose.layer;
      const parent = pose.layer === "seat" ? this.layer.seated : pose.layer === "cab" ? this.riders : pose.layer === "street" ? this.layer.street : this.layer.aisle;
      parent.addChild(v.sprite);
    }
    this.placeSprite(v.sprite, pose, y0, y1);
    v.sprite.setProp(pose.prop ? `prop.${pose.prop}` : null);
    v.sprite.setRing(you);
  }

  private placeSprite(s: RgAgent, pose: Pose, y0: number, y1: number): void {
    const visible = pose.alpha > 0.01 && pose.y > y0 && pose.y - 30 < y1;
    s.visible = visible;
    if (!visible) return;
    s.alpha = pose.alpha;
    s.position.set(Math.round(pose.x), Math.round(pose.y));
    s.show(pose.frame, pose.mirror);
  }

  // ---------------------------------------------------------------- the boss's bubble

  private tickBubble(now: number, m: SceneModel): void {
    if (m.bubble !== this.bubbleText && now >= this.bubbleNotBefore) {
      this.bubbleText = m.bubble;
      this.bubbleShown = now;
      this.bubble?.destroy({ children: true });
      this.bubble = m.bubble ? this.makeBubble(m.bubble) : null;
    }
    if (!this.bubble) return;
    const bp = this.poses.get(BOSS);
    if (!bp) return;
    // The bubble follows the boss (design §5.8), kept inside the building.
    this.bubble.position.set(Math.min(G.width - 120, Math.max(120, bp.x)), bp.y - 30);
    // The bubble stays 14 s, then fades (the boss moves on).
    const age = now - this.bubbleShown;
    this.bubble.alpha = age < 14_000 ? 1 : Math.max(0, 1 - (age - 14_000) / 600);
    this.bubble.visible = this.bubble.alpha > 0;
  }

  private makeBubble(str: string): ScreenLabel {
    const l = new ScreenLabel();
    const t = text(str, 12, { weight: "500" });
    t.style.wordWrap = true;
    t.style.wordWrapWidth = 260;
    const w = t.width + 18;
    const h = t.height + 10;
    const g = new Graphics()
      .roundRect(-w / 2, -h - 7, w, h, 8)
      .fill(TOKENS.panel)
      .stroke({ color: TOKENS.accent, width: 1 })
      .poly([-5, -7.5, 0, 0, 5, -7.5])
      .fill(TOKENS.panel);
    g.moveTo(-5, -7).lineTo(0, 0).lineTo(5, -7).stroke({ color: TOKENS.accent, width: 1 });
    t.position.set(-w / 2 + 9, -h - 2);
    l.addChild(g, t);
    this.layer.labels.addChild(this.track(l));
    return l;
  }

  // ---------------------------------------------------------------- effects (director)

  /**
   * Payday (design §14.3): a coin rises through the pneumatic tube from the vault, pops out of the
   * floor's outlet and lands on the desk; a small "+amount" rises and fades; the character cheers.
   */
  private payday(wallet: WalletId, pay: bigint, at: number): void {
    const m = this.model;
    const nav = this.nav;
    const ref = m?.layout.desks.get(wallet);
    if (!m || !nav || !ref) return;
    const floor = m.layout.floors[ref.floor]!;
    const band = nav.band(floor.key);
    const R = roomOf(floor.tier);
    const rx = G.rooms.x + ref.room * R.w;
    const tx = rx + R.paper[0] + 3;
    const ty = band.top + R.paper[1] - 2;
    const [mx, my0] = B.core.outlet.mouth;
    const my = band.top + my0;
    const foot = nav.band("basement").top + B.basement.tubeFoot.y;
    const delay = Math.max(0, at - Math.max(this.clock, m.now));
    // ≤ 520 px: desks get the coin only; exact amounts stay on the player's own desk (design §10).
    const narrow = typeof window !== "undefined" && window.innerWidth <= 520;
    const showAmount = !narrow || wallet === m.you;
    const land = () => {
      const now = this.clock;
      const ctl = this.cast?.ctls.get(wallet);
      if (ctl && (!ctl.reaction || ctl.reaction.t1 < now)) ctl.reaction = { anim: ANIM.cheer, t0: now, t1: now + 1200 };
      if (!showAmount) return;
      const lab = new ScreenLabel();
      const amount = text(`+${payout(pay, { symbol: false })}`, 9, { weight: "700", fill: TOKENS.good });
      amount.anchor.set(0.5, 1);
      lab.addChild(amount);
      lab.position.set(rx + R.dot[0] + 3, band.top + R.dot[1] - 3);
      lab.alpha = 0;
      this.layer.labels.addChild(this.track(lab));
      const y0 = lab.y;
      this.addTween(1600, (p) => {
        lab.alpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
        lab.y = y0 - 14 * easeOut(p);
      }, () => lab.destroy({ children: true }));
    };
    if (m.reducedMotion) {
      this.addTween(1, () => undefined, land, delay);
      return;
    }
    const coin = new Sprite(this.atlas.tex("prop.coin.0"));
    coin.anchor.set(0.5, 0.5);
    coin.visible = false;
    this.layer.fx.addChild(coin);
    const tubeX = G.tube.x + G.tube.w / 2;
    const rise = Math.max(300, (foot - my) * 1.4);
    const arc = 650 + Math.abs(tx - mx) * 1.2;
    this.addTween(
      rise,
      (p) => {
        coin.visible = true;
        coin.position.set(tubeX, foot + (my - foot) * p);
        coin.texture = this.atlas.tex(`prop.coin.${Math.floor(p * 10) % 4}`);
      },
      () => {
        this.addTween(
          arc,
          (p) => {
            coin.position.set(mx + (tx - mx) * p, my + (ty - my) * p - Math.sin(p * Math.PI) * 18);
            coin.texture = this.atlas.tex(`prop.coin.${Math.floor(p * 12) % 4}`);
          },
          () => {
            coin.texture = this.atlas.tex("prop.coin.land");
            this.addTween(250, (p) => (coin.alpha = 1 - p), () => coin.destroy());
            land();
          },
        );
      },
      delay,
    );
  }

  // ---------------------------------------------------------------- structure

  private rebuild(m: SceneModel, shell: ShellState, keys: string): void {
    const oldShell = this.shell;
    this.shell = shell;
    this.floorKeys = keys;
    this.stack = bandsOf(m.layout);
    for (const v of this.bands.values()) v.destroy();
    this.bands.clear();
    this.drawBackdrop(this.stack);
    for (const b of this.stack.bands) this.bands.set(b.key, makeBand(this, b, shell));
    // The life system follows the geometry.
    this.nav = new Nav(this.stack);
    if (!this.cast) {
      this.cast = new Cast(this.nav, lifeOf(this.nav, m.snap, homesOf(m.layout, this.nav)));
      this.director = new Director(this.cast, {
        alarm: (at) => (this.alarmAt = at),
        deskAt: (w, at) => this.deskAt.set(w, at),
        statusAt: (w, at) => this.statusAt.set(w, at),
        outboxAt: (w, at) => this.outboxAt.set(w, at),
        payday: (w, pay, at) => this.payday(w, pay, at),
        bubbleAt: (at) => (this.bubbleNotBefore = at),
        vaultPulse: (at) => (this.vaultPulseAt = at),
        caughtUp: (n) => this.handlers.caughtUp?.(n),
      });
    }
    // Building state change seen live: a 300 ms crossfade (design §12.3).
    if (oldShell && oldShell !== shell && m.animate && !m.reducedMotion) {
      for (const n of ["backs", "fronts", "lobbyFront"] as const) {
        const c = this.layer[n];
        c.alpha = 0.4;
        this.addTween(300, (p) => (c.alpha = 0.4 + 0.6 * p));
      }
    }
  }

  private drawBackdrop(stack: BandStack): void {
    const layer = this.layer.backdrop;
    layer.removeChildren().forEach((c) => c.destroy());
    const street = stack.byKey.get("street")!;
    const sky = new Sprite(Texture.WHITE);
    sky.tint = TOKENS.sky;
    sky.position.set(-SIDE, -400);
    sky.setSize(G.width + SIDE * 2, street.y + 400);
    const skyline = new TilingSprite({ texture: this.atlas.tex("sky.skyline"), width: G.width + SIDE * 2, height: 48 });
    skyline.position.set(-SIDE, street.y - 48);
    const ground = new Sprite(Texture.WHITE);
    ground.tint = TOKENS.ground;
    ground.position.set(-SIDE, street.y + 14);
    ground.setSize(G.width + SIDE * 2, stack.height - street.y - 14 + 600);
    layer.addChild(sky, skyline, ground);
  }
}

const BOSS = "@boss";

function dm(m: SceneModel): DirectorModel {
  return { layout: m.layout, snap: m.snap, now: m.now, animate: m.animate, reducedMotion: m.reducedMotion };
}

function shellOf(state: TowerLayout["state"]): ShellState {
  return state === "garage" ? "garage" : state === "office" ? "office" : "tower";
}

function makeBand(b: RgBuilding, band: Band, shell: ShellState): BandView {
  switch (band.kind) {
    case "roof":
      return new RoofView(b, band, shell);
    case "penthouse":
      return new PenthouseView(b, band, shell);
    case "floor":
      return new FloorView(b, band, shell);
    case "lobby":
      return new LobbyView(b, band, shell);
    case "street":
      return new StreetView(b, band, shell);
    case "basement":
      return new BasementView(b, band, shell);
  }
}

// ------------------------------------------------------------------ bands

abstract class BandView {
  private readonly subs = new Map<LayerName, Container>();
  visible = true;

  constructor(
    protected readonly bld: RgBuilding,
    protected readonly band: Band,
    protected readonly shell: ShellState,
  ) {}

  /** This band's container in a building-wide layer (band-local coordinates). */
  protected sub(name: LayerName): Container {
    let c = this.subs.get(name);
    if (!c) {
      c = new Container();
      c.y = this.band.y;
      if (name === "labels" || name === "fx") c.eventMode = "none";
      this.bld.layer[name].addChild(c);
      this.subs.set(name, c);
    }
    return c;
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    for (const c of this.subs.values()) c.visible = v;
  }

  destroy(): void {
    for (const c of this.subs.values()) c.destroy({ children: true });
    this.subs.clear();
  }

  protected get atlas(): Atlas {
    return this.bld.atlas;
  }
  protected spr(parent: Container, name: string, x: number, y: number, mirror = false): Sprite {
    const s = new Sprite(this.atlas.tex(name));
    s.position.set(x, y);
    if (mirror) {
      s.scale.x = -1;
      s.x += s.texture.frame.width;
    }
    parent.addChild(s);
    return s;
  }
  protected tile(parent: Container, name: string, x: number, y: number, w: number, h: number): TilingSprite {
    const t = new TilingSprite({ texture: this.atlas.tex(name), width: w, height: h });
    t.position.set(x, y);
    parent.addChild(t);
    return t;
  }
  protected rect(parent: Container, x: number, y: number, w: number, h: number, color: number, alpha = 1): Sprite {
    const s = new Sprite(Texture.WHITE);
    s.tint = color;
    s.alpha = alpha;
    s.position.set(x, y);
    s.setSize(w, h);
    parent.addChild(s);
    return s;
  }
  protected walls(parent: Container, interior: number): void {
    this.tile(parent, `shell.${this.shell}.wall`, 0, 0, 4, interior);
    this.tile(parent, `shell.${this.shell}.wall`, G.width - 4, 0, 4, interior);
  }
  protected slab(parent: Container, interior: number): void {
    this.tile(parent, "bldg.slab", G.rooms.x, interior, G.rooms.w + G.bay.w, G.floor.slab);
    this.spr(parent, `shell.${this.shell}.slab`, 0, interior);
    this.spr(parent, `shell.${this.shell}.slab`, G.width - 4, interior);
  }
  protected core(parent: Container, opts: { top?: boolean; tube?: boolean; outlet?: boolean } = {}): void {
    const { top = false, tube = true, outlet = true } = opts;
    this.spr(parent, top ? "core.stairs.top" : "core.stairs", G.stairs.x, 0);
    this.spr(parent, top ? "core.shaft.top" : "core.shaft", G.shaft.x, 0);
    if (tube) {
      this.tile(parent, "core.tube", G.tube.x, 0, 4, this.band.h);
      if (outlet) this.spr(parent, "core.tube.outlet", B.core.outlet.x, B.core.outlet.y);
    } else this.spr(parent, "core.tube.cap", G.tube.x - 1, this.band.h - 3);
  }
  /** The live floor indicator above the shaft door: an arrow while the cab moves (design §4.4). */
  protected indicator(): Sprite {
    return this.spr(this.sub("tops"), "core.indicator.off", B.core.indicator.x, B.core.indicator.y);
  }
  protected tickIndicator(s: Sprite): void {
    const d = this.bld.cabDir;
    s.texture = this.atlas.tex(d < 0 ? "core.indicator.up" : d > 0 ? "core.indicator.down" : "core.indicator.off");
  }
  /** Screen-size label at (x, y) in band coordinates. */
  protected screenLabel<T extends ScreenLabel>(l: T, x: number, y: number): T {
    l.position.set(x, y);
    this.sub("labels").addChild(this.bld.track(l));
    return l;
  }
  protected plaque(title: string, sub?: string): ScreenLabel {
    const l = new ScreenLabel();
    const t = text(title, 12, { weight: "600" });
    const s = sub ? text(sub, 10, { weight: "400", fill: TOKENS.muted }) : null;
    const w = Math.max(t.width, s?.width ?? 0) + 10;
    const bg = new Graphics().roundRect(0, 0, w, sub ? 31 : 18, 3).fill({ color: TOKENS.bg, alpha: 0.72 });
    t.position.set(5, 2);
    l.addChild(bg, t);
    if (s) {
      s.position.set(5, 16);
      l.addChild(s);
    }
    return this.screenLabel(l, B.floor.plaque.x, B.floor.plaque.y - 3);
  }
  abstract update(m: SceneModel, prev: SceneModel | null): void;
  tick(_now: number, _m: SceneModel): void {}
}

class RoofView extends BandView {
  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    const back = this.sub("backs");
    const parapetY = band.h - 6;
    this.tile(back, `shell.${shell}.parapet`, 0, parapetY, G.width, 6);
    const sign = this.atlas.tex(B.states[shell].sign);
    this.spr(back, B.states[shell].sign, G.rooms.x + Math.round((G.rooms.w - sign.frame.width) / 2), parapetY - sign.frame.height);
    const tank = this.atlas.tex("roof.tank");
    this.spr(back, "roof.tank", B.roof.tank.x, parapetY - tank.frame.height);
    const mach = this.atlas.tex("roof.machine");
    this.spr(back, "roof.machine", B.roof.machine.x, parapetY - mach.frame.height);
    back.cacheAsTexture({ scaleMode: "nearest" });
  }
  update(): void {}
}

class PenthouseView extends BandView {
  private readonly ind: Sprite;

  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    const ih = band.interior;
    const P = B.penthouse;
    const back = this.sub("backs");
    this.rect(back, 4, 0, G.width - 8, ih, TOKENS.floor.penthouse);
    this.spr(back, P.window.tile, P.window.x, P.window.y);
    this.spr(back, P.shelf.tile, P.shelf.x, P.shelf.y);
    this.spr(back, P.orgchart.tile, P.orgchart.x, P.orgchart.y);
    this.spr(back, "lobby.plant", 344, ih - 28);
    this.core(back, { top: true, tube: false });
    this.spr(back, P.chair.tile, P.chair.x, P.chair.y);
    this.spr(back, P.desk.tile, P.desk.x, P.desk.y);
    back.cacheAsTexture({ scaleMode: "nearest" });
    const front = this.sub("fronts");
    this.walls(front, ih);
    this.slab(front, ih);
    front.cacheAsTexture({ scaleMode: "nearest" });
    this.ind = this.indicator();
  }

  update(): void {}

  override tick(): void {
    this.tickIndicator(this.ind);
  }
}

// ------------------------------------------------------------------ tier floors

interface DeskState {
  /** The character at this desk in the current model. */
  c: TowerCharacter | null;
  /** The character state the desk overlays show (switches at the director's time). */
  shown: TowerCharacter | null;
  /** The model character `shown` was made from. */
  src: TowerCharacter | null;
  /** `shown` keeps the previous status until the status time. */
  held: boolean;
  chair: Sprite;
  monitor: Sprite;
  paper: Sprite;
  dot: Sprite;
  dim: Sprite;
  box: Sprite;
  streak: ScreenLabel | null;
  streakN: number;
  newChip: ScreenLabel | null;
  plate: ScreenLabel | null;
  hit: Container;
  flashUntil: number;
}

class FloorView extends BandView {
  private readonly tier: TierIndex;
  private readonly desks: DeskState[] = [];
  private occupancy = "";
  private readonly clockHandS: Sprite;
  private readonly alarm: Sprite;
  private readonly sheets: Sprite;
  private readonly board: Text;
  private readonly ind: Sprite;
  private taskId: number | null = null;
  private plaqueN = -1;
  private plaqueL: ScreenLabel | null = null;

  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    this.tier = band.tier!;
    const R = roomOf(this.tier);
    const ih = band.interior;
    // Back wall, core, bay (static, cached).
    const back = this.sub("backs");
    this.rect(back, 4, 0, G.width - 8, ih, TOKENS.floor[TIER_KEYS[this.tier]]);
    if (this.tier === 3) for (let i = 0; i < 4; i++) this.spr(back, `wall.poster.${i % 3}`, G.rooms.x + 54 + i * 72, B.floor.posters.y);
    this.core(back);
    this.spr(back, "bay", G.bay.x, 0);
    this.spr(back, "wall.clock", B.floor.clock.x, B.floor.clock.y);
    this.spr(back, "wall.whiteboard", B.floor.whiteboard.x, B.floor.whiteboard.y);
    for (let i = 0; i < R.perFloor; i++) this.spr(back, `room.${TIER_KEYS[this.tier]}.back`, G.rooms.x + i * R.w, 0);
    back.cacheAsTexture({ scaleMode: "nearest" });
    this.sub("chairs");
    this.sub("fronts");

    // Live props on the back wall and in the bay.
    const tops = this.sub("tops");
    this.clockHandS = this.spr(tops, "wall.clock.hand.0", B.floor.clock.x, B.floor.clock.y);
    this.alarm = this.spr(tops, "wall.alarm.off", B.floor.alarm.x, B.floor.alarm.y);
    this.sheets = this.spr(tops, "prop.sheets.1", B.floor.outboxSheets.x, B.floor.outboxSheets.y);
    this.sheets.visible = false;
    this.board = text("", 6, { weight: "800", fill: TOKENS.bg, resolution: 8 });
    this.board.anchor.set(0.5, 0.5);
    this.board.position.set(B.floor.whiteboard.x + 11, B.floor.whiteboard.y + 7);
    tops.addChild(this.board);
    this.ind = this.indicator();
    for (let i = 0; i < R.perFloor; i++) this.desks.push(this.makeDesk(i));
  }

  private makeDesk(i: number): DeskState {
    const R = roomOf(this.tier);
    const rx = G.rooms.x + i * R.w;
    const tops = this.sub("tops");
    const chair = this.spr(this.sub("chairs"), "prop.chair.front", 0, 0);
    const monitor = this.spr(tops, `prop.${R.screen}.off`, rx + R.monitor[0], R.monitor[1]);
    const dim = this.rect(tops, rx, 0, R.w, this.band.interior, TOKENS.floor[TIER_KEYS[this.tier]], 0.6);
    const box = this.spr(tops, "prop.box", rx + R.box[0], R.box[1]);
    const paper = this.spr(tops, "prop.paper", rx + R.paper[0], R.paper[1]);
    const dot = this.spr(tops, "fx.dot.pass", rx + R.dot[0], R.dot[1]);
    const hit = new Container();
    hit.hitArea = new Rectangle(rx, 0, R.w, this.band.interior);
    hit.eventMode = "static";
    hit.cursor = "pointer";
    this.sub("hits").addChild(hit);
    const d: DeskState = { c: null, shown: null, src: null, held: false, chair, monitor, paper, dot, dim, box, streak: null, streakN: 0, newChip: null, plate: null, hit, flashUntil: 0 };
    hit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.bld.handlers.select(d.c?.wallet ?? null);
    });
    hit.on("pointerover", (e: FederatedPointerEvent) => d.c && this.bld.handlers.hover(d.c.wallet, e.global.x, e.global.y));
    hit.on("pointerout", () => this.bld.handlers.hover(null, 0, 0));
    for (const s of [chair, monitor, dim, box, paper, dot]) s.visible = false;
    return d;
  }

  private rebuildFront(): void {
    const R = roomOf(this.tier);
    const front = this.sub("fronts");
    front.cacheAsTexture(false);
    front.removeChildren().forEach((c) => c.destroy());
    this.desks.forEach((d, i) => {
      const rx = G.rooms.x + i * R.w;
      this.spr(front, d.c ? `room.${TIER_KEYS[this.tier]}.front` : `room.${TIER_KEYS[this.tier]}.empty`, rx, 0);
    });
    if (this.tier === 0) this.spr(front, "room.directors.wall", G.bay.x - 4, 0);
    this.walls(front, this.band.interior);
    this.spr(front, `shell.${this.shell}.window`, G.width - 4, 12);
    this.slab(front, this.band.interior);
    front.cacheAsTexture({ scaleMode: "nearest" });
  }

  update(m: SceneModel): void {
    const floor = m.layout.floors[this.band.floor!]!;
    const occ = floor.desks.map((c) => (c ? "x" : "-")).join("");
    const firstTime = this.occupancy === "";
    floor.desks.forEach((c, i) => {
      const d = this.desks[i]!;
      d.c = c;
      // Someone else sits here now: the desk shows them at once (there is no history to animate).
      if (!c || d.shown?.wallet !== c.wallet) {
        d.shown = d.src = c;
        d.held = false;
        this.applyDesk(d, i, m);
      }
    });
    if (occ !== this.occupancy) {
      this.occupancy = occ;
      this.rebuildFront();
    }
    const task = m.snap.task;
    if (task && task.id !== this.taskId) {
      this.taskId = task.id;
      this.board.text = `DAY ${task.id}`;
    } else if (!task) this.board.text = "";

    // Plaque on the first floor of each tier.
    if (floor.index === 0 && (firstTime || this.plaqueN !== m.layout.tierCounts[this.tier])) {
      this.plaqueN = m.layout.tierCounts[this.tier];
      this.plaqueL?.destroy({ children: true });
      this.plaqueL = this.plaque(TIER_PLURALS[this.tier], plural(this.plaqueN, "employee"));
    }
    this.desks.forEach((d, i) => this.applyLabels(d, i, m));
  }

  /** The desk takes the new character state, with entrance animations for what changed (design §14.2). */
  private reveal(d: DeskState, i: number, m: SceneModel, now: number): void {
    const old = d.shown;
    let c = d.c;
    d.src = c;
    // The status (dim, box) waits for the character to leave or sit down.
    d.held = !!c && !!old && old.wallet === c.wallet && old.status !== c.status && now < this.bld.statusSwitchAt(c.wallet);
    if (c && d.held) c = { ...c, status: old!.status };
    d.shown = c;
    this.applyDesk(d, i, m);
    if (!c || !old || old.wallet !== c.wallet || !m.animate) return;
    const R = roomOf(this.tier);
    const reduced = m.reducedMotion;
    if (c.submitted && !old.submitted) {
      d.flashUntil = now + 200;
      const y0 = R.paper[1];
      d.paper.y = y0 - 6;
      d.paper.alpha = 0;
      this.bld.addTween(reduced ? 100 : 260, (p) => {
        d.paper.y = y0 - 6 + 6 * easeOut(p);
        d.paper.alpha = p;
      });
    }
    if (c.result && !old.result) {
      d.dot.alpha = 0;
      this.bld.addTween(220, (p) => (d.dot.alpha = p));
    }
    if (c.streak > old.streak && d.streak) {
      // Streak pop (design §14.3): a quick swell, step 2 of the finalize choreography.
      const s = d.streak;
      const base = s.scale.x;
      this.bld.addTween(400, (p) => s.scale.set(base * (1 + 0.5 * Math.sin(p * Math.PI))), () => s.scale.set(base), reduced ? 0 : 1300);
    }
    if (c.status === "laid_off" && old.status !== "laid_off") {
      d.dim.alpha = 0;
      this.bld.addTween(reduced ? 100 : 600, (p) => (d.dim.alpha = 0.6 * p));
    }
    if (c.status !== "laid_off" && old.status === "laid_off") {
      d.dim.visible = true;
      d.dim.alpha = 0.6;
      this.bld.addTween(reduced ? 100 : 300, (p) => (d.dim.alpha = 0.6 * (1 - p)), () => (d.dim.visible = false));
    }
  }

  private applyDesk(d: DeskState, i: number, m: SceneModel): void {
    const c = d.shown;
    const R = roomOf(this.tier);
    const rx = G.rooms.x + i * R.w;
    d.chair.visible = !!c && c.status !== "laid_off";
    d.monitor.visible = !!c;
    d.paper.visible = !!c?.submitted;
    d.paper.alpha = 1;
    d.paper.y = R.paper[1];
    d.dot.visible = !!c?.result;
    d.dot.alpha = 1;
    if (c?.result) d.dot.texture = this.atlas.tex(`fx.dot.${c.result}`);
    d.dim.visible = c?.status === "laid_off";
    d.dim.alpha = 0.6;
    d.box.visible = c?.status === "laid_off";
    d.hit.visible = !!d.c;
    // Streak number (design §5.4).
    const streakShown = c && c.status !== "new_hire" && c.streak >= (m.snap.config.streak_milestones[0] ?? 3) ? c.streak : 0;
    if (streakShown !== d.streakN) {
      d.streakN = streakShown;
      d.streak?.destroy({ children: true });
      d.streak = null;
      if (streakShown) {
        const l = new ScreenLabel();
        l.addChild(text(String(streakShown), 9, { weight: "700", fill: TOKENS.muted }));
        d.streak = this.screenLabel(l, rx + R.streak[0] + 1, R.streak[1] - 1);
      }
    }
    this.applyLabels(d, i, m);
  }

  private applyLabels(d: DeskState, i: number, m: SceneModel): void {
    const c = d.shown;
    const R = roomOf(this.tier);
    const rx = G.rooms.x + i * R.w;
    const you = !!c && c.wallet === m.you;
    // The You plate takes the desk front; the dock and the card still say "New hire".
    const isNew = c?.status === "new_hire" && !you;
    if (isNew && !d.newChip) d.newChip = this.screenLabel(chip("NEW", TOKENS.ink, TOKENS.bg), rx + R.chip[0], R.chip[1]);
    if (!isNew && d.newChip) {
      d.newChip.destroy({ children: true });
      d.newChip = null;
    }
    if (you && !d.plate) d.plate = this.screenLabel(chip("You", TOKENS.accent, TOKENS.bg), rx + R.plate[0] - 6, R.plate[1] - 3);
    if (!you && d.plate) {
      d.plate.destroy({ children: true });
      d.plate = null;
    }
  }

  override tick(now: number, m: SceneModel): void {
    const task = m.snap.task;
    this.clockHandS.texture = this.atlas.tex(`wall.clock.hand.${clockHand(task, now)}`);
    // Alarm: three pulses at 4 fps when a task opens (design §9: never more than 3 flashes/s).
    const a = now - this.bld.alarmStart;
    this.alarm.texture = this.atlas.tex(!m.reducedMotion && a >= 0 && a < 1500 && Math.floor(a / 250) % 2 === 0 ? "wall.alarm.on" : "wall.alarm.off");
    this.tickIndicator(this.ind);
    const R = roomOf(this.tier);
    const exec = R.chair === "exec";
    const band = this.band.key;
    const open = !!task && effectiveStatus(task, now) === "open";
    let sheets = 0;
    this.desks.forEach((d, i) => {
      const c = d.c;
      if (c && ((d.src !== c && now >= this.bld.deskSwitchAt(c.wallet)) || (d.held && now >= this.bld.statusSwitchAt(c.wallet)))) this.reveal(d, i, m, now);
      const s = d.shown;
      if (!s) return;
      if (s.submitted && this.bld.inOutbox(s.wallet, now)) sheets++;
      if (s.status === "laid_off") return;
      const rx = G.rooms.x + i * R.w;
      const seatX = rx + R.seat + 8;
      // The chair turns with its sitter; the monitor is on while someone works at it.
      const pose = this.bld.poseOf(s.wallet);
      const seated = !!pose && pose.layer === "seat" && pose.band === band && Math.abs(pose.x - seatX) < 1;
      const side = seated && RIG.frames[pose!.frame]?.view === "side";
      const ca = side ? (exec ? RIG.attach.chairExecSide : RIG.attach.chairSide) : exec ? RIG.attach.chairExecFront : RIG.attach.chairFront;
      d.chair.texture = this.atlas.tex(`prop.chair.${exec ? "exec." : ""}${side ? "side" : "front"}`);
      d.chair.position.set(rx + R.seat + ca[0], G.floor.deskTop - 20 + ca[1]);
      const screen = now < d.flashUntil ? "flash" : seated && (side || (open && !s.submitted)) ? "on" : "off";
      d.monitor.texture = this.atlas.tex(`prop.${R.screen}.${screen}`);
    });
    this.sheets.visible = sheets > 0;
    if (sheets > 0) this.sheets.texture = this.atlas.tex(`prop.sheets.${Math.min(6, sheets)}`);
  }
}

// ------------------------------------------------------------------ lobby, street, basement

class LobbyView extends BandView {
  private readonly sign = new Container();
  private readonly doors: Sprite;
  private readonly doorName: string;
  private readonly ind: Sprite;
  private signShown = false;

  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    const ih = band.interior;
    const L = B.lobby;
    const back = this.sub("backs");
    this.rect(back, 4, 0, G.width - 8, ih, TOKENS.floor.lobby);
    this.core(back, { outlet: false });
    this.spr(back, L.logo.tile, L.logo.x, L.logo.y);
    this.spr(back, L.hrDoor.tile, L.hrDoor.x, L.hrDoor.y);
    this.spr(back, L.cafe.tile, L.cafe.x, L.cafe.y);
    for (const p of L.plants) this.spr(back, p.tile, p.x, p.y);
    this.spr(back, "lobby.table", L.cafe.table.x, L.cafe.table.y);
    for (const sx of L.cafe.stools) this.spr(back, "lobby.stool", sx, ih - 8);
    this.spr(back, L.reception.tile, L.reception.x, L.reception.y);
    back.cacheAsTexture({ scaleMode: "nearest" });
    const walls = this.sub("fronts");
    this.walls(walls, ih);
    this.slab(walls, ih);
    walls.cacheAsTexture({ scaleMode: "nearest" });
    // The street front is in front of lobby characters and behind street characters (design §4.5).
    const front = this.sub("lobbyFront");
    const glass = new Container();
    for (let i = 0; i < 4; i++) this.spr(glass, `shell.${shell}.front`, G.rooms.x + i * 72, 0);
    glass.cacheAsTexture({ scaleMode: "nearest" });
    front.addChild(glass);
    this.doorName = B.states[shell].doors;
    this.doors = this.spr(front, `${this.doorName}.0`, L.doors.x, 0);
    this.buildSign();
    front.addChild(this.sign);
    this.ind = this.indicator();
    this.plaque("Lobby");
  }

  /** The taped paper sign on the glass (design §12.5): shown whenever a crowd account is drawn. */
  private buildSign(): void {
    const s = B.lobby.crowdSign;
    this.rect(this.sign, s.x, s.y, s.w, s.h, TOKENS.ink);
    this.spr(this.sign, "prop.tape", s.x - 2, s.y - 1);
    this.spr(this.sign, "prop.tape", s.x + s.w - 3, s.y - 1);
    const a = text("SIMULATED CROWD", 4.6, { weight: "700", fill: TOKENS.bg, resolution: 10 });
    a.anchor.set(0.5, 0);
    a.position.set(s.x + s.w / 2, s.y + 4);
    const b = text("these employees are bots.", 3.7, { weight: "500", fill: TOKENS.bg, resolution: 10 });
    b.anchor.set(0.5, 0);
    b.position.set(s.x + s.w / 2, s.y + 12);
    this.sign.addChild(a, b);
    this.sign.visible = false;
  }

  update(m: SceneModel): void {
    const show = m.layout.characters.some((c) => c.crowd);
    if (show !== this.signShown) {
      this.signShown = show;
      this.sign.visible = show;
    }
  }

  override tick(): void {
    this.doors.texture = this.atlas.tex(`${this.doorName}.${this.bld.doorFrame}`);
    this.tickIndicator(this.ind);
  }
}

class StreetView extends BandView {
  private readonly box: Sprite;
  private benchMore: ScreenLabel | null = null;
  private queueMore: ScreenLabel | null = null;
  private sig = "";

  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    const S = B.street;
    const base = this.sub("lobbyFront");
    const pave = this.tile(base, "street.pavement", -SIDE, 0, G.width + SIDE * 2, G.street.h);
    pave.tilePosition.x = SIDE % 16;
    this.spr(base, S.bench.tile, S.bench.x, S.bench.y);
    this.spr(base, S.lamp.tile, S.lamp.x, S.lamp.y);
    this.box = this.spr(base, "prop.box.full", 0, 0);
    this.box.visible = false;
  }

  update(m: SceneModel): void {
    const S = B.street;
    const bench = m.layout.bench;
    const queue = m.layout.visitors;
    const sig = `${bench.length}|${queue.length}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const n = Math.min(4, bench.length);
    this.box.visible = n > 0;
    if (n > 0) this.box.position.set(S.bench.seats[n - 1]! + 15, S.bench.y + 4 - 9);
    this.benchMore?.destroy({ children: true });
    this.queueMore?.destroy({ children: true });
    this.benchMore = this.queueMore = null;
    if (bench.length > 4) {
      const l = new ScreenLabel();
      l.addChild(text(`+${bench.length - 4}`, 11));
      this.benchMore = this.screenLabel(l, S.bench.x - 12, S.standY - 14);
    }
    if (queue.length > 5) {
      const l = new ScreenLabel();
      const t = text(`+${queue.length - 5}`, 11);
      t.anchor.set(1, 0);
      l.addChild(t);
      this.queueMore = this.screenLabel(l, S.queue.spots[4]! - 3, S.standY - 14);
    }
  }
}

class BasementView extends BandView {
  private readonly fill: Sprite;
  private readonly pile: Sprite;
  private readonly rack0: Sprite;
  private readonly door: Sprite;
  private sig = "";
  private low = false;
  private reserveL: ScreenLabel | null = null;
  private stalledL: ScreenLabel | null = null;

  constructor(bld: RgBuilding, band: Band, shell: ShellState) {
    super(bld, band, shell);
    const ih = band.interior;
    const V = B.basement;
    const back = this.sub("backs");
    this.rect(back, 4, 0, G.width - 8, ih, TOKENS.floor.basement);
    this.rect(back, 0, 0, 4, ih + 4, TOKENS.concreteShade);
    this.rect(back, G.width - 4, 0, 4, ih + 4, TOKENS.concreteShade);
    this.tile(back, "core.tube", G.tube.x, 0, 4, V.tubeFoot.y + 2);
    this.spr(back, V.tubeFoot.tile, V.tubeFoot.x, V.tubeFoot.y);
    this.spr(back, V.boxes.tile, V.boxes.x, V.boxes.y);
    this.spr(back, V.bar.tile, V.bar.x, V.bar.y);
    this.rect(back, V.partition.x, 0, 4, ih, TOKENS.concreteShade);
    V.racks.slice(1).forEach((r) => this.spr(back, r.tile, r.x, r.y));
    this.rect(back, 0, 0, G.width, 3, TOKENS.concreteShade);
    this.tile(back, "bldg.slab", 0, ih, G.width, G.floor.slab);
    back.cacheAsTexture({ scaleMode: "nearest" });
    const live = this.sub("tops");
    this.door = this.spr(live, V.vaultDoor.tile, V.vaultDoor.x, V.vaultDoor.y);
    this.fill = this.rect(live, V.bar.x + V.bar.fill.x, V.bar.y + V.bar.fill.y, 1, V.bar.fill.h, TOKENS.coin);
    this.pile = this.spr(live, "vault.pile.0", V.pile.x, V.pile.bottom - 18);
    this.rack0 = this.spr(live, V.racks[0]!.tile, V.racks[0]!.x, V.racks[0]!.y);
    // The vault opens the ledger (design §3).
    const hit = new Container();
    hit.hitArea = new Rectangle(V.vaultDoor.x - 4, 4, V.partition.x - V.vaultDoor.x, ih - 4);
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.bld.handlers.vault();
    });
    this.sub("hits").addChild(hit);
    this.plaque("Vault");
    const servers = new ScreenLabel();
    servers.addChild(text("Servers", 10, { weight: "400", fill: TOKENS.muted }));
    this.screenLabel(servers, V.racks[0]!.x, 4);
  }

  update(m: SceneModel): void {
    const V = B.basement;
    const v = vaultModel(m.snap.treasury, m.snap.config.reserve_low);
    const sig = `${v.reserve}|${v.runway}|${v.low}|${m.snap.stalled}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.low = v.low;
    this.fill.width = Math.max(0, Math.round(V.bar.fill.w * v.fill));
    const pileLevel = Math.round(v.fill * 5);
    this.pile.texture = this.atlas.tex(`vault.pile.${pileLevel}`);
    this.pile.y = V.pile.bottom - this.pile.texture.frame.height;
    this.rack0.texture = this.atlas.tex(m.snap.stalled ? "server.rack.stalled" : "server.rack");
    this.reserveL?.destroy({ children: true });
    // Reserve and runway as plain text under the bar (design §4.6), with a LOW tag beside it.
    const l = new ScreenLabel();
    const a = text(`Reserve ${payout(v.reserve, { digits: 1 })}`, 11);
    const runway = v.noCosts ? "No operating costs." : `Runway: ${plural(v.runway ?? 0, "task")}`;
    const b = text(runway, 10, { weight: "400", fill: v.low ? TOKENS.bad : TOKENS.muted });
    b.y = 14;
    // A backing panel like the plaques, so the text stays readable over the coin pile.
    const panel = new Graphics().roundRect(-4, -2, Math.max(a.width, b.width) + 8, 31, 3).fill({ color: TOKENS.bg, alpha: 0.72 });
    l.addChild(panel, a, b);
    if (v.low) {
      const c = chip("LOW", TOKENS.bad, TOKENS.bg);
      c.position.set(a.width + 6, 1);
      l.addChild(c);
    }
    this.reserveL = this.screenLabel(l, V.bar.x, V.bar.y + 16);
    this.stalledL?.destroy({ children: true });
    this.stalledL = m.snap.stalled ? this.screenLabel(chip("STALLED", TOKENS.bad, TOKENS.bg), V.racks[0]!.x, V.racks[0]!.y + 6) : null;
  }

  override tick(now: number, m: SceneModel): void {
    // reserve_low (design §14.3): three pulses, then the steady low state. Never > 3 flashes/s.
    const a = now - this.bld.vaultPulseStart;
    const pulsing = !m.reducedMotion && a >= 0 && a < 1500;
    const on = pulsing ? Math.floor(a / 250) % 2 === 0 : this.low;
    this.fill.tint = on ? TOKENS.bad : TOKENS.coin;
    this.door.tint = on ? TOKENS.bad : 0xffffff;
  }
}

/** Card copy helper shared with the HUD tooltip. */
export function statusLabel(c: TowerCharacter): string {
  switch (c.status) {
    case "new_hire":
      return "New hire";
    case "active":
      return c.submitted ? "Filed today" : "Active";
    case "struggling":
      return `Struggling: ${plural(c.missesInRow, "miss", "misses")} in a row`;
    case "laid_off":
      return "Laid off";
    case "visitor":
      return "Visitor";
  }
}
