import { buildTower, type TowerInput } from "@reorg/core";
import { describe, expect, it } from "vitest";
import { bubbleText } from "../src/copy";
import { Camera } from "../src/render/camera";
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
});

describe("bands and culling (W-03, W-05)", () => {
  const input: TowerInput = {
    config: { tier_thresholds_bps: [300, 100, 25, 5], excluded_accounts: [], streak_milestones: [3] },
    totalSupply: 1_000_000n,
    holders: Array.from({ length: 30 }, (_, i) => ({ account_id: `i${i}`, balance: "600" })), // 6 bps: Interns
    employees: [],
    task: null,
    submissions: [],
  };

  it("stacks roof, penthouse, one band per floor, lobby, street, basement", () => {
    const l = buildTower(input);
    const s = bandsOf(l);
    expect(s.bands.map((b) => b.kind)).toEqual(["roof", "penthouse", "floor", "floor", "floor", "floor", "floor", "floor", "lobby", "street", "basement"]);
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
