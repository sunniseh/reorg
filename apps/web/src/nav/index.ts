/**
 * Navigation (roadmap W-20, design §5.5): every band is one horizontal aisle with named points;
 * stairs link each floor to the next (lobby to the top tier), the elevator links all of them
 * (penthouse included), and the lobby's front door links the lobby to the street. Pure: no Pixi,
 * so it is unit-tested. Units are sprite px in world space (x from the building's left edge, y down
 * from the roof's top); a location is a band and an x on its aisle (the character's center).
 */
import type { TierIndex } from "@reorg/core";
import { CHAR, G, RIG, roomOf, type Band, type BandStack } from "../render/geometry";

const B = RIG.building;

/** Speeds (design §5.5): walk 24 px/s, run 48 px/s, 1.6 s per flight, 0.8 s per floor + doors. */
export const WALK = 24;
export const RUN = 48;
export const CLIMB_MS = 1600;
export const RIDE_FLOOR_MS = 800;
export const DOOR_MS = 400;
/** Lobby door ↔ sidewalk: a few steps toward the viewer (RIG.building.street.door). */
export const STEP_MS = 400;

/** Named aisle points (character centers). */
export const POINTS = {
  stairs: 10,
  elevator: 41,
  /** Riders stand here inside the cab (centered in x 30..45). */
  cab: 38,
  cooler: B.floor.bay.points.cooler,
  printer: B.floor.bay.points.printer,
  outbox: B.floor.bay.points.outbox,
  coffee: B.floor.bay.points.coffee,
  window: B.floor.bay.points.window,
  lobby: { cafe: B.lobby.points.cafe + 8, hr: B.lobby.points.hr, reception: B.lobby.points.reception + 12, door: B.lobby.points.door },
  street: { door: B.lobby.points.door, edge: G.width + 40 },
} as const;

/** The climb geometry inside the stairwell (art/building.mjs `stairs()`), feet positions. */
export const STAIRS = { foot: 10, landing: { x: 20, y: 20 } } as const;

export interface Loc {
  band: string;
  x: number;
}

export type Leg =
  | { kind: "walk"; band: string; x0: number; x1: number; speed: number }
  /** One flight pair between two stacked bands; `lower` is the band below. */
  | { kind: "climb"; lower: string; upper: string; up: boolean; dur: number }
  /** Lobby door ↔ sidewalk. */
  | { kind: "step"; up: boolean; dur: number }
  /** An elevator ride; its timing comes from the elevator's queue. */
  | { kind: "ride"; from: string; to: string };

export interface NavBand {
  key: string;
  kind: Band["kind"];
  /** Order from the top (roof = 0). */
  level: number;
  /** World y of the band's top. */
  top: number;
  /** World y where standing feet are (the floor line; the sidewalk on the street). */
  floorY: number;
  /** World y where seated characters' bottoms are (the desk top), tier floors only. */
  seatY: number;
  tier?: TierIndex;
  /** Reached by the stairs (tier floors and the lobby). */
  stairs: boolean;
  /** Has an elevator door (penthouse, tier floors, lobby). */
  elevator: boolean;
}

export class Nav {
  readonly bands: NavBand[];
  private readonly byKey = new Map<string, NavBand>();

  constructor(readonly stack: BandStack) {
    this.bands = stack.bands.map((b, level) => {
      const nb: NavBand = {
        key: b.key,
        kind: b.kind,
        level,
        top: b.y,
        floorY: b.kind === "street" ? b.y + B.street.standY : b.y + b.interior,
        seatY: b.y + G.floor.deskTop,
        ...(b.tier !== undefined ? { tier: b.tier } : {}),
        // A fold is passed through on the stairs and in the elevator, never stopped at.
        stairs: b.kind === "floor" || b.kind === "fold" || b.kind === "lobby",
        elevator: b.kind === "floor" || b.kind === "lobby" || b.kind === "penthouse",
      };
      this.byKey.set(b.key, nb);
      return nb;
    });
  }

  band(key: string): NavBand {
    const b = this.byKey.get(key);
    if (!b) throw new Error(`nav: no band ${key}`);
    return b;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** The tier floors, top to bottom. */
  floors(): NavBand[] {
    return this.bands.filter((b) => b.kind === "floor");
  }

  /** Center x of a seat on a tier floor. */
  seatX(tier: TierIndex, room: number): number {
    const R = roomOf(tier);
    return G.rooms.x + room * R.w + R.seat + CHAR.w / 2;
  }

  /** Floors between two stair-connected bands (0 = same band). */
  flights(a: string, b: string): number {
    return Math.abs(this.band(a).level - this.band(b).level);
  }

  /**
   * The legs from one location to another. Floor changes go by the stairs unless `elevator` is
   * set (the penthouse is only reachable by elevator). The street is reached through the lobby.
   */
  path(from: Loc, to: Loc, opts: { speed?: number; elevator?: boolean } = {}): Leg[] {
    const speed = opts.speed ?? WALK;
    const legs: Leg[] = [];
    let cur: Loc = { ...from };
    const walk = (x: number) => {
      if (Math.abs(x - cur.x) > 0.01) legs.push({ kind: "walk", band: cur.band, x0: cur.x, x1: x, speed });
      cur = { band: cur.band, x };
    };
    if (cur.band === to.band) {
      walk(to.x);
      return legs;
    }
    const stepDur = speed > WALK ? STEP_MS / 2 : STEP_MS;
    if (cur.band === "street") {
      walk(POINTS.street.door);
      legs.push({ kind: "step", up: true, dur: stepDur });
      cur = { band: "lobby", x: POINTS.lobby.door };
    }
    const target = to.band === "street" ? "lobby" : to.band;
    if (cur.band !== target) {
      const a = this.band(cur.band);
      const b = this.band(target);
      const useLift = opts.elevator || !a.stairs || !b.stairs;
      if (useLift) {
        if (!a.elevator || !b.elevator) throw new Error(`nav: no elevator between ${a.key} and ${b.key}`);
        walk(POINTS.elevator);
        legs.push({ kind: "ride", from: a.key, to: b.key });
        cur = { band: b.key, x: POINTS.elevator };
      } else {
        walk(STAIRS.foot);
        const dir = b.level < a.level ? -1 : 1;
        const climbDur = speed > WALK ? CLIMB_MS / 2 : CLIMB_MS;
        for (let l = a.level; l !== b.level; l += dir) {
          const here = this.bands[l]!;
          const next = this.bands[l + dir]!;
          if (!next.stairs) throw new Error(`nav: no stairs to ${next.key}`);
          const up = dir < 0;
          legs.push({ kind: "climb", lower: up ? here.key : next.key, upper: up ? next.key : here.key, up, dur: climbDur });
        }
        cur = { band: b.key, x: STAIRS.foot };
      }
    }
    if (to.band === "street") {
      walk(POINTS.lobby.door);
      legs.push({ kind: "step", up: false, dur: stepDur });
      cur = { band: "street", x: POINTS.street.door };
    }
    walk(to.x);
    return legs;
  }
}

/** Duration of a leg in ms (rides: null, the elevator decides). */
export function legMs(leg: Leg): number | null {
  switch (leg.kind) {
    case "walk":
      return (Math.abs(leg.x1 - leg.x0) / leg.speed) * 1000;
    case "climb":
    case "step":
      return leg.dur;
    case "ride":
      return null;
  }
}

/** Total duration of a path without rides (ms). */
export function pathMs(legs: readonly Leg[]): number {
  let t = 0;
  for (const l of legs) t += legMs(l) ?? 0;
  return t;
}
