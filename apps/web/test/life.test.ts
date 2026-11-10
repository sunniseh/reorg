import { describe, expect, it } from "vitest";
import { sample } from "../src/agents/track";
import { Life, MAX_TRIP_FLIGHTS, PACE, SLOT_MARGIN_MS, SLOT_MS, slotStart, type LifeAgent, type LifeTask, type LifeWorld } from "../src/life";
import { POINTS } from "../src/nav";
import { testNav } from "./helpers";

const nav = testNav();
const FLOORS = ["t0f0", "t1f0", "t2f0", "t2f1", "t3f0"];

function crowd(submittedEvery = 2): LifeAgent[] {
  const out: LifeAgent[] = [];
  let k = 0;
  for (const band of FLOORS) {
    const tier = nav.band(band).tier!;
    const per = [4, 6, 8, 12][tier]!;
    for (let r = 0; r < per; r++) out.push({ wallet: `w${k}.sim`, home: { kind: "seat", band, x: nav.seatX(tier, r) }, submitted: k++ % submittedEvery === 0 });
  }
  out.push({ wallet: "laid.sim", home: { kind: "bench", x: 130 }, submitted: false });
  out.push({ wallet: "laid2.sim", home: { kind: "bench", x: 166 }, submitted: false });
  out.push({ wallet: "visitor.sim", home: { kind: "queue", x: 346 }, submitted: false });
  return out;
}

function world(agents: LifeAgent[], task: LifeTask | null, nextOpenAt: number | null = null): LifeWorld {
  const roster = new Map<string, LifeAgent[]>();
  for (const a of agents) if (a.home.kind === "seat") roster.set(a.home.band, [...(roster.get(a.home.band) ?? []), a]);
  return { nav, task, nextOpenAt, roster };
}

const BASE = 1_800_000_000_000; // a slot boundary
const SLOTS = 60;

describe("life (W-21)", () => {
  const agents = crowd();

  it("is deterministic: the same inputs give the same positions", () => {
    const task: LifeTask = { id: 7, status: "finalized", closesAt: BASE - 1 };
    const a = new Life(world(agents, task));
    const b = new Life(world(crowd(), task));
    for (let t = BASE; t < BASE + SLOT_MS * 10; t += 777) {
      for (const ag of agents) expect(a.positionAt(ag, t)).toEqual(b.positionAt(ag, t));
    }
  });

  it("a finalized day gets the building moving: about half the slots are trips", () => {
    const life = new Life(world(agents, { id: 3, status: "finalized", closesAt: BASE - 1 }));
    const kinds = new Map<string, number>();
    for (let s = 0; s < SLOTS; s++)
      for (const a of agents) {
        const k = life.activity(a, BASE / SLOT_MS + s).kind;
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
    const total = SLOTS * agents.length;
    expect((kinds.get("stay") ?? 0) / total).toBeGreaterThan(0.35);
    expect((kinds.get("stay") ?? 0) / total).toBeLessThan(0.8);
    for (const k of ["cooler", "coffee", "window", "printer", "chat", "trip"]) expect(kinds.get(k) ?? 0).toBeGreaterThan(0);
  });

  it("allows no forbidden activity: open and not submitted, results pending, laid off, visitors stay home", () => {
    const open: LifeTask = { id: 4, status: "open", closesAt: BASE + SLOT_MS * 30 };
    const pending: LifeTask = { id: 4, status: "finalizing", closesAt: BASE - 1 };
    for (const task of [open, pending]) {
      const life = new Life(world(agents, task));
      for (let s = 0; s < SLOTS; s++) {
        const slot = BASE / SLOT_MS + s;
        for (const a of agents) {
          // The laid off may pace beside the bench (P1); that is checked below.
          const mustStay = a.home.kind === "queue" || (a.home.kind === "seat" && (task.status !== "open" || !a.submitted));
          if (!mustStay) continue;
          expect(life.activity(a, slot).kind).toBe("stay");
          const home = life.home(a, slotStart(slot));
          for (let t = slotStart(slot); t < slotStart(slot + 1); t += 1000) {
            const p = life.positionAt(a, t);
            expect([p.band, p.x, p.y, p.layer]).toEqual([home.band, home.x, home.y, home.layer]);
          }
        }
      }
    }
  });

  it("types while working and stops at close; nobody is away when the window closes", () => {
    const closesAt = BASE + SLOT_MS * 2 + 7000; // mid-slot
    const life = new Life(world(agents, { id: 5, status: "open", closesAt }));
    const worker = agents.find((a) => a.home.kind === "seat" && !a.submitted)!;
    expect(life.positionAt(worker, BASE + 1000).frame).toMatch(/^emp\.(type|sit\.side)/);
    expect(life.positionAt(worker, closesAt + 100).frame).toBe("emp.sit.front");
    for (const a of agents) {
      if (a.home.kind !== "seat") continue;
      const p = life.positionAt(a, closesAt);
      expect(p.layer).toBe("seat");
      expect(p.x).toBe(a.home.x);
    }
  });

  it("every activity fits its slot: home at both ends, back before the margin", () => {
    const life = new Life(world(agents, { id: 9, status: "finalized", closesAt: BASE - 1 }));
    for (let s = 0; s < SLOTS; s++) {
      const slot = BASE / SLOT_MS + s;
      for (const a of agents) {
        if (a.home.kind !== "seat") continue;
        const tr = life.track(a, slot);
        expect(tr.t0).toBe(slotStart(slot));
        expect(tr.t1).toBeLessThanOrEqual(slotStart(slot + 1) + 1e-6);
        const start = sample(tr, tr.t0);
        const end = sample(tr, slotStart(slot + 1) - SLOT_MARGIN_MS);
        for (const p of [start, end]) expect([p.band, p.x, p.layer]).toEqual([a.home.band, a.home.x, "seat"]);
      }
    }
  });

  it("stairs trips reach at most two floors away; chats meet in pairs at the cooler", () => {
    const life = new Life(world(agents, { id: 2, status: "finalized", closesAt: BASE - 1 }));
    let trips = 0;
    let chats = 0;
    for (let s = 0; s < SLOTS; s++) {
      const slot = BASE / SLOT_MS + s;
      for (const a of agents) {
        if (a.home.kind !== "seat") continue;
        const act = life.activity(a, slot);
        if (act.kind === "trip") {
          trips++;
          expect(nav.flights(a.home.band, act.band!)).toBeLessThanOrEqual(MAX_TRIP_FLIGHTS);
        }
        if (act.kind === "chat") {
          chats++;
          const partner = agents.find((b) => b.wallet === act.partner)!;
          expect(life.activity(partner, slot)).toMatchObject({ kind: "chat", partner: a.wallet });
          expect(partner.home.kind === "seat" && partner.home.band).toBe(a.home.band);
          // Both stand at the cooler at the same moment.
          const mid = slotStart(slot) + SLOT_MS / 2;
          const [p, q] = [life.positionAt(a, mid), life.positionAt(partner, mid)];
          expect(Math.abs(p.x - POINTS.cooler)).toBeLessThanOrEqual(16);
          expect(Math.abs(q.x - POINTS.cooler)).toBeLessThanOrEqual(16);
        }
      }
    }
    expect(trips).toBeGreaterThan(0);
    expect(chats).toBeGreaterThan(0);
  });

  it("the laid off stay on the bench or pace beside it on the sidewalk, back on the bench at slot ends", () => {
    for (const task of [{ id: 4, status: "open", closesAt: BASE + SLOT_MS * 30 } as LifeTask, { id: 4, status: "finalized", closesAt: BASE - 1 } as LifeTask]) {
      const life = new Life(world(agents, task));
      let paced = 0;
      for (const a of agents.filter((x) => x.home.kind === "bench")) {
        const hx = (a.home as { x: number }).x;
        for (let s = 0; s < SLOTS; s++) {
          const slot = BASE / SLOT_MS + s;
          const act = life.activity(a, slot).kind;
          expect(["stay", "pace"]).toContain(act);
          if (act === "pace") paced++;
          const tr = life.track(a, slot);
          expect(tr.t1).toBeLessThanOrEqual(slotStart(slot + 1) + 1e-6);
          for (const t of [slotStart(slot), slotStart(slot + 1) - SLOT_MARGIN_MS]) expect(life.positionAt(a, t)).toMatchObject({ band: "street", x: hx, frame: expect.stringMatching(/^emp\.bench/) });
          for (let t = slotStart(slot); t < slotStart(slot + 1); t += 250) {
            const p = life.positionAt(a, t);
            expect(p.band).toBe("street");
            expect(p.layer).toBe("street");
            const beside = p.x === hx || (p.x >= PACE.left[0] && p.x <= PACE.left[1] + 30) || (p.x >= PACE.right[0] - 30 && p.x <= PACE.right[1]);
            expect(beside).toBe(true);
          }
        }
      }
      expect(paced).toBeGreaterThan(0);
    }
  });

  it("reduced motion: no idle trips and still poses (design §14.5)", () => {
    const life = new Life({ ...world(agents, { id: 3, status: "finalized", closesAt: BASE - 1 }), reduced: true });
    const frames = new Set<string>();
    for (let s = 0; s < 20; s++)
      for (const a of agents) {
        expect(life.activity(a, BASE / SLOT_MS + s).kind).toBe("stay");
        for (let t = slotStart(BASE / SLOT_MS + s); t < slotStart(BASE / SLOT_MS + s + 1); t += 3000) frames.add(life.positionAt(a, t).frame);
      }
    expect([...frames].sort()).toEqual(["emp.bench.0", "emp.sit.front", "emp.visitor"]);
  });

  it("has everyone back at the desk when the next task is due to open", () => {
    for (const offset of [5000, 12_000, 17_000]) {
      const next = BASE + SLOT_MS * 3 + offset;
      const life = new Life(world(agents, { id: 2, status: "finalized", closesAt: BASE - 1 }, next));
      const slot = Math.floor(next / SLOT_MS);
      if (offset <= 5000) for (const a of agents) expect(life.activity(a, slot).kind).toBe("stay");
      for (const a of agents) {
        if (a.home.kind !== "seat") continue;
        const p = life.positionAt(a, next);
        expect([p.band, p.x, p.layer]).toEqual([a.home.band, a.home.x, "seat"]);
      }
    }
  });
});
