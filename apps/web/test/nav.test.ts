import { describe, expect, it } from "vitest";
import { Elevator } from "../src/agents/elevator";
import { Plan, sample, seatPose, standPose } from "../src/agents/track";
import { CLIMB_MS, legMs, pathMs, POINTS, RUN, STAIRS, WALK } from "../src/nav";
import { testNav } from "./helpers";

describe("nav (W-20)", () => {
  const nav = testNav();

  it("stacks the bands top to bottom with floor lines one pitch apart", () => {
    expect(nav.bands.map((b) => b.key)).toEqual(["roof", "penthouse", "t0f0", "t1f0", "t2f0", "t2f1", "t3f0", "lobby", "street", "basement"]);
    expect(nav.band("t1f0").floorY - nav.band("t0f0").floorY).toBe(52);
    expect(nav.band("lobby").floorY - nav.band("t3f0").floorY).toBe(52);
    expect(nav.band("t0f0").seatY).toBeLessThan(nav.band("t0f0").floorY);
    expect(nav.band("street").floorY).toBeGreaterThan(nav.band("lobby").floorY);
  });

  it("walks along one aisle", () => {
    const legs = nav.path({ band: "t1f0", x: 100 }, { band: "t1f0", x: 340 });
    expect(legs).toEqual([{ kind: "walk", band: "t1f0", x0: 100, x1: 340, speed: WALK }]);
    expect(pathMs(legs)).toBeCloseTo(10_000);
  });

  it("takes the stairs flight by flight, from the stair foot", () => {
    const legs = nav.path({ band: "t3f0", x: 200 }, { band: "t2f0", x: 80 });
    expect(legs.map((l) => l.kind)).toEqual(["walk", "climb", "climb", "walk"]);
    expect(legs[0]).toMatchObject({ x1: STAIRS.foot });
    expect(legs[1]).toMatchObject({ lower: "t3f0", upper: "t2f1", up: true });
    expect(legs[2]).toMatchObject({ lower: "t2f1", upper: "t2f0", up: true });
    expect(legs[3]).toMatchObject({ band: "t2f0", x0: STAIRS.foot, x1: 80 });
    const down = nav.path({ band: "t2f0", x: 80 }, { band: "lobby", x: 60 });
    expect(down.filter((l) => l.kind === "climb").every((l) => l.kind === "climb" && !l.up)).toBe(true);
    expect(legMs(legs[1]!)).toBe(CLIMB_MS);
    expect(legMs(nav.path({ band: "t3f0", x: 10 }, { band: "lobby", x: 10 }, { speed: RUN })[0]!)).toBe(CLIMB_MS / 2);
  });

  it("goes out through the lobby door to the street, and back in", () => {
    const out = nav.path({ band: "t3f0", x: 100 }, { band: "street", x: 140 }, { elevator: true });
    expect(out.map((l) => l.kind)).toEqual(["walk", "ride", "walk", "step", "walk"]);
    expect(out[1]).toMatchObject({ from: "t3f0", to: "lobby" });
    expect(out[2]).toMatchObject({ band: "lobby", x1: POINTS.lobby.door });
    const back = nav.path({ band: "street", x: 140 }, { band: "t0f0", x: 100 }, { elevator: true });
    expect(back.map((l) => l.kind)).toEqual(["walk", "step", "walk", "ride", "walk"]);
  });

  it("reaches the penthouse only by elevator", () => {
    const legs = nav.path({ band: "t0f0", x: 100 }, { band: "penthouse", x: 200 });
    expect(legs.some((l) => l.kind === "ride")).toBe(true);
    expect(legs.some((l) => l.kind === "climb")).toBe(false);
  });
});

describe("elevator", () => {
  const nav = testNav();

  it("queues rides one at a time and opens the doors when the rider arrives", () => {
    const el = new Elevator(nav);
    const a = el.book("t3f0", "lobby", 10_000);
    expect(a.ride.tBoard).toBeGreaterThanOrEqual(10_000);
    const b = el.book("t0f0", "lobby", 10_500);
    expect(b.ride.tApproach).toBeGreaterThanOrEqual(a.ride.tDone);
    expect(el.state(a.ride.tBoard).doors).toBe(2);
    expect(el.state((a.ride.tDepart + a.ride.tArrive) / 2).dir).toBe(1);
    expect(el.state(b.ride.tDone + 10).y).toBe(nav.band("lobby").floorY);
  });

  it("lets a rider who is ready sooner ride before one booked earlier for later", () => {
    const el = new Elevator(nav);
    const late = el.book("lobby", "t0f0", 30_000, 0);
    const soon = el.book("penthouse", "t3f0", 4_000, 0);
    expect(soon.ride.tDone).toBeLessThanOrEqual(late.ride.tApproach);
    expect(soon.ride.tBoard).toBeLessThan(8_000); // as soon as the cab can climb from the lobby
    // The later ride's empty approach now starts where the earlier one left the cab.
    expect(late.ride.startY).toBe(nav.band("t3f0").floorY);
    expect(el.state(late.ride.tApproach - 1).y).toBe(nav.band("t3f0").floorY);
    // The cab never starts moving before the planning time.
    const el2 = new Elevator(nav);
    expect(el2.book("penthouse", "lobby", 1000, 900).ride.tApproach).toBeGreaterThanOrEqual(900);
  });

  it("lets up to three riders share a boarding ride", () => {
    const el = new Elevator(nav);
    const r0 = el.book("t3f0", "lobby", 5000);
    const r1 = el.book("t3f0", "lobby", 5000);
    const r2 = el.book("t3f0", "lobby", 5000);
    const r3 = el.book("t3f0", "lobby", 5000);
    expect(r1.ride).toBe(r0.ride);
    expect(r2.ride).toBe(r0.ride);
    expect(r3.ride).not.toBe(r0.ride);
    expect([r0.slot, r1.slot, r2.slot]).toEqual([0, 1, 2]);
  });

  it("carries a rider: door, cab, out at the destination", () => {
    const el = new Elevator(nav);
    const start = seatPose(nav, "t2f0", 120);
    const track = new Plan(nav, 0, start, el).go({ band: "street", x: 140 }, { elevator: true }).build();
    const ride = track.segs.find((s) => s.kind === "ride")!;
    if (ride.kind !== "ride") throw new Error();
    expect(sample(track, ride.ride.tBoard - 1).layer).toBe("aisle");
    expect(sample(track, (ride.ride.tDepart + ride.ride.tArrive) / 2).layer).toBe("cab");
    const end = sample(track, track.t1);
    expect(end).toMatchObject({ band: "street", x: 140, layer: "street" });
  });

  it("is continuous along a stairs path", () => {
    const track = new Plan(nav, 0, standPose(nav, "t3f0", 200)).go({ band: "t2f0", x: 80 }).build();
    let prev = sample(track, 0);
    for (let t = 0; t <= track.t1; t += 20) {
      const p = sample(track, t);
      expect(Math.abs(p.x - prev.x)).toBeLessThan(3);
      expect(Math.abs(p.y - prev.y)).toBeLessThan(3);
      prev = p;
    }
    expect(sample(track, track.t1)).toMatchObject({ band: "t2f0", x: 80, y: nav.band("t2f0").floorY });
  });
});
