/**
 * Agent motion (design §5.5, §14.1–§14.2): a track is a list of timed segments (hold, walk,
 * climb, step, ride, fade) in absolute wall-clock ms; `sample(track, t)` gives the pose at any
 * moment, so a track is a closed-form function of time. Scripts (the director) and the idle
 * schedule (life) both produce tracks with the `Plan` builder. Pure: no Pixi.
 */
import { G, RIG } from "../render/geometry";
import { Elevator, BOARD_MS, type Ride } from "./elevator";
import { DOOR_MS, legMs, POINTS, RUN, STAIRS, WALK, type Leg, type Loc, type Nav } from "../nav";

/** Where a character is drawn (design §4.1): seated behind desk fronts, in the aisle, in the cab, or on the sidewalk. */
export type Layer = "seat" | "aisle" | "cab" | "street";
/** Something carried at the hand point (design §5.2). */
export type Prop = "paper" | "plant" | null;

export interface Pose {
  band: string;
  /** Center x and feet y, world sprite px. */
  x: number;
  y: number;
  frame: string;
  mirror: boolean;
  layer: Layer;
  prop: Prop;
  alpha: number;
}

export interface Anim {
  frames: readonly string[];
  /** Frames per second. */
  fps: number;
  loop: boolean;
}

const A = (name: string, loop?: boolean): Anim => {
  const a = RIG.animations[name]!;
  return { frames: a.frames, fps: a.fps, loop: loop ?? a.loop !== false };
};

/** The animation set (design §5.2, art/README.md). */
export const ANIM = {
  type: A("emp.type"),
  walk: A("emp.walk"),
  run: A("emp.run"),
  carry: A("emp.carry"),
  climb: A("emp.climb"),
  drink: A("emp.drink"),
  chat: A("emp.chat"),
  stretch: { frames: ["emp.stretch.0", "emp.stretch.1", "emp.stretch.1", "emp.stretch.0"], fps: 2, loop: false },
  bench: A("emp.bench"),
  shuffle: A("emp.visitor.shuffle"),
  cheer: { frames: ["emp.cheer.0", "emp.cheer.1", "emp.cheer.0", "emp.cheer.1"], fps: 3.33, loop: false },
  slump: { frames: ["emp.slump.0", "emp.slump.1", "emp.slump.1", "emp.slump.1"], fps: 3.33, loop: false },
  bossWalk: A("boss.walk"),
  bossRun: { ...A("boss.walk"), fps: 12 },
} satisfies Record<string, Anim>;

/** The frame of `anim` at `t`. Loops run on the wall clock (plus a per-agent phase); one-shots from `t0`. */
export function frameAt(anim: Anim, t: number, t0: number, phase = 0): string {
  const n = anim.frames.length;
  if (anim.loop) return anim.frames[((Math.floor((t / 1000) * anim.fps + phase) % n) + n) % n]!;
  const i = Math.floor(((t - t0) / 1000) * anim.fps);
  return anim.frames[Math.max(0, Math.min(n - 1, i))]!;
}

export type Seg =
  | { kind: "hold"; t0: number; t1: number; pose: Pose; anim?: Anim; phase?: number }
  | { kind: "walk"; t0: number; t1: number; band: string; y: number; x0: number; x1: number; layer: Layer; anim: Anim; prop: Prop; phase: number }
  /** Stairs between a band and the one above it; `y` is the lower band's floor line. */
  | { kind: "climb"; t0: number; t1: number; lower: string; upper: string; y: number; up: boolean; phase: number }
  /** Lobby door ↔ sidewalk. */
  | { kind: "step"; t0: number; t1: number; up: boolean; x: number; lobbyY: number; streetY: number }
  /** Wait at the door, ride, step out. `t0` = arrival at the door; `t1` = out of the cab. */
  | { kind: "ride"; t0: number; t1: number; ride: Ride; slot: number }
  /** Reduced motion: a 100 ms fade from one place to another (design §14.5). */
  | { kind: "fade"; t0: number; t1: number; a: Pose; b: Pose };

export interface Track {
  segs: Seg[];
  t0: number;
  t1: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const progress = (s: { t0: number; t1: number }, t: number) => (s.t1 > s.t0 ? clamp01((t - s.t0) / (s.t1 - s.t0)) : 1);

function segPose(s: Seg, t: number): Pose {
  switch (s.kind) {
    case "hold":
      return s.anim ? { ...s.pose, frame: frameAt(s.anim, t, s.t0, s.phase) } : s.pose;
    case "walk": {
      const p = progress(s, t);
      return {
        band: s.band,
        x: s.x0 + (s.x1 - s.x0) * p,
        y: s.y,
        frame: frameAt(s.anim, t, s.t0, s.phase),
        mirror: s.x1 < s.x0,
        layer: s.layer,
        prop: s.prop,
        alpha: 1,
      };
    }
    case "climb": {
      const p = s.up ? progress(s, t) : 1 - progress(s, t);
      // Lower flight rises to the right to the landing, the upper flight back to the left, ending
      // on the next floor's line one pitch up (art/building.mjs stairs()).
      const split = 0.54;
      const L = STAIRS.landing;
      const landDy = L.y - G.floor.h;
      const topDy = -G.floor.pitch;
      let x: number;
      let dy: number;
      let rightward: boolean;
      if (p < split) {
        const q = p / split;
        x = STAIRS.foot + (L.x - STAIRS.foot) * q;
        dy = landDy * q;
        rightward = s.up;
      } else {
        const q = (p - split) / (1 - split);
        x = L.x + (STAIRS.foot - L.x) * q;
        dy = landDy + (topDy - landDy) * q;
        rightward = !s.up;
      }
      return { band: p < 0.5 ? s.lower : s.upper, x, y: s.y + dy, frame: frameAt(ANIM.climb, t, s.t0, s.phase), mirror: !rightward, layer: "aisle", prop: null, alpha: 1 };
    }
    case "step": {
      const p = s.up ? 1 - progress(s, t) : progress(s, t);
      const bob = Math.floor(t / 100) % 2;
      return {
        band: p < 0.5 ? "lobby" : "street",
        x: s.x,
        y: s.lobbyY + (s.streetY - s.lobbyY) * p - bob,
        frame: "emp.stand.front",
        mirror: false,
        // Out through the doors: behind the street front until halfway, then in front of it.
        layer: p < 0.5 ? "aisle" : "street",
        prop: null,
        alpha: 1,
      };
    }
    case "ride": {
      const r = s.ride;
      const cabX = POINTS.cab + (s.slot - (r.riders - 1) / 2) * 4;
      if (t < r.tBoard) return { band: r.from, x: POINTS.elevator, y: r.fromY, frame: "emp.stand.side", mirror: true, layer: "aisle", prop: null, alpha: 1 };
      if (t < r.tArrive + DOOR_MS + BOARD_MS / 2) {
        return { band: t < r.tArrive ? r.from : r.to, x: cabX, y: Elevator.rideY(r, t), frame: "emp.stand.front", mirror: false, layer: "cab", prop: null, alpha: 1 };
      }
      return { band: r.to, x: POINTS.elevator, y: r.toY, frame: "emp.stand.side", mirror: false, layer: "aisle", prop: null, alpha: 1 };
    }
    case "fade": {
      const p = progress(s, t);
      return p < 0.5 ? { ...s.a, alpha: s.a.alpha * (1 - 2 * p) } : { ...s.b, alpha: s.b.alpha * (2 * p - 1) };
    }
  }
}

/** The pose on `track` at `t` (clamped to its ends). */
export function sample(track: Track, t: number): Pose {
  const segs = track.segs;
  if (segs.length === 0) throw new Error("empty track");
  if (t <= segs[0]!.t0) return segPose(segs[0]!, segs[0]!.t0);
  for (const s of segs) if (t < s.t1) return segPose(s, Math.max(t, s.t0));
  const last = segs[segs.length - 1]!;
  return segPose(last, last.t1);
}

/** Seated home pose (the desk top), facing out. */
export function seatPose(nav: Nav, band: string, x: number, frame = "emp.sit.front"): Pose {
  return { band, x, y: nav.band(band).seatY, frame, mirror: false, layer: "seat", prop: null, alpha: 1 };
}

/** Standing in an aisle (or on the sidewalk). */
export function standPose(nav: Nav, band: string, x: number, frame = "emp.stand.front", mirror = false): Pose {
  return { band, x, y: nav.band(band).floorY, frame, mirror, layer: band === "street" ? "street" : "aisle", prop: null, alpha: 1 };
}

export interface GoOpts {
  run?: boolean;
  elevator?: boolean;
  prop?: Prop;
  /** Carry the layoff box (emp.carry). */
  box?: boolean;
  /** Squeeze the path (rides excepted) into at most this many ms (the rush, design §14.3). */
  within?: number;
  /** Walk cycle override (the boss walks with its own frames). */
  anim?: Anim;
}

/**
 * Builds a track step by step from a start pose. Every step starts where the last one ended, so
 * a plan is continuous. Rides are booked on the elevator when they are planned.
 */
export class Plan {
  readonly segs: Seg[] = [];
  private pose: Pose;
  t: number;

  constructor(
    private readonly nav: Nav,
    readonly t0: number,
    start: Pose,
    private readonly elevator: Elevator | null = null,
    /** Walk-cycle phase, so neighbours do not step in lockstep. */
    private readonly phase = 0,
    /** Reduced motion: moves become 100 ms fades (design §14.5). */
    readonly reduced = false,
  ) {
    this.t = t0;
    this.pose = { ...start };
  }

  get at(): Pose {
    return this.pose;
  }

  get seated(): boolean {
    return this.pose.layer === "seat";
  }

  /** Holds a pose (or an animation) for `ms`. */
  hold(ms: number, frame?: string | Anim, opts: { mirror?: boolean; prop?: Prop } = {}): this {
    if (ms <= 0) return this;
    const pose: Pose = { ...this.pose };
    if (opts.mirror !== undefined) pose.mirror = opts.mirror;
    if (opts.prop !== undefined) pose.prop = opts.prop;
    let anim: Anim | undefined;
    if (typeof frame === "string") pose.frame = frame;
    else if (frame) anim = frame;
    this.segs.push(anim ? { kind: "hold", t0: this.t, t1: this.t + ms, pose, anim, phase: this.phase } : { kind: "hold", t0: this.t, t1: this.t + ms, pose });
    this.t += ms;
    this.pose = anim && !anim.loop ? { ...pose, frame: anim.frames[anim.frames.length - 1]! } : pose;
    return this;
  }

  /** Holds until absolute time `t` (no-op if already past it). */
  until(t: number, frame?: string | Anim, opts: { mirror?: boolean } = {}): this {
    return this.hold(t - this.t, frame, opts);
  }

  /** Anticipation (design §14.1 rule 6): a seated character rises before it walks. */
  rise(ms = 200): this {
    if (!this.seated) return this;
    this.pose = standPose(this.nav, this.pose.band, this.pose.x);
    return this.hold(ms, "emp.stand.front");
  }

  /** Sits down where it stands: a beat standing, then the one-frame squash (design §14.1). */
  sit(frame = "emp.sit.front"): this {
    if (this.seated) return this;
    if (this.reduced) {
      this.pose = seatPose(this.nav, this.pose.band, this.pose.x, frame);
      return this;
    }
    this.hold(120, "emp.stand.front", { mirror: false });
    this.pose = seatPose(this.nav, this.pose.band, this.pose.x, "emp.sit.land");
    this.hold(160, "emp.sit.land");
    this.pose = seatPose(this.nav, this.pose.band, this.pose.x, frame);
    return this;
  }

  /** Jumps to a pose without a segment (the next segment starts there). */
  place(p: Pose): this {
    this.pose = { ...p };
    return this;
  }

  /** Walks (or runs) to a location by the stairs, the elevator and the lobby door. */
  go(to: Loc, opts: GoOpts = {}): this {
    if (this.reduced) return this.fadeTo(standPose(this.nav, to.band, to.x));
    this.rise();
    const speed = opts.run ? RUN : WALK;
    const legs = this.nav.path({ band: this.pose.band, x: this.pose.x }, to, { speed, ...(opts.elevator ? { elevator: true } : {}) });
    let scale = 1;
    if (opts.within) {
      const total = legs.reduce((a, l) => a + (legMs(l) ?? 0), 0);
      if (total > opts.within) scale = opts.within / total;
    }
    const anim = opts.anim ?? (opts.box ? ANIM.carry : opts.run ? ANIM.run : ANIM.walk);
    const prop = opts.prop ?? null;
    for (const leg of legs) this.leg(leg, scale, anim, prop);
    this.pose = { ...this.pose, prop };
    return this;
  }

  private leg(leg: Leg, scale: number, anim: Anim, prop: Prop): void {
    const t0 = this.t;
    switch (leg.kind) {
      case "walk": {
        const dur = (legMs(leg) ?? 0) * scale;
        const layer = leg.band === "street" ? "street" : "aisle";
        const y = this.nav.band(leg.band).floorY;
        this.segs.push({ kind: "walk", t0, t1: t0 + dur, band: leg.band, y, x0: leg.x0, x1: leg.x1, layer, anim, prop, phase: this.phase });
        this.t += dur;
        this.pose = { band: leg.band, x: leg.x1, y, frame: "emp.stand.side", mirror: leg.x1 < leg.x0, layer, prop, alpha: 1 };
        return;
      }
      case "climb": {
        const dur = leg.dur * scale;
        const y = this.nav.band(leg.lower).floorY;
        this.segs.push({ kind: "climb", t0, t1: t0 + dur, lower: leg.lower, upper: leg.upper, y, up: leg.up, phase: this.phase });
        this.t += dur;
        const band = leg.up ? leg.upper : leg.lower;
        this.pose = standPose(this.nav, band, STAIRS.foot, "emp.stand.side");
        return;
      }
      case "step": {
        const dur = leg.dur * scale;
        this.segs.push({ kind: "step", t0, t1: t0 + dur, up: leg.up, x: POINTS.lobby.door, lobbyY: this.nav.band("lobby").floorY, streetY: this.nav.band("street").floorY });
        this.t += dur;
        this.pose = standPose(this.nav, leg.up ? "lobby" : "street", POINTS.lobby.door, "emp.stand.front");
        return;
      }
      case "ride": {
        if (!this.elevator) throw new Error("plan: a ride needs the elevator");
        const { ride, slot } = this.elevator.book(leg.from, leg.to, t0, this.t0);
        const t1 = ride.tArrive + DOOR_MS + BOARD_MS;
        this.segs.push({ kind: "ride", t0, t1, ride, slot });
        this.t = t1;
        this.pose = standPose(this.nav, leg.to, POINTS.elevator, "emp.stand.side");
        return;
      }
    }
  }

  /** Reduced motion: fade out here and in there (100 ms). */
  fadeTo(p: Pose): this {
    this.segs.push({ kind: "fade", t0: this.t, t1: this.t + 100, a: { ...this.pose }, b: { ...p } });
    this.t += 100;
    this.pose = { ...p };
    return this;
  }

  build(): Track {
    if (this.segs.length === 0) this.hold(1);
    return { segs: this.segs, t0: this.t0, t1: this.t };
  }
}
