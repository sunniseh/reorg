/**
 * The client wiring (roadmap §7): one active StateSource → `buildTower` (packages/core) → the
 * Pixi stage and the DOM HUD; the player's wallet for the three player calls. The growth preview
 * swaps the source for a SimSource and never mixes simulated and live characters on one screen
 * (design §12.4). No game rule is decided here: layout and status come from core, the primary
 * button from state/desk.ts.
 */
import { answerHashBase64, buildTower, type TowerCharacter, type TowerLayout, type WalletAdapter, type WalletId } from "@reorg/core";
import { bubbleText, COPY, rejectionCopy } from "./copy";
import { payout, plural, shortName, TIER_PLURALS, TIER_TITLES } from "./format";
import { RgCard, RgTooltip } from "./hud/card";
import { RgDeskDock, type DockMessage } from "./hud/dock";
import { h } from "./hud/dom";
import { RgFeed } from "./hud/feed";
import { ledgerContent, RgDialog, RgSimBanner, RgToast } from "./hud/overlays";
import { RgTopBar } from "./hud/topbar";
import { Atlas } from "./render/atlas";
import { passRateText } from "./render/derive";
import { RgStage } from "./render/stage";
import { deskModel, type DeskModel } from "./state/desk";
import { SimSource } from "./state/sim";
import { effectiveStatus, type FeedItem, type PlayerView, type Puzzle, type Snapshot, type StateSource } from "./state/types";

export interface WalletOption {
  id: string;
  label: string;
  description: string;
  create(): WalletAdapter;
}

export interface AppOptions {
  /** The live source, or null when no chain is configured (standalone preview). */
  live: StateSource | null;
  /** Ways to badge in on the live chain (burner in demo mode, a NEAR wallet). */
  wallets: WalletOption[];
  previewSize: number;
  /** Explorer link for a transaction hash (null on a local chain). */
  txUrl?: (hash: string) => string | null;
  /** Explorer link for an account (null on a local chain). */
  accountUrl?: (account: string) => string | null;
  /** The REORG contract (the ledger links to its transactions). */
  contractId?: string;
}

/** Building states as the boss says them (design §12.2). */
const STATE_NAMES: Record<string, string> = { garage: "garage startup", office: "small office", tower: "office tower", skyscraper: "skyscraper", megacorp: "megacorp" };

const BOSS_KINDS = new Set<FeedItem["kind"]>(["task", "results", "layoff", "rehire"]);

export class App {
  private readonly stage = new RgStage();
  private readonly topbar: RgTopBar;
  private readonly feedView = new RgFeed();
  private readonly dock: RgDeskDock;
  private readonly card: RgCard;
  private readonly tooltip = new RgTooltip();
  private readonly banner = new RgSimBanner();
  private readonly toast = new RgToast();
  private readonly dialog: RgDialog;
  private readonly zoomOut = h("button", { class: "btn small surface zoom-out", hidden: true }, "Zoom out");

  private source!: StateSource;
  private preview: SimSource | null = null;
  private previewSize: number;
  private unsub: (() => void)[] = [];
  private snap: Snapshot | null = null;
  private layout: TowerLayout | null = null;
  /** Feed lines the client derives from state changes (new hires, promotions, layoffs, growth). */
  private derived: FeedItem[] = [];
  /** What the building draws (held while a task is Finalizing). */
  private scene: { snap: Snapshot; layout: TowerLayout } | null = null;
  private firstModel = true;
  private bubble: string | null = null;
  private seenFeed = new Set<string>();
  private liveWallet: WalletAdapter | null = null;
  private player: PlayerView | null = null;
  private playerAt = 0;
  private playerLoading = false;
  private puzzle: Puzzle | null = null;
  private puzzleLoading = false;
  private puzzleTried = { key: "", at: 0 };
  private playerAgain = false;
  private busy: "submit" | "claim" | "connect" | null = null;
  private message: DockMessage | null = null;
  private lastDesk: DeskModel | null = null;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private ariaKey = "";
  private statusKey = "";
  private pendingFocus = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: AppOptions,
  ) {
    this.previewSize = opts.previewSize;
    this.topbar = new RgTopBar({ preview: (on, size) => this.setPreview(on, size), goToDesk: () => this.goToDesk() });
    this.dock = new RgDeskDock({
      primary: () => void this.onPrimary(),
      submit: (a) => void this.submit(a),
      disconnect: () => void this.disconnect(),
      goToDesk: () => this.goToDesk(),
    });
    this.card = new RgCard(() => undefined);
    const hud = root.querySelector<HTMLElement>("#hud")!;
    this.dialog = new RgDialog(hud);
    hud.append(this.topbar.el, this.topbar.popoverEl, this.banner.el, this.feedView.el, this.dock.el, this.card.el, this.tooltip.el, this.toast.el, this.zoomOut);
    this.zoomOut.addEventListener("click", () => {
      this.stage.resetZoom();
      this.zoomOut.hidden = true;
    });
  }

  async start(): Promise<void> {
    const stageEl = this.root.querySelector<HTMLElement>("#stage")!;
    const atlas = await Atlas.load();
    await this.stage.init(
      stageEl,
      atlas,
      {
        select: (w) => this.select(w),
        hover: (w, x, y) => this.hover(w, x, y),
        vault: () => this.openLedger(),
        caughtUp: (n) => {
          const at = this.source.now();
          this.derived.unshift({ id: `d-catchup-${at}`, at, kind: "system", source: "system", text: `While you were away, ${plural(n, "person", "people")} changed places. HR has updated the seating chart.` });
          this.updateFeed();
        },
      },
      () => this.source.now(),
    );
    this.stage.reducedMotion = this.reducedMotion.matches;
    this.reducedMotion.addEventListener("change", () => {
      this.stage.reducedMotion = this.reducedMotion.matches;
      this.pushScene();
    });
    this.stage.onFrame(() => this.followCard());
    if (this.opts.live) this.use(this.opts.live);
    else this.use(this.makePreview(this.previewSize));
    setInterval(() => this.everySecond(), 1000);
    window.addEventListener("resize", () => this.updateInsets());
    // Restore a live wallet session quietly (never prompts).
    if (this.opts.live) void this.restoreWallet();
  }

  // ------------------------------------------------------------------ sources

  private makePreview(size: number): SimSource {
    // The demo's 75 s epoch (ROADMAP D11): long enough between tasks for the building to roam.
    const sim = new SimSource({ size, seed: `preview-${size}`, epochMs: 75_000 });
    this.preview = sim;
    return sim;
  }

  private use(src: StateSource): void {
    this.unsub.forEach((u) => u());
    this.source?.stop();
    this.source = src;
    this.firstModel = true;
    this.snap = null;
    this.scene = null;
    this.player = null;
    this.puzzle = null;
    this.message = null;
    this.bubble = null;
    this.seenFeed = new Set(src.feed().map((f) => f.id));
    this.derived = [];
    this.card.close();
    const sim = src.kind === "sim";
    this.banner.show(sim, this.opts.live ? "Bots and made-up numbers. Turn off Preview growth to see the live company." : "No chain is connected here: bots and made-up numbers, for a look around.");
    this.updateInsets();
    this.unsub = [
      src.onSnapshot((s) => this.onSnapshot(s)),
      src.onFeed((items) => this.onFeed(items)),
    ];
    src.start();
    const s = src.snapshot();
    if (s) this.onSnapshot(s);
    this.updateFeed();
    // On load, an open task's memo is already in the boss's bubble.
    if (s?.task && effectiveStatus(s.task, src.now()) === "open" && s.boss) this.bubble = bubbleText(s.boss.task_text);
  }

  private setPreview(on: boolean, size: number): void {
    this.previewSize = size;
    if (!this.opts.live) {
      this.preview?.stop();
      this.use(this.makePreview(size));
      return;
    }
    if (on) {
      this.preview?.stop();
      this.use(this.makePreview(size));
    } else {
      this.preview?.stop();
      this.preview = null;
      this.use(this.opts.live);
    }
  }

  private wallet(): WalletAdapter | null {
    return this.source.kind === "sim" ? this.source.wallet() : this.liveWallet;
  }

  private walletId(): WalletId | null {
    return this.wallet()?.accountId() ?? null;
  }

  // ------------------------------------------------------------------ state → picture

  private onSnapshot(s: Snapshot): void {
    // An action's message belongs to the moment it was filed: a new task state clears it.
    const key = s.task ? `${s.task.id}|${s.task.status}` : "";
    if (this.snap && key !== this.statusKey && !this.busy) this.message = null;
    this.statusKey = key;
    this.snap = s;
    const prevLayout = this.layout;
    this.layout = buildTower({
      config: s.config,
      totalSupply: s.totalSupply,
      holders: s.holders,
      employees: s.employees,
      task: s.task,
      submissions: s.submissions,
      isCrowd: s.isCrowd,
    });
    if (prevLayout && !this.firstModel) this.deriveFeed(prevLayout, this.layout, s);
    // Hold the building while a task is Finalizing: every event of task N plays together once
    // `task_finalized` arrives (design §14.3.1). The HUD shows the newest state meanwhile.
    const hold = s.task?.status === "finalizing" && this.scene !== null && this.scene.snap.task?.id === s.task.id;
    if (!hold) this.scene = { snap: s, layout: this.layout };
    this.pushScene();
    this.firstModel = false;
    this.topbar.update(this.topbarModel(), this.source.now());
    this.updateAria(s);
    if (this.card.current) {
      const c = this.findChar(this.card.current);
      if (c) this.card.open(c, this.source.kind === "sim", s.config.layoff_after);
      else this.card.close();
    }
    void this.refreshPlayer(false);
    this.renderDock();
    this.tryPendingFocus();
  }

  private tryPendingFocus(): void {
    const w = this.walletId();
    if (!this.pendingFocus || !w || !this.findChar(w)) return;
    this.pendingFocus = false;
    setTimeout(() => this.stage.focus(w), 50);
  }

  private pushScene(): void {
    if (!this.scene) return;
    this.stage.update({
      layout: this.scene.layout,
      snap: this.scene.snap,
      you: this.walletId(),
      now: this.source.now(),
      bubble: this.bubble,
      animate: !this.firstModel,
      reducedMotion: this.reducedMotion.matches,
    });
  }

  private onFeed(items: readonly FeedItem[]): void {
    this.updateFeed(items);
    const fresh = items.filter((f) => !this.seenFeed.has(f.id));
    for (const f of fresh) this.seenFeed.add(f.id);
    // The boss speaks the newest of its own lines (design §5.8).
    const spoken = fresh.filter((f) => BOSS_KINDS.has(f.kind) && f.source !== "chain").sort((a, b) => b.at - a.at)[0];
    if (spoken) {
      this.bubble = bubbleText(spoken.text);
      this.pushScene();
    }
    const me = this.walletId();
    const mine = fresh.find((f) => f.wallet === me && (f.kind === "layoff" || f.kind === "rehire" || f.kind === "warning"));
    if (mine) this.toast.show(mine.text);
  }

  /** The source's feed plus the lines derived here, newest first (design §15.2 RgFeed item types). */
  private updateFeed(items: readonly FeedItem[] = this.source.feed()): void {
    if (this.derived.length === 0) return this.feedView.update(items);
    const merged = [...items, ...this.derived].sort((a, b) => b.at - a.at);
    this.feedView.update(merged.slice(0, 60));
  }

  /**
   * Moments that no contract event names (design §14.3): new hires, promotions, layoffs (unless the
   * boss already announced them) and a change of building state, with the boss's line for it.
   */
  private deriveFeed(prev: TowerLayout, next: TowerLayout, s: Snapshot): void {
    const at = this.source.now();
    const before = new Map(prev.characters.map((c) => [c.wallet, c]));
    const recent = this.source.feed().filter((f) => at - f.at < 120_000);
    const announced = (kind: FeedItem["kind"], w: WalletId) => recent.some((f) => f.kind === kind && f.wallet === w);
    const add = (it: Omit<FeedItem, "at" | "source">) => {
      if (this.derived.some((d) => d.id === it.id)) return;
      this.derived.unshift({ ...it, at, source: "system" });
    };
    const task = s.task?.id ?? 0;
    for (const c of next.characters) {
      const b = before.get(c.wallet);
      const name = shortName(c.wallet);
      if (c.tier === null) continue;
      if (!b || b.tier === null) {
        if (!announced("new_hire", c.wallet)) add({ id: `d-hire-${c.wallet}-${task}`, kind: "new_hire", wallet: c.wallet, text: `${name} joined as a new ${TIER_TITLES[c.tier]}. HR has prepared a desk.` });
        continue;
      }
      if (b.tier !== c.tier) {
        const up = c.tier < b.tier;
        add({ id: `d-tier-${c.wallet}-${task}-${c.tier}`, kind: "promotion", wallet: c.wallet, text: up ? `${name} moved up to ${TIER_PLURALS[c.tier]}. Please update the org chart.` : `${name} was reassigned to ${TIER_PLURALS[c.tier]}.` });
      }
      if (c.status === "laid_off" && b.status !== "laid_off" && !announced("layoff", c.wallet)) {
        add({ id: `d-lay-${c.wallet}-${task}`, kind: "layoff", wallet: c.wallet, text: `${name} was laid off after ${plural(s.config.layoff_after, "missed task")}.` });
      }
    }
    if (prev.state !== next.state) {
      const grew = next.employees > prev.employees;
      const line = grew ? "We have outgrown our space." : "We are right-sizing our footprint.";
      add({ id: `d-state-${next.state}-${task}`, kind: "system", text: `${line} Reorg Inc. is now a ${STATE_NAMES[next.state] ?? next.state}.` });
      this.bubble = line;
    }
    this.updateFeed();
    if (this.derived.length > 30) this.derived.length = 30;
  }

  private topbarModel() {
    return {
      snap: this.snap!,
      layout: this.layout!,
      preview: this.source.kind === "sim",
      standalone: !this.opts.live,
      previewSize: this.previewSize,
      badged: !!this.walletId(),
    };
  }

  private updateAria(s: Snapshot): void {
    const t = s.task;
    const status = t ? effectiveStatus(t, this.source.now()) : null;
    const key = `${t?.id}|${status}|${t?.submitted}|${this.layout?.employees}`;
    if (key === this.ariaKey) return;
    this.ariaKey = key;
    const n = this.layout?.employees ?? 0;
    const taskText = !t
      ? "No task posted yet."
      : status === "open"
        ? `Task ${t.id} is open, ${t.submitted} submitted.`
        : status === "finalized"
          ? `Task ${t.id} is finalized: ${passRateText(t)}.`
          : `Task ${t.id} is closed; results pending.`;
    this.root.querySelector("#stage")?.setAttribute("aria-label", `Reorg Inc.${this.source.kind === "sim" ? " (simulated preview)" : ""} ${plural(n, "employee")}. ${taskText}`);
  }

  private everySecond(): void {
    if (!this.snap) return;
    this.topbar.tick(this.source.now());
    this.updateAria(this.snap);
    this.renderDock();
    // Results pending → finalized changes come with snapshots; window closing is derived here.
  }

  private updateInsets(): void {
    const banner = this.source?.kind === "sim" ? this.banner.el.getBoundingClientRect().height || 28 : 0;
    this.root.style.setProperty("--banner-h", `${banner}px`);
    const top = (this.topbar.el.getBoundingClientRect().height || 48) + banner;
    const wide = !window.matchMedia("(max-width: 820px)").matches;
    const right = wide ? this.dock.el.getBoundingClientRect().width + 24 : 0;
    this.stage.setInsets({ top, bottom: this.dock.coveredHeight(), right });
  }

  // ------------------------------------------------------------------ player

  private async refreshPlayer(force: boolean): Promise<void> {
    const w = this.walletId();
    if (!w) {
      this.player = null;
      return;
    }
    const now = Date.now();
    if (this.playerLoading) {
      // A forced refresh (after an action) must not be answered by a read that started before it.
      if (force) this.playerAgain = true;
      return;
    }
    if (!force && now - this.playerAt < 2500 && this.player?.wallet === w) return;
    this.playerLoading = true;
    try {
      const src = this.source;
      const p = await src.player(w);
      if (src !== this.source) return;
      this.player = p;
      this.playerAt = Date.now();
    } catch {
      // Keep the last view; the stale tag in the top bar says reads are failing.
    } finally {
      this.playerLoading = false;
    }
    if (this.playerAgain) {
      this.playerAgain = false;
      return this.refreshPlayer(true);
    }
    this.renderDock();
  }

  private async loadPuzzle(desk: DeskModel): Promise<void> {
    const w = this.walletId();
    const task = this.snap?.task;
    if (!w || !task || !desk.showPuzzle || this.puzzleLoading) return;
    if (this.puzzle && this.puzzle.task_id === task.id) return;
    // One try per task every 5 s: a boss that says "not open" or is down must not be hammered.
    const key = `${w}|${task.id}`;
    if (this.puzzleTried.key === key && Date.now() - this.puzzleTried.at < 5000) return;
    this.puzzleTried = { key, at: Date.now() };
    this.puzzleLoading = true;
    try {
      const src = this.source;
      const p = await src.puzzle(w);
      if (src === this.source) this.puzzle = p;
    } catch (e) {
      this.message = { ...rejectionCopy(e instanceof Error ? e.message : String(e)), tone: "bad" };
    } finally {
      this.puzzleLoading = false;
    }
    this.renderDock();
  }

  private renderDock(): void {
    if (!this.snap) return;
    const w = this.walletId();
    const player = w && this.player?.wallet === w ? this.player : null;
    const desk = deskModel(this.snap, w ? player ?? { wallet: w, holder: { balance: "0", last_received_at: "0" }, employee: null, submission: null, claimables: [] } : null, this.source.now());
    if (w && !player) desk.line = COPY.loading;
    this.lastDesk = desk;
    if (desk.showPuzzle && (!this.puzzle || this.puzzle.task_id !== this.snap.task?.id)) void this.loadPuzzle(desk);
    const previewNote = this.source.kind === "sim" && !!this.opts.live;
    this.dock.update({
      desk,
      player,
      me: w ? this.findChar(w) : null,
      snap: this.snap,
      puzzle: this.puzzle && this.puzzle.task_id === this.snap.task?.id ? this.puzzle : null,
      walletLabel: this.wallet()?.accountId() ? this.wallet()!.label : null,
      busy: this.busy,
      message: this.message,
      previewNote,
    });
    this.updateInsets();
  }

  private async onPrimary(): Promise<void> {
    const p = this.lastDesk?.primary;
    if (!p || this.busy) return;
    if (p.kind === "badge_in") return this.badgeIn();
    if (p.kind === "claim") return this.claim(p.taskId);
  }

  private async badgeIn(): Promise<void> {
    if (this.source.kind === "sim") {
      if (this.opts.live) return; // the preview has no desk for you (design §12.4)
      const sw = this.source.wallet();
      if (sw) return this.connect(sw);
      return;
    }
    const options = this.opts.wallets;
    if (options.length === 0) {
      this.toast.show("No wallet is configured for this deployment.");
      return;
    }
    if (options.length === 1) return this.connect(options[0]!.create());
    const choices = h("div", { class: "choices" });
    for (const o of options) {
      const b = h("button", { class: "btn" }, h("span", {}, h("b", {}, o.label), h("br"), h("span", { class: "muted" }, o.description)));
      b.addEventListener("click", () => {
        this.dialog.close();
        void this.connect(o.create());
      });
      choices.append(b);
    }
    this.dialog.show("Badge in", h("p", { class: "muted", style: "margin:0" }, COPY.badgeIn), choices);
  }

  private async connect(wallet: WalletAdapter): Promise<void> {
    this.busy = "connect";
    this.message = null;
    this.renderDock();
    try {
      await wallet.connect();
      if (this.source.kind !== "sim") this.liveWallet = wallet;
      await this.refreshPlayer(true);
      this.pushScene();
      this.topbar.update(this.topbarModel(), this.source.now());
      // A fresh burner shows up in the next read; focus its desk as soon as it is drawn.
      this.pendingFocus = true;
      this.source.refresh();
      this.tryPendingFocus();
    } catch (e) {
      this.message = { ...rejectionCopy(e instanceof Error ? e.message : String(e)), tone: "bad" };
    } finally {
      this.busy = null;
      this.renderDock();
    }
  }

  private async restoreWallet(): Promise<void> {
    for (const o of this.opts.wallets) {
      const w = o.create();
      try {
        if (await w.restore()) {
          this.liveWallet = w;
          await this.refreshPlayer(true);
          this.pushScene();
          if (this.snap) this.topbar.update(this.topbarModel(), this.source.now());
          return;
        }
      } catch {
        /* try the next one */
      }
    }
  }

  private async disconnect(): Promise<void> {
    const w = this.wallet();
    await w?.disconnect();
    if (this.source.kind !== "sim") this.liveWallet = null;
    this.player = null;
    this.puzzle = null;
    this.message = null;
    this.pushScene();
    if (this.snap) this.topbar.update(this.topbarModel(), this.source.now());
    this.renderDock();
  }

  private async submit(answer: string): Promise<void> {
    const w = this.wallet();
    const id = w?.accountId();
    const task = this.snap?.task;
    if (!w || !id || !task || this.busy) return;
    const clean = answer.trim();
    if (!clean) return;
    this.busy = "submit";
    this.message = { text: COPY.reviewing, tone: "info" };
    this.bubble = COPY.reviewing;
    this.pushScene();
    this.renderDock();
    try {
      const out = await w.submit(task.id, answerHashBase64(clean, id));
      if (out.accepted) {
        const reapply = this.lastDesk?.state === "reapply";
        this.message = { text: reapply ? COPY.reapplyFiled : COPY.submitted, tone: "good" };
        this.dock.clearAnswer();
      } else this.message = { ...rejectionCopy(out.reason), tone: "bad" };
    } catch (e) {
      this.message = { ...rejectionCopy(e instanceof Error ? e.message : String(e)), tone: "bad" };
    } finally {
      this.busy = null;
      this.bubble = null;
      this.source.refresh();
      await this.refreshPlayer(true);
      this.pushScene();
      this.renderDock();
    }
  }

  private async claim(taskId: number): Promise<void> {
    const w = this.wallet();
    if (!w || this.busy) return;
    this.busy = "claim";
    this.message = { text: COPY.claimFiled, tone: "info" };
    this.renderDock();
    try {
      const out = await w.claimSalary(taskId);
      if (out.status === "paid") {
        this.message = { text: `Salary paid: ${payout(out.amount)}. It is in your wallet.`, tone: "good" };
        this.toast.show(`Payroll processed: ${payout(out.amount)} for day ${taskId}.`);
      } else if (out.status === "forfeited") {
        this.message = { text: COPY.forfeited(String((this.snap?.config.antidump_bps ?? 9000) / 100)), tone: "bad" };
      } else this.message = { ...rejectionCopy(out.reason), tone: "bad" };
    } catch (e) {
      this.message = { ...rejectionCopy(e instanceof Error ? e.message : String(e)), tone: "bad" };
    } finally {
      this.busy = null;
      this.source.refresh();
      await this.refreshPlayer(true);
      this.renderDock();
    }
  }

  private goToDesk(): void {
    const w = this.walletId();
    if (w && !this.stage.focus(w)) this.toast.show("Your desk is not in this building yet.");
  }

  // ------------------------------------------------------------------ card, tooltip, ledger

  private findChar(w: WalletId): TowerCharacter | null {
    return this.layout?.characters.find((c) => c.wallet === w) ?? null;
  }

  private select(w: WalletId | null): void {
    // A tap on empty space skips running sequences (design §14.1 rule 4); a tap on someone opens their card.
    if (!w) this.stage.skipAnimations();
    this.tooltip.hide();
    if (!w) {
      this.card.close();
      return;
    }
    const c = this.findChar(w);
    if (!c || !this.snap) return;
    this.card.open(c, this.source.kind === "sim", this.snap.config.layoff_after);
    this.followCard();
    this.zoomOut.hidden = !this.stage.camera.zoomedIn;
  }

  private hover(w: WalletId | null, x: number, y: number): void {
    if (!w || this.card.current === w || window.matchMedia("(hover: none)").matches) return this.tooltip.hide();
    const c = this.findChar(w);
    if (c) this.tooltip.show(c, x, y);
  }

  private followCard(): void {
    this.zoomOut.hidden = !this.stage.camera.zoomedIn;
    const w = this.card.current;
    if (!w) return;
    const p = this.stage.screenOf(w);
    if (!p) return;
    const r = this.root.getBoundingClientRect();
    const top = this.stage.camera.insets.top;
    this.card.place(p.x, p.y, { w: r.width, h: r.height, top, bottom: this.dock.coveredHeight() });
  }

  private openLedger(): void {
    if (!this.snap) return;
    const sim = this.source.kind === "sim";
    this.dialog.show(
      sim ? "Ledger (simulated)" : "Ledger",
      ledgerContent(this.snap.treasury, this.source.ledger(), {
        simulatedIncome: true,
        isCrowd: this.snap.isCrowd,
        ...(!sim && this.opts.accountUrl ? { accountUrl: this.opts.accountUrl } : {}),
        contract: sim ? null : this.opts.contractId ? { id: this.opts.contractId, url: this.opts.accountUrl?.(this.opts.contractId) ?? null } : null,
      }),
    );
  }
}

