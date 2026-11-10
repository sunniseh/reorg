import { buildTower, DRAWN_FLOORS, type TowerLayout } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { Cast } from "../src/agents/cast";
import { sample, type Pose } from "../src/agents/track";
import { Director, hiddenBefore, homesOf, lifeOf, type DirectorFx, type DirectorModel } from "../src/director";
import { Nav, POINTS } from "../src/nav";
import { bandsOf } from "../src/render/geometry";
import { SimSource } from "../src/state/sim";
import { effectiveStatus, type Snapshot } from "../src/state/types";

const EPOCH = 75_000;

function layoutOf(s: Snapshot): TowerLayout {
  return buildTower({ config: s.config, totalSupply: s.totalSupply, holders: s.holders, employees: s.employees, task: s.task, submissions: s.submissions, isCrowd: s.isCrowd });
}

interface Calls {
  alarm: number[];
  deskAt: [string, number][];
  outbox: [string, number][];
  payday: [string, bigint, number][];
  bubble: number[];
  vault: number[];
}

/** Drives a seeded SimSource second by second through the director, like the renderer does. */
function run(epochs: number, size = 24, seed = "dir", joinAtSec: number | null = null) {
  let now = 1_800_000_000_000;
  const sim = new SimSource({ size, seed, epochMs: EPOCH, history: 6, firstOpenInMs: 4000, clock: () => now, manual: true });
  const calls: Calls = { alarm: [], deskAt: [], outbox: [], payday: [], bubble: [], vault: [] };
  const fx: DirectorFx = {
    alarm: (t) => calls.alarm.push(t),
    deskAt: (w, t) => calls.deskAt.push([w, t]),
    statusAt: () => undefined,
    outboxAt: (w, t) => calls.outbox.push([w, t]),
    payday: (w, p, t) => calls.payday.push([w, p, t]),
    bubbleAt: (t) => calls.bubble.push(t),
    vaultPulse: (t) => calls.vault.push(t),
  };
  let snap = sim.snapshot();
  let layout = layoutOf(snap);
  let keys = layout.floors.map((f) => f.key).join();
  let nav = new Nav(bandsOf(layout));
  const cast = new Cast(nav, lifeOf(nav, snap, homesOf(layout, nav)));
  const director = new Director(cast, fx);
  let prev: DirectorModel | null = null;
  const outside: string[] = [];
  let floorChanges = 0;
  const keysAtStart = keys;
  const steps: { t: number; snap: Snapshot; layout: TowerLayout; prev: DirectorModel | null; poses: Map<string, Pose>; scripted: Set<string> }[] = [];
  const apply = (animate: boolean) => {
    snap = sim.snapshot();
    layout = layoutOf(snap);
    const k = layout.floors.map((f) => f.key).join();
    if (k !== keys) {
      keys = k;
      nav = new Nav(bandsOf(layout));
    }
    const next: DirectorModel = { layout, snap, now, animate, reducedMotion: false };
    director.apply(prev, next, nav);
    const poses = new Map<string, Pose>();
    const scripted = new Set<string>();
    for (const [w, c] of cast.ctls) {
      const p = c.pose(now, cast.life);
      poses.set(w, p);
      if (c.busy(now)) scripted.add(w);
      // Every pose lies inside its band (stale coordinates after a floor change would not).
      const b = nav.band(p.band);
      const bottom = b.kind === "street" ? b.floorY : b.top + (b.kind === "floor" ? 52 : 70);
      if (p.alpha > 0 && p.layer !== "cab" && !p.frame.startsWith("emp.climb") && (p.y < b.top - 1 || p.y > bottom + 1)) outside.push(`${w} ${p.band} y${p.y} [${b.top}, ${bottom}] ${p.frame}`);
    }
    if (k !== keysAtStart) floorChanges++;
    steps.push({ t: now, snap, layout, prev, poses, scripted });
    prev = next;
  };
  apply(false);
  for (let i = 0; i < (epochs * EPOCH) / 1000; i++) {
    if (i === joinAtSec) void sim.wallet().connect();
    now += 1000;
    sim.advance(now);
    apply(true);
  }
  return { steps, calls, cast, outside, floorChanges };
}

describe("director (W-08)", () => {
  const { steps, calls, cast, outside } = run(14);

  it("keeps every character inside its band, also when floors are added or removed", () => {
    expect(outside).toEqual([]);
    // The player joining spills the Interns onto a second floor: everything below shifts down.
    const r = run(4, 37, "grow", 20); // 18 Interns: one full floor
    expect(r.outside).toEqual([]);
    expect(r.floorChanges).toBeGreaterThan(0);
  });

  it("plays nothing for the first model (late joiners see state)", () => {
    const { steps: s0, cast: c0, calls: k0 } = run(0);
    expect(s0[0]!.poses.size).toBeGreaterThan(10);
    for (const ctl of c0.ctls.values()) expect(ctl.script).toBeNull();
    expect(k0.alarm.length + k0.payday.length + k0.outbox.length).toBe(0);
  });

  it("rings the alarm once per task opening", () => {
    const opens = steps.filter((s, i) => i > 0 && s.snap.task?.id !== steps[i - 1]!.snap.task?.id && s.snap.task?.status === "open").length;
    expect(opens).toBeGreaterThan(10);
    expect(calls.alarm.length).toBe(opens);
  });

  it("keeps everyone who has not filed at the desk while a task is open", () => {
    for (const s of steps) {
      const task = s.snap.task;
      if (!task || effectiveStatus(task, s.t) !== "open") continue;
      // Give the rush its 3 s.
      if (s.t - Number(BigInt(task.opens_at) / 1_000_000n) < 3200) continue;
      for (const c of s.layout.characters) {
        if (c.tier === null || c.status === "laid_off" || c.submitted) continue;
        const p = s.poses.get(c.wallet);
        if (!p || s.scripted.has(c.wallet)) continue;
        expect(p.layer).toBe("seat");
      }
    }
  });

  it("walks each submission to the outbox with a sheet", () => {
    expect(calls.outbox.length).toBeGreaterThan(50);
    const carried = steps.some((s) => [...s.poses.values()].some((p) => p.prop === "paper" && Math.abs(p.x - (POINTS.outbox - 6)) < 40));
    expect(carried).toBe(true);
  });

  it("finalize: results first, payday after, the boss's summary last", () => {
    expect(calls.payday.length).toBeGreaterThan(20);
    expect(calls.bubble.length).toBeGreaterThan(5);
    for (const b of calls.bubble) {
      for (const [, , t] of calls.payday.filter(([, , t]) => t <= b && t > b - 8000)) expect(t).toBeLessThan(b);
    }
  });

  it("everyone is seated when results arrive", () => {
    for (const s of steps) {
      if (!s.prev || s.snap.task?.status !== "finalized" || s.prev.snap.task?.status === "finalized") continue;
      for (const c of s.layout.characters) {
        if (c.tier === null || c.status === "laid_off" || c.result === null) continue;
        const p = s.poses.get(c.wallet);
        // Anyone still out (a late submitter) is running home under a script.
        if (p && p.layer !== "seat") expect(s.scripted.has(c.wallet)).toBe(true);
      }
    }
  });

  it("walks the laid off out to the street and the rehired back to their desks", () => {
    const layoffs: string[] = [];
    const rehires: string[] = [];
    steps.forEach((s, i) => {
      if (i === 0) return;
      const before = new Map(steps[i - 1]!.layout.characters.map((c) => [c.wallet, c]));
      for (const c of s.layout.characters) {
        const b = before.get(c.wallet);
        if (!b) continue;
        if (c.status === "laid_off" && b.status !== "laid_off") layoffs.push(c.wallet);
        if (b.status === "laid_off" && c.status !== "laid_off" && c.tier !== null) rehires.push(c.wallet);
      }
    });
    expect(layoffs.length).toBeGreaterThan(0);
    const last = steps[steps.length - 1]!;
    for (const w of layoffs) {
      const c = last.layout.characters.find((x) => x.wallet === w);
      if (c?.status === "laid_off") expect(last.poses.get(w)!.band).toBe("street");
    }
    for (const w of rehires) {
      const c = last.layout.characters.find((x) => x.wallet === w);
      if (c && c.status !== "laid_off" && c.tier !== null) expect(last.poses.get(w)!.band).not.toBe("street");
    }
  });

  it("nobody teleports between one-second steps, also across floor changes", () => {
    const check = (st: typeof steps) => {
      const jumps: string[] = [];
      for (let i = 1; i < st.length; i++) {
        for (const [w, p] of st[i]!.poses) {
          const q = st[i - 1]!.poses.get(w);
          if (!q || p.alpha < 1 || q.alpha < 1) continue;
          // 48 px/s running, plus the 10 px stair landing detour.
          if (Math.abs(p.x - q.x) > 60) jumps.push(`${i} ${w} ${q.band}:${Math.round(q.x)} → ${p.band}:${Math.round(p.x)}`);
        }
      }
      return jumps;
    };
    expect(check(steps)).toEqual([]);
    expect(check(run(4, 24, "grow", 20).steps)).toEqual([]);
  });

  it("scripts are continuous: no teleports between frames", () => {
    for (const ctl of cast.ctls.values()) {
      const tr = ctl.script;
      if (!tr) continue;
      let prev = sample(tr, tr.t0);
      for (let t = tr.t0; t <= tr.t1; t += 25) {
        const p = sample(tr, t);
        if (p.layer !== "cab" && prev.layer !== "cab" && p.alpha > 0 && prev.alpha > 0 && p.band === prev.band) expect(Math.abs(p.x - prev.x)).toBeLessThan(6);
        prev = p;
      }
    }
  });
});

describe("unfolding (design §4.3)", () => {
  it("a floor that unfolds for the player was there all along: nobody on it arrives", () => {
    let now = 1_800_000_000_000;
    const sim = new SimSource({ size: 1200, seed: "fold", epochMs: EPOCH, history: 1, firstOpenInMs: 4000, clock: () => now, manual: true });
    const s = sim.snapshot();
    const input = { config: s.config, totalSupply: s.totalSupply, holders: s.holders, employees: s.employees, task: s.task, submissions: s.submissions };
    const before = buildTower(input);
    expect(before.folds.length).toBeGreaterThan(0);
    // Someone deep in the folded Intern floors badges in.
    const f = before.folds[0]!;
    const all = buildTower(input, { drawnFloors: 100_000 });
    const target = all.floors.find((fl) => fl.tier === 3 && fl.index === f.to)!;
    const you = target.desks.find((c) => c)!.wallet;
    const after = buildTower(input, { you });
    const yours = after.floors[after.desks.get(you)!.floor]!;
    expect(yours.index).toBe(f.to);
    expect(yours.index).toBeGreaterThanOrEqual(DRAWN_FLOORS);
    for (const c of yours.desks) if (c) expect(hiddenBefore(before, after, c)).toBe(true);
    // A drawn floor's people were never hidden.
    const first = after.floors.find((fl) => fl.tier === 3)!.desks.find((c) => c)!;
    expect(hiddenBefore(before, after, first)).toBe(false);
    now += 1;
  });
});
