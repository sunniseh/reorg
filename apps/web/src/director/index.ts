/**
 * The event director (roadmap W-08, design §14.1–§14.3): turns changes between two models into
 * agent scripts and timed effects. Meaning comes only from chain state and its changes: a task
 * opening (the rush), a submission (the walk to the outbox), a finalize (results, rehires,
 * payday, layoffs, then the boss's summary), new hires, promotions and layout shifts.
 *
 * Late joiners see current state: the first model plays nothing. A finalize plays as one
 * choreography (§14.3.1, steps ≤ 8 s); walks are non-blocking. More than 20 moves in one update
 * jump straight to the final state (§14.1 rule 3). Pure: no Pixi; effects go through `DirectorFx`.
 */
import type { TowerCharacter, TowerLayout } from "@reorg/core";
import { AgentCtl, BOSS_HOME_X, Cast } from "../agents/cast";
import { ANIM, Plan, standPose, type Pose } from "../agents/track";
import { Life, type Home, type LifeAgent, type LifeTask } from "../life";
import { POINTS, WALK, type Nav } from "../nav";
import { bossFace } from "../render/derive";
import { RIG } from "../render/geometry";
import { effectiveStatus, nsToMs, type Snapshot } from "../state/types";

const S = RIG.building.street;

/** The rush: everyone away from their desk is seated within this (design §14.3). */
export const RUSH_MS = 3000;
/** Above this many moves in one update, skip to the final state (design §14.1 rule 3). */
export const MAX_MOVES = 20;
/** Cross-floor moves above this take the stairs instead of queueing for the elevator. */
const MAX_RIDES = 6;
/** Finalize choreography offsets (design §14.3.1). */
export const STEP = { results: 0, rehires: 1500, payday: 2000, layoffs: 4800, summary: 5600 } as const;
/** Stagger in payroll bucket order (design §14.1 rule 5). */
export const STAGGER_MS = 150;

export interface DirectorModel {
  layout: TowerLayout;
  snap: Snapshot;
  now: number;
  animate: boolean;
  reducedMotion: boolean;
}

/** What the director asks the renderer to do. */
export interface DirectorFx {
  /** Task opened: the alarm pulses three times. */
  alarm(at: number): void;
  /** The desk shows its new state (dot, streak, dim, NEW…) from `at` on; until then the previous one. */
  deskAt(wallet: string, at: number): void;
  /** The desk's status (dimmed with the box, or bright again) switches at `at`: when the character leaves or sits. */
  statusAt(wallet: string, at: number): void;
  /** A carried sheet reaches the floor's outbox. */
  outboxAt(wallet: string, at: number): void;
  /** A coin rises through the tube and lands on the desk shortly after `at`. */
  payday(wallet: string, pay: bigint, at: number): void;
  /** The boss's next bubble shows no earlier than `at`. */
  bubbleAt(at: number): void;
  /** Low reserve: the vault pulses three times. */
  vaultPulse(at: number): void;
  /** Too much changed at once: everyone jumped to the final state (design §14.1 rule 3). */
  caughtUp?(moves: number): void;
}

/** Where each drawn character lives (design §5.3): its desk, a bench seat, a queue spot. */
export function homesOf(layout: TowerLayout, nav: Nav): Map<string, LifeAgent> {
  const out = new Map<string, LifeAgent>();
  layout.floors.forEach((f) =>
    f.desks.forEach((c, room) => {
      if (!c || c.status === "laid_off") return;
      out.set(c.wallet, { wallet: c.wallet, home: { kind: "seat", band: f.key, x: nav.seatX(f.tier, room) }, submitted: c.submitted });
    }),
  );
  layout.bench.forEach((c, i) => out.set(c.wallet, { wallet: c.wallet, home: i < 4 ? { kind: "bench", x: S.bench.seats[i]! + 8 } : { kind: "away" }, submitted: c.submitted }));
  layout.visitors.forEach((c, i) => out.set(c.wallet, { wallet: c.wallet, home: i < 5 ? { kind: "queue", x: S.queue.spots[i]! + 8 } : { kind: "away" }, submitted: false }));
  return out;
}

export function lifeTask(snap: Snapshot): LifeTask | null {
  const t = snap.task;
  return t ? { id: t.id, status: t.status, closesAt: nsToMs(t.closes_at) } : null;
}

export function lifeOf(nav: Nav, snap: Snapshot, homes: Map<string, LifeAgent>, reduced = false): Life {
  const roster = new Map<string, LifeAgent[]>();
  for (const a of homes.values()) if (a.home.kind === "seat") roster.set(a.home.band, [...(roster.get(a.home.band) ?? []), a]);
  return new Life({ nav, task: lifeTask(snap), nextOpenAt: snap.nextOpenAt, roster, reduced });
}

type Seat = Extract<Home, { kind: "seat" }>;
type Planner = (w: string, at?: number) => Plan | null;

export class Director {
  private homes = new Map<string, LifeAgent>();
  private chars = new Map<string, TowerCharacter>();
  private nav: Nav | null = null;
  /** Moves planned in the current update (for the catch-up cap). */
  private moves = 0;

  constructor(
    readonly cast: Cast,
    private readonly fx: DirectorFx,
  ) {}

  /** Applies a new model; `nav` is the building's current geometry. */
  apply(prev: DirectorModel | null, next: DirectorModel, nav: Nav): void {
    const t = next.now;
    // Where everyone is before this change: scripts start there (homes are about to move). When
    // floors were added or removed, bands moved: carry each pose over by its band's shift.
    const posesBefore = new Map<string, Pose>();
    const oldNav = this.nav;
    const geometryChanged = !!oldNav && oldNav !== nav;
    if (oldNav) {
      for (const [w, c] of this.cast.ctls) {
        const p = c.pose(t, this.cast.life);
        if (!geometryChanged) posesBefore.set(w, p);
        else if (oldNav.has(p.band) && nav.has(p.band)) {
          const b = nav.band(p.band);
          posesBefore.set(w, p.layer === "cab" ? standPose(nav, p.band, POINTS.elevator) : { ...p, y: p.y + b.top - oldNav.band(p.band).top });
        }
      }
    }
    const homes = homesOf(next.layout, nav);
    const life = lifeOf(nav, next.snap, homes, next.reducedMotion);
    if (this.nav !== nav) this.cast.reset(nav, life, t);
    else this.cast.life = life;
    this.nav = nav;
    const before = this.homes;
    const was = this.chars;
    const chars = new Map(next.layout.characters.map((c) => [c.wallet, c]));
    this.homes = homes;
    this.chars = chars;

    // Controllers: new ones start at home; removed ones fade out.
    for (const [w, a] of homes) {
      const ctl = this.cast.ctls.get(w);
      if (ctl) {
        ctl.retireAt = null;
        ctl.setAgent(a);
      } else this.cast.ctls.set(w, new AgentCtl(w, a));
    }
    for (const [w, ctl] of this.cast.ctls) {
      if (homes.has(w)) continue;
      if (!prev || !next.animate) this.cast.ctls.delete(w);
      else if (ctl.retireAt === null) ctl.retireAt = t + 300;
    }
    this.cast.boss.face = bossFace(next.snap.lastFinalizedTask);
    // Reduced motion switched: everyone settles home at once (design §14.5).
    if (prev && prev.reducedMotion !== next.reducedMotion) {
      for (const c of this.cast.ctls.values()) {
        c.finish(t);
        c.stayHome(t);
      }
    }
    if (!prev || !next.animate || was.size === 0) return;

    const P = prev.snap;
    const N = next.snap;
    const reduced = next.reducedMotion;
    this.moves = 0;
    const plans: [string, Plan][] = [];
    // A script starts now from where the character is, and holds there until `at`.
    const plan: Planner = (w, at = t) => {
      const ctl = this.cast.ctls.get(w);
      if (!ctl) return null;
      const from = posesBefore.get(w) ?? ctl.pose(t, this.cast.life);
      const p = new Plan(nav, t, from, this.cast.elevator, ctl.phase, reduced);
      if (at > t) p.until(at, from.frame.startsWith("emp.bench") ? ANIM.bench : from.frame.startsWith("emp.type") ? "emp.sit.front" : from.frame);
      plans.push([w, p]);
      return p;
    };

    // 1. A task opened: the alarm and the rush (design §14.3).
    const opened = !!N.task && N.task.id !== P.task?.id && effectiveStatus(N.task, t) === "open";
    if (opened) {
      this.fx.alarm(t);
      for (const [w, a] of homes) {
        if (a.home.kind !== "seat") continue;
        const ctl = this.cast.ctls.get(w)!;
        if (ctl.busy(t)) continue;
        if (atHome(ctl.pose(t, this.cast.life), a.home)) {
          ctl.stayHome(t); // typing starts now
          continue;
        }
        plan(w)!.go({ band: a.home.band, x: a.home.x }, { run: true, within: RUSH_MS - 400 }).sit("emp.type.0");
      }
    }

    // 2. The finalize choreography (design §14.3.1).
    const finalized = !!N.task && N.task.status === "finalized" && !(P.task?.id === N.task.id && P.task.status === "finalized");
    const t0 = t + 200;
    if (finalized) {
      this.fx.bubbleAt(t0 + (reduced ? 0 : STEP.summary));
      // Everyone is already seated (results pending is desk-only); anyone still out runs home.
      for (const [w, a] of homes) {
        if (a.home.kind !== "seat" || !before.has(w)) continue;
        const ctl = this.cast.ctls.get(w)!;
        if (ctl.busy(t) || atHome(ctl.pose(t, this.cast.life), a.home)) continue;
        plan(w)?.go({ band: a.home.band, x: a.home.x }, { run: true, within: 1200 }).sit();
      }
    }

    // 3. Per character.
    const layoffs: { w: string; c: TowerCharacter; seat: Seat | null }[] = [];
    for (const [w, c] of chars) {
      const old = was.get(w);
      const a = homes.get(w)!;
      const b = before.get(w);
      const tierDelay = (c.tier ?? 3) * STAGGER_MS;
      if (!old || !b) {
        this.arrive(w, a, plan, t);
        continue;
      }
      // Results, streaks and pay (finalize).
      const results = finalized && !!c.result && !old.result;
      if (results) {
        const at = t0 + STEP.results + tierDelay;
        this.fx.deskAt(w, at);
        const ctl = this.cast.ctls.get(w);
        if (ctl) ctl.reaction = { anim: c.result === "pass" ? ANIM.cheer : ANIM.slump, t0: at + 100, t1: at + 1300 };
        if (c.pay > 0n && old.pay === 0n) this.fx.payday(w, c.pay, t0 + (reduced ? 0 : STEP.payday) + tierDelay * 2);
      }
      // A submission: the paper lands, then the walk to the outbox (design §14.3).
      if (c.submitted && !old.submitted && a.home.kind === "seat") {
        this.fx.deskAt(w, t);
        this.submitWalk(w, a.home, N, plan, t);
        continue;
      }
      if (sameHome(a.home, b.home)) {
        if (!results) this.fx.deskAt(w, t);
        continue;
      }
      // Home moved.
      if (c.status === "laid_off" && old.status !== "laid_off") {
        const seat = b.home.kind === "seat" ? b.home : null;
        if (finalized) layoffs.push({ w, c, seat });
        else this.layoff(w, a.home, plan, t, null);
        continue;
      }
      if (a.home.kind === "seat" && b.home.kind === "bench") {
        // Rehire: from the bench, through the front door, up the elevator, to the desk.
        const p = plan(w, finalized ? t0 + (reduced ? 0 : STEP.rehires) : t);
        if (p) {
          p.go({ band: a.home.band, x: a.home.x }, { elevator: true }).sit();
          this.fx.statusAt(w, p.t);
          this.moves++;
        }
        continue;
      }
      if (a.home.kind === "seat" && b.home.kind === "seat") {
        this.reseat(w, c, old, a.home, b.home, plan, t);
        continue;
      }
      // Queue and bench shuffles, visitor → employee, employee → visitor.
      this.fx.deskAt(w, t);
      const p = plan(w);
      if (!p) continue;
      if (a.home.kind === "seat") {
        p.go({ band: a.home.band, x: a.home.x }, { elevator: true }).sit();
        this.moves++;
      } else {
        p.go(homeLoc(a.home), { elevator: b.home.kind === "seat" });
        if (a.home.kind === "away") p.fadeTo({ ...standPose(nav, "street", POINTS.street.edge), alpha: 0 });
        if (b.home.kind === "seat") this.moves++;
      }
    }

    // 4. Layoffs: the boss rides down to the first floor with one and points (design §14.3).
    if (layoffs.length) {
      layoffs.sort((x, y) => (x.c.tier ?? 0) - (y.c.tier ?? 0));
      const start = t0 + (reduced ? 0 : STEP.layoffs);
      const firstSeat = layoffs.find((l) => l.seat)?.seat ?? null;
      let point: { band: string; at: number } | null = null;
      if (!reduced && firstSeat && !this.cast.boss.busy(t0)) {
        // The boss heads down as the results land; the walk-out starts once it points.
        const xs = layoffs.filter((l) => l.seat?.band === firstSeat.band).map((l) => l.seat!.x);
        point = this.bossVisit(firstSeat.band, Math.min(...xs), t0 + 600, layoffs.map((l) => l.w));
      }
      for (const l of layoffs) this.layoff(l.w, homes.get(l.w)!.home, plan, point && l.seat?.band === point.band ? Math.max(start, point.at) : start, point && l.seat?.band === point.band ? point.at : null);
    }

    // Floors moved under people who were away from home: they carry on home from where they are.
    if (geometryChanged) {
      const planned = new Set(plans.map(([w]) => w));
      for (const [w, a] of homes) {
        const from = posesBefore.get(w);
        if (planned.has(w) || !from || atHomeOf(from, a.home)) continue;
        const p = plan(w);
        if (!p) continue;
        if (a.home.kind === "seat") p.go({ band: a.home.band, x: a.home.x }, { elevator: from.band === "street" || from.band === "penthouse" }).sit();
        else p.go(homeLoc(a.home), { elevator: from.band !== "lobby" && from.band !== "street" });
      }
    }

    // Catch-up (design §14.1 rule 3): too much at once jumps to the final state.
    if (this.moves > MAX_MOVES) {
      for (const [w] of plans) {
        this.fx.deskAt(w, t);
        this.fx.statusAt(w, t);
      }
      this.cast.skip(t);
      this.fx.caughtUp?.(this.moves);
    } else for (const [w, p] of plans) this.cast.play(w, p.build());

    // 5. Low reserve: the vault pulses (design §14.3).
    if (lowOf(N) && !lowOf(P)) this.fx.vaultPulse(t);
  }

  /** Tap to skip: scripts end, desks show their new state. */
  skip(t: number): void {
    this.cast.skip(t);
    for (const w of this.homes.keys()) {
      this.fx.deskAt(w, t);
      this.fx.statusAt(w, t);
    }
  }

  // ---------------------------------------------------------------- moments

  /** Someone not drawn before: a new hire walks in from the street, a visitor joins the queue. */
  private arrive(w: string, a: LifeAgent, plan: Planner, t: number): void {
    this.fx.deskAt(w, t);
    if (a.home.kind === "away") return;
    const p = plan(w);
    if (!p) return;
    p.place(standPose(this.nav!, "street", POINTS.street.edge, "emp.walk.0", true));
    p.go(homeLoc(a.home), { elevator: true });
    if (a.home.kind === "seat") {
      p.sit();
      this.fx.deskAt(w, p.t);
    }
    this.moves++;
  }

  /** The submit walk: carry a sheet to the floor's outbox, then free to roam (design §14.3). */
  private submitWalk(w: string, seat: Seat, snap: Snapshot, plan: Planner, t: number): void {
    const ctl = this.cast.ctls.get(w);
    const p = ctl && !ctl.busy(t) ? plan(w) : null;
    if (!p || p.reduced) {
      this.fx.outboxAt(w, t);
      return;
    }
    // Back at the desk before the window closes: run if a walk would not make it.
    const closes = snap.task ? nsToMs(snap.task.closes_at) : Infinity;
    const stand = POINTS.outbox - 6;
    const run = t + 1800 + (2 * Math.abs(stand - seat.x) * 1000) / WALK > closes - 500;
    p.hold(450, "emp.sit.front"); // the monitor flash and the stamped paper landing
    p.go({ band: seat.band, x: stand }, { prop: "paper", run });
    this.fx.outboxAt(w, p.t + 250);
    p.hold(500, "emp.stand.side", { mirror: false, prop: null });
    p.go({ band: seat.band, x: seat.x }, { run }).sit();
  }

  /** Same-floor shifts walk; other floors ride (promotions carry the plant) or take the stairs. */
  private reseat(w: string, c: TowerCharacter, old: TowerCharacter, to: Seat, from: Seat, plan: Planner, t: number): void {
    this.fx.deskAt(w, t);
    const p = plan(w);
    if (!p) return;
    if (to.band === from.band) {
      p.go({ band: to.band, x: to.x }).sit();
      return;
    }
    const promotion = c.tier !== old.tier;
    p.go({ band: to.band, x: to.x }, { elevator: promotion && this.moves < MAX_RIDES, prop: promotion ? "plant" : null }).sit();
    this.moves++;
  }

  /**
   * A layoff: (the boss points,) the character packs the box, rides down, crosses the lobby, goes
   * out the front door and sits on the bench; the desk dims as it leaves.
   */
  private layoff(w: string, home: Home, plan: Planner, at: number, pointAt: number | null): void {
    const p = plan(w, at);
    if (!p) {
      this.fx.statusAt(w, at);
      return;
    }
    if (pointAt !== null) p.until(pointAt + 300, "emp.sit.front").hold(1200, ANIM.slump);
    if (!p.reduced) p.rise().hold(700, "emp.stand.front");
    this.fx.statusAt(w, p.t);
    if (home.kind === "bench") {
      p.go({ band: "street", x: home.x }, { elevator: true, box: true });
      if (!p.reduced) p.hold(250, "emp.stand.front");
    } else {
      p.go({ band: "street", x: POINTS.street.edge - 20 }, { elevator: true, box: true });
      p.fadeTo({ ...standPose(this.nav!, "street", POINTS.street.edge), alpha: 0 });
    }
    this.moves++;
  }

  /** The boss rides down, walks to the desk and points, then rides back up. Returns when it points. */
  private bossVisit(band: string, deskX: number, start: number, laidOff: string[]): { band: string; at: number } {
    const nav = this.nav!;
    const p = new Plan(nav, start, this.cast.boss.pose(start, nav), this.cast.elevator, 0, false);
    // Stops on the elevator side of the desk and points at it.
    const target = Math.max(POINTS.elevator + 14, deskX - 26);
    p.go({ band, x: target }, { elevator: true, run: true, anim: ANIM.bossRun });
    const at = p.t;
    p.hold(1600, "boss.point", { mirror: false });
    p.go({ band: "penthouse", x: BOSS_HOME_X }, { elevator: true, anim: ANIM.bossWalk });
    this.cast.playBoss(p.build());
    // Coworkers on that floor turn to look.
    for (const a of this.homes.values()) {
      if (a.home.kind !== "seat" || a.home.band !== band || laidOff.includes(a.wallet)) continue;
      const ctl = this.cast.ctls.get(a.wallet);
      if (ctl && !ctl.busy(at)) ctl.reaction = { frame: "emp.sit.side", mirror: a.home.x > target, t0: at + 150, t1: at + 1900 };
    }
    return { band, at };
  }
}

function homeLoc(h: Home): { band: string; x: number } {
  switch (h.kind) {
    case "seat":
      return { band: h.band, x: h.x };
    case "bench":
    case "queue":
      return { band: "street", x: h.x };
    case "away":
      return { band: "street", x: POINTS.street.edge - 20 };
  }
}

function sameHome(a: Home, b: Home): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "seat" && b.kind === "seat") return a.band === b.band && a.x === b.x;
  if (a.kind === "away") return true;
  return (a as { x: number }).x === (b as { x: number }).x;
}

function atHomeOf(p: Pose, h: Home): boolean {
  if (h.kind === "seat") return atHome(p, h);
  if (h.kind === "away") return true;
  return p.band === "street" && Math.abs(p.x - h.x) < 0.5;
}

function atHome(p: Pose, h: Seat): boolean {
  return p.layer === "seat" && p.band === h.band && Math.abs(p.x - h.x) < 0.5;
}

function lowOf(s: Snapshot): boolean {
  return BigInt(s.treasury.reserve) < BigInt(s.config.reserve_low);
}
