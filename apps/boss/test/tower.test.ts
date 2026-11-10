// The big-company tower (tower.ts, GET /api/tower): one paged chain read serves every client,
// folded floors keep exact counts, and a player's own floor is unfolded per request.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, DRAWN_FLOORS, ROOMS_PER_FLOOR, decodeTower, type EmployeeView, type HolderEntry } from "@reorg/core";
import config from "../../../protocol/config.default.json";
import { createApi } from "../src/api";
import { silentLogger } from "../src/scheduler";
import { TowerService, type TowerViews } from "../src/tower";
import { makeWorld, type World } from "./helpers";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
/** Intern rooms per floor. */
const I = ROOMS_PER_FLOOR[3];

/** `n` Interns with strictly descending balances, read through pages like the real views. */
function views(n: number): TowerViews & { calls: number } {
  const holders: HolderEntry[] = Array.from({ length: n }, (_, i) => ({
    account_id: `i${String(i).padStart(6, "0")}.test`,
    balance: (SUPPLY / 50_000n + BigInt(n - i)).toString(),
    last_received_at: "0",
  }));
  const employees: EmployeeView[] = [];
  const v = {
    calls: 0,
    getInfo: async () => ({ owner: "o", boss: "b", token: "t", total_supply: SUPPLY.toString(), current_task_id: 0, last_finalized: 0, event_seq: 0, employees: 0 }),
    getConfig: async () => ConfigSchema.parse(config),
    getTask: async () => null,
    listHolders: async (from: number, limit: number) => {
      v.calls++;
      expect(limit).toBeLessThanOrEqual(200);
      return holders.slice(from, from + limit);
    },
    listEmployees: async (from: number, limit: number) => employees.slice(from, from + limit),
    listSubmissions: async () => [],
  };
  return v;
}

describe("TowerService", () => {
  it("reads every page once and folds past DRAWN_FLOORS", async () => {
    const n = I * (DRAWN_FLOORS + 30) + 3;
    const v = views(n);
    const t = new TowerService(v, { refreshMs: 1000, log: silentLogger, now: () => 42 });
    expect(t.get(null)).toBeNull();
    await t.refresh();
    expect(v.calls).toBe(Math.ceil(n / 200)); // pages of 200, each read once
    expect(v.calls).toBeGreaterThan(1);
    const snap = t.get(null)!;
    expect(snap.at).toBe(42);
    const l = decodeTower(snap.tower);
    expect(l.employees).toBe(n);
    expect(l.folds).toHaveLength(1);
    expect(l.folds[0]!.employees).toBe(I * 30 + 3);
    expect(l.characters.length).toBe(I * DRAWN_FLOORS);
  });

  it("unfolds the asking player's floor, and serves the shared tower to everyone else", async () => {
    const t = new TowerService(views(I * (DRAWN_FLOORS + 10)), { refreshMs: 1000, log: silentLogger });
    await t.refresh();
    const deep = `i${String(I * (DRAWN_FLOORS + 5) + 3).padStart(6, "0")}.test`;
    const mine = decodeTower(t.get(deep)!.tower);
    expect(mine.desks.has(deep)).toBe(true);
    expect(mine.folds).toHaveLength(2);
    expect(t.get(deep)).toBe(t.get(deep)); // cached until the next read
    expect(t.get("i000000.test")).toBe(t.get(null)); // drawn already
    expect(t.get("stranger.test")).toBe(t.get(null)); // not a holder
  });
});

describe("GET /api/tower", () => {
  let world: World;
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    world?.close();
  });

  async function boot(tower?: TowerService) {
    world = makeWorld();
    server = createApi({ store: world.store, health: () => world.scheduler.health(), origins: [], now: world.clock.now, ...(tower ? { tower } : {}) });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("is 404 when off, 503 before the first read, then the layout", async () => {
    let base = await boot();
    expect((await fetch(`${base}/api/tower`)).status).toBe(404);
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    world.close();
    const t = new TowerService(views(30), { refreshMs: 1000, log: silentLogger });
    base = await boot(t);
    expect((await fetch(`${base}/api/tower`)).status).toBe(503);
    await t.refresh();
    const res = await fetch(`${base}/api/tower?you=i000003.test`);
    expect(res.status).toBe(200);
    expect(decodeTower(((await res.json()) as { tower: never }).tower).employees).toBe(30);
    expect((await fetch(`${base}/api/tower?you=${"x".repeat(200)}`)).status).toBe(400);
  });
});
