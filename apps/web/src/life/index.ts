/**
 * The idle schedule (roadmap W-21, design §5.6–§5.7). Wall-clock time is cut into 20 s slots; for
 * each agent and slot a hash of (wallet, task id, slot) picks one activity from the set its state
 * allows, and every activity starts and ends at home inside its slot. An agent's position is
 * therefore a closed-form function of time: a client that loads mid-day, or a character that
 * scrolls into view, computes it directly, and two clients draw the same building.
 *
 * Movement only implies true things (design §1.3): while a task is open, an employee who has not
 * submitted stays at the desk; results-pending keeps everyone seated; the laid off stay on the
 * bench and visitors in the queue. Pure: no Pixi.
 */
import type { TaskStatus } from "@reorg/core";
import { ANIM, Plan, sample, seatPose, standPose, type Anim, type Pose, type Track } from "../agents/track";
import { CLIMB_MS, POINTS, STAIRS, WALK, type Nav } from "../nav";
import { hash32, unit } from "../state/rng";

/** Slot length (design §5.6): a client display constant, not contract config. */
export const SLOT_MS = 20_000;
/** Every trip is back home this long before its slot ends. */
export const SLOT_MARGIN_MS = 600;
/** The shortest stay at an amenity worth the walk. */
const MIN_ACT_MS = 2500;
/** A slot shorter than this (before a deadline) is spent at home. */
const MIN_TRIP_MS = 6000;
/** Idle stairs trips reach at most this many floors away (design §5.6). */
export const MAX_TRIP_FLIGHTS = 2;
/** A seated beat at the slot start, then the rise (design §14.1 rule 6). */
const BEAT_MS = 300;
const RISE_MS = BEAT_MS + 200;
const SIT_MS = 280;

export type Home =
  | { kind: "seat"; band: string; x: number }
  | { kind: "bench"; x: number }
  | { kind: "queue"; x: number }
  /** Drawn nowhere in particular (the bench or the queue is full: the "+n" sign stands for it). */
  | { kind: "away" };

export interface LifeAgent {
  wallet: string;
  home: Home;
  /** Has a submission to the newest task (which is not finalized). */
  submitted: boolean;
}

export interface LifeTask {
  id: number;
  /** As stored on chain: `closed` is derived from `closesAt`. */
  status: TaskStatus;
  /** Wall-clock ms. */
  closesAt: number;
}

export interface LifeWorld {
  nav: Nav;
  task: LifeTask | null;
  /** When the next task is expected to open (ms), if anyone knows: slots across it stay home. */
  nextOpenAt: number | null;
  /** Seat agents per band (water-cooler pairing and visits). */
  roster: ReadonlyMap<string, readonly LifeAgent[]>;
  /** Reduced motion (design §14.5): no idle trips, still poses at home. */
  reduced?: boolean;
}

/** What the state allows over a slot (design §5.7). */
export type Mode = "free" | "desk" | "bench" | "queue" | "away";

export type ActivityKind = "stay" | "cooler" | "coffee" | "window" | "printer" | "chat" | "trip";

export const ALLOWED: Record<Mode, readonly ActivityKind[]> = {
  free: ["stay", "cooler", "coffee", "window", "printer", "chat", "trip"],
  desk: ["stay"],
  bench: ["stay"],
  queue: ["stay"],
  away: ["stay"],
};

/** About half the slots are "stay" (design §5.6). Display constants. */
const WEIGHTS: readonly [ActivityKind, number][] = [
  ["stay", 46],
  ["cooler", 9],
  ["coffee", 9],
  ["window", 6],
  ["printer", 6],
  ["chat", 15],
  ["trip", 9],
];

export interface Activity {
  kind: ActivityKind;
  /** For chats: the partner. */
  partner?: string;
  /** For trips: the band visited. */
  band?: string;
}

export const slotOf = (t: number): number => Math.floor(t / SLOT_MS);
export const slotStart = (slot: number): number => slot * SLOT_MS;

const walkMs = (dx: number) => (Math.abs(dx) / WALK) * 1000;
const seatX = (a: LifeAgent) => (a.home as { x: number }).x;

interface Pairing {
  partner: string;
  /** Stands on the left of the pair (faces right). */
  left: boolean;
  /** Meeting window, ms from the slot start. */
  meet: [number, number];
}

/** Where pairs meet: either side of the water cooler. */
const CHAT_L = POINTS.cooler - 16;
const CHAT_R = POINTS.cooler;

export class Life {
  private readonly pairings = new Map<string, Map<string, Pairing>>();

  constructor(readonly world: LifeWorld) {}

  /** The mode of a slot: free only if the state allows roaming at its start and leaves time for a trip. */
  mode(a: LifeAgent, t0: number, t1: number): Mode {
    const h = a.home;
    if (h.kind !== "seat") return h.kind;
    if (this.world.reduced) return "desk";
    const { task } = this.world;
    const idle = !task || task.status === "finalized";
    // Closed or finalizing (results pending), or open and nothing filed: the desk only.
    if (!idle && (task.status !== "open" || t0 >= task.closesAt || !a.submitted)) return "desk";
    return this.deadline(a, t0, t1) - t0 >= MIN_TRIP_MS ? "free" : "desk";
  }

  /**
   * When a free agent must be back home inside [t0, t1): before the slot ends, before the window
   * closes (results arrive with everyone seated), and before the next task opens if that is known.
   */
  deadline(a: LifeAgent, t0: number, t1: number): number {
    let d = t1 - SLOT_MARGIN_MS;
    const { task, nextOpenAt } = this.world;
    if (task && task.status === "open" && a.submitted) d = Math.min(d, task.closesAt - SLOT_MARGIN_MS);
    if ((!task || task.status === "finalized") && nextOpenAt !== null && nextOpenAt > t0) d = Math.min(d, nextOpenAt - SLOT_MARGIN_MS);
    return d;
  }

  /** Time available for a trip in a slot (ms from its start). */
  private room(a: LifeAgent, slot: number): number {
    const t0 = slotStart(slot);
    return this.deadline(a, t0, t0 + SLOT_MS) - t0;
  }

  /** Seated and typing: a task is open, before close, and nothing is filed (design §5.4). */
  working(a: LifeAgent, t: number): boolean {
    const task = this.world.task;
    return !!task && task.status === "open" && t < task.closesAt && !a.submitted && a.home.kind === "seat";
  }

  /** The activity drawn for a slot, before feasibility. */
  private draw(a: LifeAgent, slot: number, mode: Mode): ActivityKind {
    const allowed = ALLOWED[mode];
    if (allowed.length === 1) return allowed[0]!;
    const opts = WEIGHTS.filter(([k]) => allowed.includes(k));
    const total = opts.reduce((s, [, w]) => s + w, 0);
    let r = unit(a.wallet, this.world.task?.id ?? 0, slot, "act") * total;
    for (const [k, w] of opts) {
      if ((r -= w) < 0) return k;
    }
    return "stay";
  }

  /** The activity for a slot, after feasibility and pairing. */
  activity(a: LifeAgent, slot: number): Activity {
    const t0 = slotStart(slot);
    const kind = this.draw(a, slot, this.mode(a, t0, t0 + SLOT_MS));
    if (kind === "stay" || a.home.kind !== "seat") return { kind: "stay" };
    if (kind === "chat") {
      const p = this.pairing(a.home.band, slot).get(a.wallet);
      if (p) return { kind: "chat", partner: p.partner };
      // The odd one out drinks alone (design §5.6).
      return this.amenityTrack(a, "cooler", slot) ? { kind: "cooler" } : { kind: "stay" };
    }
    if (kind === "trip") {
      const band = this.tripBand(a, slot);
      return band && this.tripTrack(a, slot, band) ? { kind: "trip", band } : { kind: "stay" };
    }
    return this.amenityTrack(a, kind, slot) ? { kind } : { kind: "stay" };
  }

  /** The slot's track: starts and ends at home. */
  track(a: LifeAgent, slot: number): Track {
    const act = this.activity(a, slot);
    const t0 = slotStart(slot);
    const home = a.home;
    if (home.kind === "seat") {
      switch (act.kind) {
        case "stay":
          return this.stayTrack(a, slot);
        case "chat":
          return this.chatTrack(a, slot)!;
        case "trip":
          return this.tripTrack(a, slot, act.band!)!;
        default:
          return this.amenityTrack(a, act.kind, slot)!;
      }
    }
    const phase = unit(a.wallet, "phase") * 4;
    return new Plan(this.world.nav, t0, this.home(a, t0), null, phase).hold(SLOT_MS, this.world.reduced ? this.home(a, t0).frame : homeAnim(home)).build();
  }

  /** Where the agent is at `t`, from its slot track. */
  positionAt(a: LifeAgent, t: number): Pose {
    return sample(this.track(a, slotOf(t)), t);
  }

  /** The home pose: seated at the desk (typing while working), on the bench, in the queue. */
  home(a: LifeAgent, t: number): Pose {
    const nav = this.world.nav;
    const h = a.home;
    switch (h.kind) {
      case "seat":
        return seatPose(nav, h.band, h.x, this.working(a, t) ? "emp.type.0" : "emp.sit.front");
      case "bench":
        return standPose(nav, "street", h.x, "emp.bench.0");
      case "queue":
        return standPose(nav, "street", h.x, "emp.visitor");
      case "away":
        return { ...standPose(nav, "street", POINTS.street.edge), alpha: 0 };
    }
  }

  // ---------------------------------------------------------------- tracks

  private start(a: LifeAgent, slot: number): Plan {
    const h = a.home as Extract<Home, { kind: "seat" }>;
    const nav = this.world.nav;
    return new Plan(nav, slotStart(slot), seatPose(nav, h.band, h.x), null, unit(a.wallet, "phase") * 4).hold(BEAT_MS, "emp.sit.front");
  }

  /** Staying home: typing (thinking now and then) while working, otherwise seated with a stretch now and then. */
  private stayTrack(a: LifeAgent, slot: number): Track {
    const t0 = slotStart(slot);
    const h = a.home as Extract<Home, { kind: "seat" }>;
    const p = new Plan(this.world.nav, t0, seatPose(this.world.nav, h.band, h.x), null, unit(a.wallet, "phase") * 4);
    const task = this.world.task;
    if (this.world.reduced) return p.until(t0 + SLOT_MS, this.working(a, t0) ? "emp.type.0" : "emp.sit.front").build();
    const u = unit(a.wallet, task?.id ?? 0, slot, "stay");
    const at = t0 + 3000 + Math.floor(unit(a.wallet, slot, "at") * 12_000);
    if (this.working(a, t0)) {
      // About one slot in three leans back to think for 2.5 s (design §5.7, the P1 frame).
      const end = Math.min(t0 + SLOT_MS, task!.closesAt);
      if (u < 0.35 && at + 2500 < end) p.until(at, ANIM.type).hold(2500, "emp.sit.side");
      p.until(end, ANIM.type);
      return p.until(t0 + SLOT_MS, "emp.sit.front").build();
    }
    if (u < 0.3) p.until(at, "emp.sit.front").hold(2000, ANIM.stretch);
    else if (u < 0.5) p.until(at, "emp.sit.front").hold(3000, "emp.sit.side");
    return p.until(t0 + SLOT_MS, "emp.sit.front").build();
  }

  /** Out to an amenity in the bay, a few seconds there, back to the desk. */
  private amenityTrack(a: LifeAgent, kind: ActivityKind, slot: number): Track | null {
    if (a.home.kind !== "seat") return null;
    const spot = SPOTS[kind as keyof typeof SPOTS];
    if (!spot) return null;
    const hx = seatX(a);
    const out = RISE_MS + walkMs(spot.x - hx);
    const back = walkMs(spot.x - hx) + SIT_MS;
    const room = this.room(a, slot) - out - back;
    if (room < MIN_ACT_MS) return null;
    const want = Math.min(room, 3000 + unit(a.wallet, slot, "dur") * 4000);
    const lead = Math.floor(unit(a.wallet, slot, "lead") * (room - want));
    const band = a.home.band;
    return this.start(a, slot)
      .hold(lead, "emp.sit.front")
      .go({ band, x: spot.x })
      .hold(want, spot.frame, { mirror: false })
      .go({ band, x: hx })
      .sit()
      .until(slotStart(slot) + SLOT_MS, "emp.sit.front")
      .build();
  }

  /** The cooler pairs of one floor and slot (design §5.6), by the order of their slot hashes. */
  private pairing(band: string, slot: number): Map<string, Pairing> {
    const key = `${band}|${slot}`;
    const cached = this.pairings.get(key);
    if (cached) return cached;
    const m = new Map<string, Pairing>();
    this.pairings.set(key, m);
    const t0 = slotStart(slot);
    const cands = (this.world.roster.get(band) ?? [])
      .filter((b) => b.home.kind === "seat" && this.draw(b, slot, this.mode(b, t0, t0 + SLOT_MS)) === "chat")
      .sort((x, y) => hash32(x.wallet, slot, "pair") - hash32(y.wallet, slot, "pair") || (x.wallet < y.wallet ? -1 : 1));
    for (let i = 0; i + 1 < cands.length; i += 2) {
      const [p, q] = [cands[i]!, cands[i + 1]!];
      const left = seatX(p) <= seatX(q) ? p : q;
      const right = left === p ? q : p;
      const start = Math.max(RISE_MS + walkMs(CHAT_L - seatX(left)), RISE_MS + walkMs(CHAT_R - seatX(right)));
      const end = Math.min(this.room(left, slot), this.room(right, slot)) - Math.max(walkMs(CHAT_L - seatX(left)), walkMs(CHAT_R - seatX(right))) - SIT_MS;
      if (end - start < MIN_ACT_MS) continue;
      m.set(left.wallet, { partner: right.wallet, left: true, meet: [start, end] });
      m.set(right.wallet, { partner: left.wallet, left: false, meet: [start, end] });
    }
    return m;
  }

  private chatTrack(a: LifeAgent, slot: number): Track | null {
    if (a.home.kind !== "seat") return null;
    const p = this.pairing(a.home.band, slot).get(a.wallet);
    if (!p) return null;
    const t0 = slotStart(slot);
    const band = a.home.band;
    return this.start(a, slot)
      .go({ band, x: p.left ? CHAT_L : CHAT_R })
      .until(t0 + p.meet[0], "emp.stand.side", { mirror: !p.left })
      .until(t0 + p.meet[1], ANIM.chat, { mirror: !p.left })
      .go({ band, x: seatX(a) })
      .sit()
      .until(t0 + SLOT_MS, "emp.sit.front")
      .build();
  }

  /** A band within two flights by the stairs (the lobby café counts), or null. */
  private tripBand(a: LifeAgent, slot: number): string | null {
    if (a.home.kind !== "seat") return null;
    const nav = this.world.nav;
    const here = nav.band(a.home.band);
    const options = nav.bands.filter((b) => b.stairs && b.key !== here.key && Math.abs(b.level - here.level) <= MAX_TRIP_FLIGHTS);
    if (options.length === 0) return null;
    return options[Math.floor(unit(a.wallet, slot, "trip") * options.length)]!.key;
  }

  /** A stairs trip: the lobby café, or a colleague's desk up to two floors away. */
  private tripTrack(a: LifeAgent, slot: number, band: string): Track | null {
    if (a.home.kind !== "seat") return null;
    const nav = this.world.nav;
    const flights = nav.flights(a.home.band, band);
    if (flights < 1 || flights > MAX_TRIP_FLIGHTS) return null;
    let x: number;
    let frame: string | Anim;
    let mirror: boolean;
    if (band === "lobby") {
      x = POINTS.lobby.cafe + Math.floor(unit(a.wallet, slot, "cafe") * 24);
      frame = ANIM.drink;
      mirror = true;
    } else {
      // Visit a colleague near the stairs: stand beside their desk, chatting toward it.
      const near = (this.world.roster.get(band) ?? []).filter((b) => b.home.kind === "seat" && seatX(b) < 200);
      if (near.length > 0) {
        x = seatX(near[Math.floor(unit(a.wallet, slot, "visit") * near.length)]!) + 14;
        frame = ANIM.chat;
        mirror = true;
      } else {
        x = 60 + Math.floor(unit(a.wallet, slot, "spot") * 80);
        frame = "emp.stand.side";
        mirror = false;
      }
    }
    const hx = seatX(a);
    const one = RISE_MS + walkMs(hx - STAIRS.foot) + flights * CLIMB_MS + walkMs(x - STAIRS.foot);
    const back = walkMs(x - STAIRS.foot) + flights * CLIMB_MS + walkMs(hx - STAIRS.foot) + SIT_MS;
    const room = this.room(a, slot) - one - back;
    if (room < MIN_ACT_MS) return null;
    const t0 = slotStart(slot);
    return this.start(a, slot)
      .go({ band, x })
      .hold(Math.min(room, 3000 + unit(a.wallet, slot, "dur") * 3000), frame, { mirror })
      .go({ band: a.home.band, x: hx })
      .sit()
      .until(t0 + SLOT_MS, "emp.sit.front")
      .build();
  }
}

/** Amenity spots in the bay (stand points, design §5.5). */
const SPOTS = {
  cooler: { x: POINTS.cooler, frame: ANIM.drink },
  coffee: { x: POINTS.coffee, frame: ANIM.drink },
  printer: { x: POINTS.printer, frame: "emp.stand.side" },
  window: { x: POINTS.window, frame: "emp.stand.side" },
} as const;

/** The looping home animation off the floors. */
function homeAnim(h: Home): Anim | string {
  switch (h.kind) {
    case "bench":
      return ANIM.bench;
    case "queue":
      return ANIM.shuffle;
    default:
      return "emp.stand.front";
  }
}
