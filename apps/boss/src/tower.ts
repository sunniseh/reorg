/**
 * The tower for big companies (design §4.3, §12; `GET /api/tower`). Reading every holder,
 * employee and submission takes hundreds of view calls once a memecoin has tens of thousands of
 * holders; every browser doing that on each refresh would break public RPC limits. The boss reads
 * them once per `refreshMs`, lays the tower out with the same `layoutTower()` the client uses, and
 * serves the drawn part (`encodeTower`). A player's own floor is unfolded per request (`you`).
 *
 * The client keeps reading the chain directly while the company is small, and always reads the
 * player's own balance and record from the chain, so the boss never decides what a player sees
 * about themselves. Nothing here signs or writes.
 */
import {
  buildTower,
  encodeTower,
  layoutTower,
  MAX_HOLDER_PAGE,
  MAX_PAGE,
  readAll,
  towerCharacters,
  type TowerCharacter,
  type TowerReader,
  type TowerWire,
  type WalletId,
} from "@reorg/core";
import type { Logger } from "./scheduler";

export type TowerViews = Pick<TowerReader, "getInfo" | "getConfig" | "getTask" | "listHolders" | "listEmployees" | "listSubmissions">;

export interface TowerSnapshot {
  /** Wall-clock ms of the read the layout came from. */
  at: number;
  task_id: number;
  tower: TowerWire;
}

/** Per-player layouts kept between refreshes (a player polls their own view). */
const YOU_CACHE = 512;

export class TowerService {
  private chars: TowerCharacter[] | null = null;
  private base: TowerSnapshot | null = null;
  private yours = new Map<WalletId, TowerSnapshot>();
  private drawnWallets = new Set<WalletId>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly views: TowerViews,
    private readonly opts: { refreshMs: number; log: Logger; now?: () => number },
  ) {}

  /** Reads now, then every `refreshMs`. Failures are logged; the last good tower keeps serving. */
  start(): void {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.refresh();
      } catch (e) {
        this.opts.log.warn("tower read failed", { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.refreshMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One full read of the chain views. */
  async refresh(): Promise<void> {
    const v = this.views;
    const [info, config] = await Promise.all([v.getInfo(), v.getConfig()]);
    const task = info.current_task_id > 0 ? await v.getTask(info.current_task_id) : null;
    const [holders, employees, submissions] = await Promise.all([
      readAll((f, l) => v.listHolders(f, l), MAX_HOLDER_PAGE),
      readAll((f, l) => v.listEmployees(f, l), MAX_PAGE),
      task ? readAll((f, l) => v.listSubmissions(task.id, f, l), MAX_PAGE) : Promise.resolve([]),
    ]);
    const input = { config, totalSupply: BigInt(info.total_supply), holders, employees, task, submissions };
    const chars = towerCharacters(input);
    const layout = buildTower(input);
    this.chars = chars;
    this.drawnWallets = new Set(layout.characters.map((c) => c.wallet));
    this.base = { at: (this.opts.now ?? Date.now)(), task_id: info.current_task_id, tower: encodeTower(layout) };
    this.yours.clear();
    this.opts.log.info("tower read", { holders: holders.length, employees: layout.employees, state: layout.state, folded_floors: layout.foldedFloors });
  }

  /** The tower as `you` sees it (their floor unfolded), or null before the first read. */
  get(you: WalletId | null): TowerSnapshot | null {
    const base = this.base;
    if (!base || !this.chars) return null;
    // Drawn already, or not on a floor at all: everyone's tower is the same.
    if (!you || this.drawnWallets.has(you)) return base;
    const hit = this.yours.get(you);
    if (hit) return hit;
    const me = this.chars.find((c) => c.wallet === you);
    if (!me || me.tier === null) return base;
    const snap = { ...base, tower: encodeTower(layoutTower(this.chars, { you })) };
    if (this.yours.size >= YOU_CACHE) this.yours.clear();
    this.yours.set(you, snap);
    return snap;
  }
}
