/**
 * The cast (design §5.5): one controller per drawn wallet plus the boss. A controller answers
 * "where is this character at t?" from three sources in priority order: a script from the
 * director, the required behavior (home until the next slot boundary after a script), and the
 * idle schedule (life). It never decides anything about chain state. Pure: no Pixi.
 */
import { Life, slotOf, slotStart, type LifeAgent } from "../life";
import type { Nav } from "../nav";
import { RIG } from "../render/geometry";
import { unit } from "../state/rng";
import { Elevator } from "./elevator";
import { ANIM, frameAt, sample, standPose, type Anim, type Pose, type Track } from "./track";

/** A short override of the seated frame: cheer, slump, a coworker turning to look. */
export interface Reaction {
  anim?: Anim;
  frame?: string;
  mirror?: boolean;
  t0: number;
  t1: number;
}

const nextBoundary = (t: number) => slotStart(slotOf(t) + 1);

/** The home pose with its looping animation (typing at the desk, the bench, the queue shuffle). */
export function homeAt(life: Life, a: LifeAgent, t: number, phase: number): Pose {
  const p = life.home(a, t);
  if (life.world.reduced) return p; // a still pose: no typing effect (design §14.5)
  if (a.home.kind === "seat" && life.working(a, t)) p.frame = frameAt(ANIM.type, t, 0, phase);
  else if (a.home.kind === "bench") p.frame = frameAt(ANIM.bench, t, 0, phase);
  else if (a.home.kind === "queue") p.frame = frameAt(ANIM.shuffle, t, 0, phase);
  return p;
}

function sameHome(a: LifeAgent["home"], b: LifeAgent["home"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "away" || b.kind === "away") return true;
  if (a.kind === "seat" && b.kind === "seat") return a.band === b.band && a.x === b.x;
  return (a as { x: number }).x === (b as { x: number }).x;
}

export class AgentCtl {
  script: Track | null = null;
  /** Stays home until then (after a script, or while a delayed script waits to start). */
  holdUntil = -Infinity;
  reaction: Reaction | null = null;
  /** Removed from the building: fades out by then. */
  retireAt: number | null = null;
  readonly phase: number;
  private cache: { slot: number; track: Track } | null = null;

  constructor(
    readonly wallet: string,
    public agent: LifeAgent,
  ) {
    this.phase = unit(wallet, "phase") * 4;
  }

  /** New state from the model. The slot's track is kept unless home moved (no mid-slot jumps). */
  setAgent(a: LifeAgent): void {
    if (!sameHome(a.home, this.agent.home)) this.cache = null;
    this.agent = a;
  }

  /** Plays a script; until it starts the character stays home. */
  play(track: Track): void {
    this.script = track;
    this.holdUntil = track.t0;
    this.cache = null;
  }

  /** Tap to skip: the script ends now, home until the next slot boundary. */
  finish(t: number): void {
    if (!this.script) return;
    this.script = null;
    this.holdUntil = nextBoundary(t);
    this.cache = null;
  }

  busy(t: number): boolean {
    return !!this.script && t < this.script.t1;
  }

  /** The building's geometry changed: every planned position is stale. Home at once, schedule next slot. */
  relocate(t: number): void {
    this.script = null;
    this.cache = null;
    this.reaction = null;
    this.holdUntil = nextBoundary(t);
  }

  /** The state got stricter mid-slot (a task opened): home, with the home animation, until the next boundary. */
  stayHome(t: number): void {
    this.holdUntil = Math.max(this.holdUntil, nextBoundary(t));
    this.cache = null;
  }

  pose(t: number, life: Life): Pose {
    let p: Pose | null = null;
    if (this.script) {
      if (t >= this.script.t1) {
        this.holdUntil = nextBoundary(this.script.t1);
        this.script = null;
        this.cache = null;
      } else if (t >= this.script.t0) p = sample(this.script, t);
    }
    if (!p) {
      if (t < this.holdUntil) p = homeAt(life, this.agent, t, this.phase);
      else {
        const slot = slotOf(t);
        if (!this.cache || this.cache.slot !== slot) this.cache = { slot, track: life.track(this.agent, slot) };
        p = sample(this.cache.track, t);
      }
    }
    const r = this.reaction;
    if (r) {
      if (t >= r.t1) this.reaction = null;
      else if (t >= r.t0 && p.layer === "seat") p = { ...p, frame: r.anim ? frameAt(r.anim, t, r.t0) : r.frame!, mirror: r.mirror ?? false };
    }
    if (this.retireAt !== null) p = { ...p, alpha: p.alpha * Math.max(0, Math.min(1, (this.retireAt - t) / 300)) };
    return p;
  }
}

// ------------------------------------------------------------------ the boss

const P = RIG.building.penthouse.boss;
/** Boss frames are 18 px wide; the loop's x values are left edges. */
const BOSS_HALF = 9;
const BOSS_SPEED = 24;
type BossSeg = { from: number; to: number; dur: number; frame: "walk" | "face" | "side" | "sip" };

/** The penthouse loop (design §5.7: paces, looks out the window, sips). Closed-form in time. */
const BOSS_LOOP: BossSeg[] = (() => {
  const segs: BossSeg[] = [];
  let x = P.home;
  const walk = (to: number) => {
    segs.push({ from: x, to, dur: (Math.abs(to - x) / BOSS_SPEED) * 1000, frame: "walk" });
    x = to;
  };
  const hold = (dur: number, frame: BossSeg["frame"]) => segs.push({ from: x, to: x, dur, frame });
  hold(9000, "face");
  walk(P.paceTo - 24);
  hold(3000, "side");
  hold(1500, "sip");
  walk(P.window);
  hold(4000, "side");
  walk(P.paceFrom);
  hold(2500, "sip");
  hold(2000, "side");
  walk(P.home);
  hold(5000, "face");
  return segs;
})();
const BOSS_PERIOD = BOSS_LOOP.reduce((a, s) => a + s.dur, 0);
export const BOSS_HOME_X = P.home + BOSS_HALF;

export class BossCtl {
  script: Track | null = null;
  face = "boss.smile";
  /** Shifts the loop so it resumes at home after a script. */
  private offset = 0;
  private lastLeft = false;

  busy(t: number): boolean {
    return !!this.script && t < this.script.t1;
  }

  play(track: Track): void {
    this.script = track;
  }

  finish(t: number): void {
    if (this.script) this.resumeAt(t);
    this.script = null;
  }

  private resumeAt(t: number): void {
    this.offset = ((-t % BOSS_PERIOD) + BOSS_PERIOD) % BOSS_PERIOD;
  }

  pose(t: number, nav: Nav): Pose {
    if (this.script) {
      if (t >= this.script.t1) {
        this.resumeAt(this.script.t1);
        this.script = null;
      } else if (t >= this.script.t0) return this.map(sample(this.script, t));
    }
    let lt = (((t + this.offset) % BOSS_PERIOD) + BOSS_PERIOD) % BOSS_PERIOD;
    let seg = BOSS_LOOP[0]!;
    for (const s of BOSS_LOOP) {
      if (lt < s.dur) {
        seg = s;
        break;
      }
      lt -= s.dur;
    }
    const p = seg.dur ? lt / seg.dur : 0;
    const x = seg.from + (seg.to - seg.from) * p;
    if (seg.frame === "walk") this.lastLeft = seg.to < seg.from;
    const frame = seg.frame === "walk" ? frameAt(ANIM.bossWalk, t, 0) : seg.frame === "face" ? this.face : seg.frame === "sip" ? "boss.sip" : "boss.stand.side";
    return standPose(nav, "penthouse", Math.round(x + BOSS_HALF), frame, seg.frame === "face" ? false : this.lastLeft);
  }

  /** Script poses use employee frame names; the boss has its own. */
  private map(p: Pose): Pose {
    let frame = p.frame;
    if (frame.startsWith("emp.walk.") || frame.startsWith("emp.carry.")) frame = `boss.walk.${frame.slice(-1)}`;
    else if (frame === "emp.stand.side") frame = "boss.stand.side";
    else if (frame.startsWith("emp.")) frame = this.face;
    return { ...p, frame };
  }
}

// ------------------------------------------------------------------ the cast

export class Cast {
  readonly ctls = new Map<string, AgentCtl>();
  readonly boss = new BossCtl();
  elevator: Elevator;
  /** Lobby door open intervals (someone steps through). */
  private doors: [number, number][] = [];

  constructor(
    public nav: Nav,
    public life: Life,
  ) {
    this.elevator = new Elevator(nav);
  }

  /** A new building geometry (floors added or removed): scripts in flight end where they were going. */
  reset(nav: Nav, life: Life, t: number): void {
    this.nav = nav;
    this.life = life;
    this.elevator = new Elevator(nav);
    for (const c of this.ctls.values()) c.relocate(t);
    this.boss.finish(t);
    this.doors = [];
  }

  play(wallet: string, track: Track): void {
    this.ctls.get(wallet)?.play(track);
    this.noteDoors(track);
  }

  playBoss(track: Track): void {
    this.boss.play(track);
    this.noteDoors(track);
  }

  private noteDoors(track: Track): void {
    for (const s of track.segs) if (s.kind === "step") this.doors.push([s.t0 - 350, s.t1 + 350]);
  }

  /** Lobby door frame at `t`: open while someone steps through. */
  doorFrame(t: number): 0 | 1 | 2 {
    let best: 0 | 1 | 2 = 0;
    for (const [a, b] of this.doors) {
      if (t < a - 200 || t > b + 200) continue;
      if (t >= a && t <= b) return 2;
      best = 1;
    }
    return best;
  }

  poseOf(wallet: string, t: number): Pose | null {
    return this.ctls.get(wallet)?.pose(t, this.life) ?? null;
  }

  /** Tap to skip (design §14.1 rule 4): every script jumps to its end. */
  skip(t: number): void {
    for (const c of this.ctls.values()) {
      c.finish(t);
      c.reaction = null;
    }
    this.boss.finish(t);
    this.elevator.clear();
    this.doors = [];
  }

  prune(t: number): void {
    this.elevator.prune(t);
    if (this.doors.length) this.doors = this.doors.filter(([, b]) => b > t - 1000);
  }
}
