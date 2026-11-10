import { buildTower, type TowerInput } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { bubbleText } from "../src/copy";
import { Camera } from "../src/render/camera";
import { annexesOf, mixColor, nightness, skylineSpan } from "../src/render/derive";
import { bandsOf, G, visibleBands } from "../src/render/geometry";

const WORLD_H = 480;

function cam(w: number, h: number, worldH = WORLD_H, insets = { top: 48, bottom: 0 }) {
  const c = new Camera();
  c.resize(w, h, worldH, insets);
  return c;
}

describe("Camera (W-03, design §10)", () => {
  it("uses a whole-number zoom that fits the 380 px width, at least 2× on a laptop", () => {
    expect(cam(1280, 800).zoom).toBe(2);
    expect(cam(1920, 1080).zoom).toBe(2); // the building is taller than the view at 3×: keep 2×
    expect(cam(1920, 1600).zoom).toBe(3); // fits whole at 3×
    expect(cam(800, 900).zoom).toBe(2);
    expect(cam(600, 900).zoom).toBe(1);
  });

  it("fits the width below 1× on phones and turns on tap-to-zoom until rooms reach 44 px", () => {
    const c = cam(360, 740);
    expect(c.zoom).toBeLessThan(1);
    expect(c.fitsBelowOne).toBe(true);
    expect(c.roomsTooSmall).toBe(true);
    c.zoomAt(c.readableZoom(), 180, 400);
    expect(c.zoom * 24).toBeGreaterThanOrEqual(44);
    expect(c.zoomedIn).toBe(true);
    expect(c.roomsTooSmall).toBe(false);
    c.resetZoom();
    expect(c.zoomedIn).toBe(false);
  });

  it("centers the building horizontally, in the area the dock leaves free when it fits there", () => {
    const c = cam(1280, 800);
    const left = c.toScreen(0, 0).x;
    const right = c.toScreen(G.width, 0).x;
    expect(Math.round(left)).toBe(Math.round(1280 - right));
    c.resize(1280, 800, WORLD_H, { top: 48, bottom: 0, right: 384 });
    expect(c.toScreen(G.width, 0).x).toBeLessThanOrEqual(1280 - 384);
  });

  it("pans vertically within the building and never past it", () => {
    const c = cam(1280, 600, 1200);
    c.panBy(0, -1e6);
    const top = c.y;
    expect(c.toScreen(0, 0).y).toBeGreaterThanOrEqual(48);
    c.panBy(0, 1e6);
    expect(c.y).toBeGreaterThan(top);
    const [, y1] = c.visibleY();
    expect(y1).toBeLessThanOrEqual(1200 + 600);
  });

  it("centers a focused point in the free area (Go to my desk)", () => {
    const c = cam(1280, 600, 2000, { top: 48, bottom: 100 });
    c.lookAt(190, 1000);
    const p = c.toScreen(190, 1000);
    expect(Math.round(p.y)).toBe(Math.round(48 + (600 - 48 - 100) / 2));
  });

  it("keeps the world point under the cursor at the same height when zooming (x stays centered while it fits)", () => {
    const c = cam(1280, 800, 3000);
    c.panBy(0, 500);
    const w = c.toWorld(400, 300);
    c.zoomAt(3, 400, 300);
    expect(Math.round(c.toScreen(w.x, w.y).y)).toBe(300);
    expect(Math.round(c.toScreen(0, 0).x)).toBe(Math.round((1280 - 380 * 3) / 2));
  });

  it("pinch zoom snaps to whole numbers, never below the fit zoom (P1)", () => {
    const phone = cam(360, 740);
    const fit = phone.zoom;
    expect(phone.pinchZoom(fit, 1.05)).toBe(fit);
    expect(phone.pinchZoom(fit, 1.4)).toBe(1);
    expect(phone.pinchZoom(fit, 2.4)).toBe(2);
    expect(phone.pinchZoom(2, 0.3)).toBe(fit);
    expect(phone.pinchZoom(5, 3)).toBe(6);
    const laptop = cam(1280, 800);
    expect(laptop.pinchZoom(2, 1.3)).toBe(3);
    expect(laptop.pinchZoom(2, 0.2)).toBe(1);
  });

  it("zooms out to a skyline overview that fits the headquarters and every annex", () => {
    const c = cam(1280, 800, 1600, { top: 48, bottom: 0 });
    expect(c.zoom).toBe(2);
    expect(c.canZoomOut).toBe(true);
    c.span = skylineSpan(6);
    c.overview();
    expect(c.zoomedOut).toBe(true);
    expect(c.zoom).toBeLessThan(1);
    // Every tower and the whole height are on screen, below the top bar.
    const [l, r] = c.span;
    expect(c.toScreen(l, 0).x).toBeGreaterThanOrEqual(0);
    expect(c.toScreen(r, 0).x).toBeLessThanOrEqual(1280);
    expect(c.toScreen(0, 0).y).toBeGreaterThanOrEqual(48);
    expect(c.toScreen(0, 1600).y).toBeLessThanOrEqual(800);
    // Panning cannot push the skyline off center while it fits.
    const x = c.x;
    c.panBy(500, 0);
    expect(c.x).toBe(x);
    c.resetZoom();
    expect(c.zoom).toBe(2);
    expect(c.zoomedOut).toBe(false);
    // Back at the fit zoom the headquarters is centered again, the annexes off to the sides.
    expect(Math.round(c.toScreen(0, 0).x)).toBe(Math.round(1280 - c.toScreen(G.width, 0).x));
  });

  it("can pan across every annex at the fit zoom, not just the headquarters", () => {
    const c = cam(1280, 800, 1600, { top: 48, bottom: 0 });
    expect(c.hasAnnexes).toBe(false);
    c.span = skylineSpan(6);
    expect(c.hasAnnexes).toBe(true);
    c.lookAt(G.width / 2, 800);
    const [l, r] = c.span;
    c.panBy(1e6, 0);
    expect(Math.round(c.toScreen(r, 0).x)).toBeLessThanOrEqual(1280);
    expect(c.toScreen(r, 0).x).toBeGreaterThan(1280 - 40); // the rightmost annex reached
    c.panBy(-1e6, 0);
    expect(c.toScreen(l, 0).x).toBeGreaterThanOrEqual(0);
    expect(c.toScreen(l, 0).x).toBeLessThan(40); // the leftmost annex reached
    expect(c.zoom).toBe(2);
  });

  it("steps through the zoom ladder: overview, ½×, 1×, 2×…", () => {
    const c = cam(1280, 800, 2400);
    c.span = skylineSpan(10);
    const levels = c.zoomLevels();
    expect(levels[0]).toBeCloseTo(c.overviewZoom(), 6);
    expect(levels).toContain(0.5);
    expect(levels.slice(-6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.stepZoom(-1)).toBe(1);
    c.zoomAt(1, 640, 400);
    expect(c.stepZoom(-1)).toBe(0.5);
    c.zoomAt(0.5, 640, 400);
    expect(c.stepZoom(-1)).toBeCloseTo(c.overviewZoom(), 6);
    expect(c.stepZoom(1)).toBe(1);
    // Pinching below 1× snaps to the nearest step.
    expect(c.pinchZoom(1, 0.55)).toBe(0.5);
    expect(c.pinchZoom(1, 0.05)).toBeCloseTo(c.overviewZoom(), 6);
  });

  it("offers no overview when the fit zoom already shows nearly everything", () => {
    const small = cam(1920, 1600, 474);
    expect(small.canZoomOut).toBe(true); // 3× fit, 1× still reachable as before
    expect(small.minZoom()).toBe(1);
    const phone = cam(360, 740, 474);
    expect(phone.canZoomOut).toBe(false);
  });

  it("Follow me targets keep the followed point centered in the free area (P1)", () => {
    const c = cam(360, 740, 2000, { top: 48, bottom: 120 });
    c.zoomAt(2, 180, 400);
    const t = c.targetFor(200, 1200);
    c.x = t.x;
    c.y = t.y;
    const p = c.toScreen(200, 1200);
    expect(Math.round(p.y)).toBe(Math.round(48 + (740 - 48 - 120) / 2));
    expect(Math.round(p.x)).toBe(180);
  });
});

describe("bands and culling (W-03, W-05)", () => {
  const input: TowerInput = {
    config: { tier_thresholds_ppm: [30_000, 10_000, 2_500, 10], excluded_accounts: [], streak_milestones: [3] },
    totalSupply: 1_000_000n,
    holders: Array.from({ length: 30 }, (_, i) => ({ account_id: `i${i}`, balance: "600" })), // 6 bps: Interns
    employees: [],
    task: null,
    submissions: [],
  };

  it("stacks roof, penthouse, one band per floor, lobby, street, basement", () => {
    const l = buildTower(input);
    const s = bandsOf(l);
    // 30 Interns fill two floors of 18; one floor each for the empty tiers above them.
    expect(s.bands.map((b) => b.kind)).toEqual(["roof", "penthouse", "floor", "floor", "floor", "floor", "floor", "lobby", "street", "basement"]);
    for (let i = 1; i < s.bands.length; i++) expect(s.bands[i]!.y).toBe(s.bands[i - 1]!.y + s.bands[i - 1]!.h);
    expect(s.height).toBe(s.bands.at(-1)!.y + s.bands.at(-1)!.h + 10);
  });

  it("draws only the bands in view", () => {
    const s = bandsOf(buildTower(input));
    const floor = s.byKey.get("t3f1")!;
    const seen = visibleBands(s, floor.y + 1, floor.y + floor.h - 1);
    expect(seen.map((b) => b.key)).toEqual(["t3f1"]);
    expect(visibleBands(s, -100, 1e6)).toHaveLength(s.bands.length);
  });
});

describe("bubbleText", () => {
  it("keeps the boss to a line", () => {
    expect(bubbleText("Day 4. Per my last memo: decode it.")).toBe("Per my last memo: decode it.");
    const long = "Orientation exercise. Memo #1 from the Department of Compliance: A mandatory fun initiative was translated into a more agile format. Decode your copy.";
    const b = bubbleText(long);
    expect(b.length).toBeLessThanOrEqual(110);
    expect(b.startsWith("Orientation exercise.")).toBe(true);
  });
});

describe("day and night, the second tower (W-15)", () => {
  const at = (h: number) => Date.UTC(2026, 10, 10, 0, 0, 0) + h * 3_600_000;

  it("follows UTC: day 07–18, night 20–05, eased dusk and dawn, the same for every client", () => {
    expect(nightness(at(12))).toBe(0);
    expect(nightness(at(23))).toBe(1);
    expect(nightness(at(3))).toBe(1);
    expect(nightness(at(19))).toBeCloseTo(0.5, 5);
    expect(nightness(at(6))).toBeCloseTo(0.5, 5);
    for (let h = 0; h < 24; h += 0.25) {
      const n = nightness(at(h));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      // No jumps: a quarter hour never moves the light by more than a step.
      expect(Math.abs(nightness(at(h + 0.25)) - n)).toBeLessThanOrEqual(0.2);
    }
  });

  it("mixes colors channel by channel", () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColor(0x102030, 0x304050, 0.5)).toBe(0x203040);
  });

  it("annex towers hold the folded floors (design §12.2)", () => {
    // Below Megacorp nothing stands beside the building, unless floors are folded.
    expect(annexesOf("skyscraper", 0, 60)).toEqual([]);
    expect(annexesOf("skyscraper", 3, 60)).toEqual([{ floors: 3, drawn: 3, name: "A" }]);
    // The Megacorp twin stands even while empty, at least 2 floors tall, at most the HQ's height.
    expect(annexesOf("megacorp", 0, 60)).toEqual([{ floors: 0, drawn: 2, name: "A" }]);
    expect(annexesOf("megacorp", 50, 60)).toEqual([{ floors: 50, drawn: 50, name: "A" }]);
    // A Megacorp that outgrows its twin adds a second tower.
    expect(annexesOf("megacorp", 500, 60)).toEqual([
      { floors: 250, drawn: 60, name: "A" },
      { floors: 250, drawn: 60, name: "B" },
    ]);
    // A Campus splits its floors over up to 6 towers, the first ones taking the remainder.
    const campus = annexesOf("campus", 130, 60);
    expect(campus.map((a) => a.floors)).toEqual([44, 43, 43]);
    expect(campus.map((a) => a.name)).toEqual(["A", "B", "C"]);
    // A Conglomerate caps at 12; every folded floor is counted once.
    const big = annexesOf("conglomerate", 8_300, 60);
    expect(big).toHaveLength(12);
    expect(big.reduce((a, b) => a + b.floors, 0)).toBe(8_300);
    expect(big.every((a) => a.drawn === 60)).toBe(true);
  });
});
