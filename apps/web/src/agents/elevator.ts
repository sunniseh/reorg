/**
 * The elevator (design §4.4, §5.5): one shaft, one cab, used only by scripted moments. Rides queue
 * one at a time, up to 3 riders per ride; a rider who reaches the door while a ride for the same
 * trip is still boarding joins it. Pure: the cab's position and door frame are functions of time
 * over the booked rides, so the renderer and the riders' tracks agree exactly.
 */
import { G } from "../render/geometry";
import { DOOR_MS, RIDE_FLOOR_MS, type Nav } from "../nav";

/** Riders step in or out of the cab (ms). */
export const BOARD_MS = 300;
export const MAX_RIDERS = 3;

export interface Ride {
  from: string;
  to: string;
  /** Cab floor-line y (world) where it starts the empty approach, at the pickup, at the drop-off. */
  startY: number;
  fromY: number;
  toY: number;
  /** Empty approach starts. */
  tApproach: number;
  /** Doors start opening at the pickup floor. */
  tOpen: number;
  /** Riders step in from here (the last rider's arrival). */
  tBoard: number;
  /** Doors closed; the cab starts moving. */
  tDepart: number;
  /** The cab stops at the drop-off floor; doors start opening. */
  tArrive: number;
  /** Doors closed again; the cab is free. */
  tDone: number;
  riders: number;
}

export interface CabState {
  /** Floor-line y of the cab (world). */
  y: number;
  /** Door frame 0 (closed) … 2 (open). */
  doors: 0 | 1 | 2;
  /** -1 up, 1 down, 0 still. */
  dir: -1 | 0 | 1;
}

export interface Booking {
  ride: Ride;
  /** Rider index in the cab (0..2). */
  slot: number;
}

const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

/** Travel time between two floor lines: 0.8 s per floor pitch. */
export function travelMs(y0: number, y1: number): number {
  return (Math.abs(y1 - y0) / G.floor.pitch) * RIDE_FLOOR_MS;
}

/** Door frame while opening (p 0→1) or closing (p 1→0). */
function doorFrame(p: number): 0 | 1 | 2 {
  return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2;
}

export class Elevator {
  private rides: Ride[] = [];
  private restY: number;

  constructor(private readonly nav: Nav) {
    this.restY = nav.has("lobby") ? nav.band("lobby").floorY : 0;
  }

  /**
   * Books a trip for a rider who reaches the door of `from` at `tReady` (`now` = the planning
   * time: the cab never starts moving in the past). The ride goes into the earliest gap in the
   * queue that fits, so a rider who is ready soon is not stuck behind one booked for later; the
   * next ride's empty approach is re-routed from where this one leaves the cab.
   */
  book(from: string, to: string, tReady: number, now = -Infinity): Booking {
    const fromY = this.nav.band(from).floorY;
    const toY = this.nav.band(to).floorY;
    // Join a ride for the same trip that is still boarding.
    for (const r of this.rides) {
      if (r.from === from && r.to === to && r.riders < MAX_RIDERS && tReady >= r.tOpen - 1500 && tReady <= r.tBoard) {
        return { ride: r, slot: r.riders++ };
      }
    }
    for (let i = 0; i <= this.rides.length; i++) {
      const prev = this.rides[i - 1];
      const next = this.rides[i];
      const ride = this.make(from, to, fromY, toY, tReady, prev ? prev.toY : this.restY, Math.max(prev ? prev.tDone : -Infinity, now));
      if (next) {
        if (next.tApproach <= now) continue; // already on its way
        const approach = next.tOpen - travelMs(toY, next.fromY);
        if (ride.tDone > approach) continue;
        next.startY = toY;
        next.tApproach = approach;
      }
      this.rides.splice(i, 0, ride);
      return { ride, slot: 0 };
    }
    throw new Error("elevator: unreachable");
  }

  private make(from: string, to: string, fromY: number, toY: number, tReady: number, startY: number, free: number): Ride {
    const approach = travelMs(startY, fromY);
    const tApproach = Math.max(free, tReady - DOOR_MS - approach);
    const tOpen = tApproach + approach;
    const tBoard = Math.max(tOpen + DOOR_MS, tReady);
    const tDepart = tBoard + BOARD_MS + DOOR_MS;
    const tArrive = tDepart + travelMs(fromY, toY);
    const tDone = tArrive + DOOR_MS + BOARD_MS + DOOR_MS;
    return { from, to, startY, fromY, toY, tApproach, tOpen, tBoard, tDepart, tArrive, tDone, riders: 1 };
  }

  /** Forgets rides that ended before `t` (keeps the cab's resting place). */
  prune(t: number): void {
    while (this.rides.length > 0 && this.rides[0]!.tDone < t - 1000) {
      this.restY = this.rides.shift()!.toY;
    }
  }

  /** Tap to skip: every ride ends now; the cab rests where the last booked ride was going. */
  clear(): void {
    const last = this.rides[this.rides.length - 1];
    if (last) this.restY = last.toY;
    this.rides = [];
  }

  /** Some ride is under way at `t`. */
  busy(t: number): boolean {
    return this.rides.some((r) => t >= r.tApproach && t < r.tDone);
  }

  state(t: number): CabState {
    let y = this.restY;
    for (const r of this.rides) {
      if (t < r.tApproach) break;
      if (t >= r.tDone) {
        y = r.toY;
        continue;
      }
      if (t < r.tOpen) {
        const p = (t - r.tApproach) / Math.max(1, r.tOpen - r.tApproach);
        return { y: r.startY + (r.fromY - r.startY) * easeInOut(p), doors: 0, dir: Math.sign(r.fromY - r.startY) as -1 | 0 | 1 };
      }
      if (t < r.tOpen + DOOR_MS) return { y: r.fromY, doors: doorFrame((t - r.tOpen) / DOOR_MS), dir: 0 };
      if (t < r.tBoard + BOARD_MS) return { y: r.fromY, doors: 2, dir: 0 };
      if (t < r.tDepart) return { y: r.fromY, doors: doorFrame(1 - (t - r.tBoard - BOARD_MS) / DOOR_MS), dir: 0 };
      if (t < r.tArrive) {
        const p = (t - r.tDepart) / Math.max(1, r.tArrive - r.tDepart);
        return { y: r.fromY + (r.toY - r.fromY) * easeInOut(p), doors: 0, dir: Math.sign(r.toY - r.fromY) as -1 | 0 | 1 };
      }
      if (t < r.tArrive + DOOR_MS) return { y: r.toY, doors: doorFrame((t - r.tArrive) / DOOR_MS), dir: 0 };
      if (t < r.tArrive + DOOR_MS + BOARD_MS) return { y: r.toY, doors: 2, dir: 0 };
      return { y: r.toY, doors: doorFrame(1 - (t - r.tArrive - DOOR_MS - BOARD_MS) / DOOR_MS), dir: 0 };
    }
    return { y, doors: 0, dir: 0 };
  }

  /** Cab y during a ride (riders read it). */
  static rideY(r: Ride, t: number): number {
    if (t <= r.tDepart) return r.fromY;
    if (t >= r.tArrive) return r.toY;
    const p = (t - r.tDepart) / Math.max(1, r.tArrive - r.tDepart);
    return r.fromY + (r.toY - r.fromY) * easeInOut(p);
  }
}
