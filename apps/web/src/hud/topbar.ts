/**
 * RgTopBar and the company popover (design §3, §3 "Task status in the top bar", §10, §12.4–§12.5).
 * Day = task id. The countdown ticks every second from the corrected clock.
 */
import type { TowerLayout } from "@reorg/core";
import { countdown, payout, plural, TIER_PLURALS } from "../format";
import { vaultModel } from "../render/derive";
import { effectiveStatus, nsToMs, type Snapshot } from "../state/types";
import { h, render, setText } from "./dom";

export const PREVIEW_SIZES = [8, 24, 60] as const;

export interface TopBarHandlers {
  preview(on: boolean, size: number): void;
  goToDesk(): void;
}

export interface TopBarModel {
  snap: Snapshot;
  layout: TowerLayout;
  /** The building shows the simulated preview. */
  preview: boolean;
  /** No live chain is configured: the preview is all there is. */
  standalone: boolean;
  previewSize: number;
  badged: boolean;
}

export function statusText(snap: Snapshot, now: number): { text: string; cls: string } {
  const t = snap.task;
  if (!t) return { text: "No task posted. The boss is in a meeting.", cls: "" };
  const s = effectiveStatus(t, now);
  if (s === "open") return { text: `Open. Closes in ${countdown(nsToMs(t.closes_at) - now)}.`, cls: "open" };
  if (s === "closed" || s === "finalizing") return { text: "Closed. Results pending.", cls: "pending" };
  const next = snap.nextOpenAt;
  return { text: next && next > now ? `Finalized. Next memo in ${countdown(next - now)}.` : "Finalized.", cls: "" };
}

export class RgTopBar {
  readonly el: HTMLElement;
  private readonly day = h("span", { class: "day" });
  private readonly status = h("span", { class: "status", role: "timer", "aria-live": "off" });
  private readonly reserve = h("span", { class: "seg reserve" });
  private readonly headcount = h("button", { class: "btn small", "aria-haspopup": "dialog", "aria-expanded": "false" });
  private readonly crowd = h("span", { class: "chip sim wide-only" });
  private readonly stale = h("span", { class: "stale wide-only", title: "The last reads failed; the picture may be a little old." });
  private readonly previewBtn = h("button", { class: "btn small wide-only", "aria-pressed": "false" }, "Preview growth");
  private readonly sizes = h("span", { class: "preview-sizes wide-only", role: "group", "aria-label": "Preview size" });
  private readonly deskBtn = h("button", { class: "btn small" }, "Go to my desk");
  private readonly popover = h("div", { class: "popover surface", role: "dialog", "aria-label": "Company", hidden: true });
  private model: TopBarModel | null = null;
  private sizesKey = "";
  private popoverKey = "";

  constructor(private readonly handlers: TopBarHandlers) {
    this.el = h(
      "header",
      { class: "topbar" },
      h("span", { class: "mark", "aria-label": "REORG" }, "REORG", h("span", {}, ".")),
      h("span", { class: "seg" }, this.day),
      h("span", { class: "seg grow" }, this.status),
      h("span", { class: "sep wide-only" }),
      this.reserve,
      h("span", { class: "spacer" }),
      this.stale,
      this.crowd,
      this.sizes,
      this.previewBtn,
      this.deskBtn,
      this.headcount,
    );
    this.headcount.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
    });
    this.previewBtn.addEventListener("click", () => {
      const m = this.model;
      if (m) handlers.preview(!m.preview, m.previewSize);
    });
    this.deskBtn.addEventListener("click", () => handlers.goToDesk());
    document.addEventListener("click", (e) => {
      if (!this.popover.hidden && !this.popover.contains(e.target as Node)) this.togglePopover(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.popover.hidden) {
        this.togglePopover(false);
        this.headcount.focus();
      }
    });
  }

  get popoverEl(): HTMLElement {
    return this.popover;
  }

  private togglePopover(open = this.popover.hidden): void {
    this.popover.hidden = !open;
    this.headcount.setAttribute("aria-expanded", String(open));
    if (open && this.model) this.renderPopover(this.model);
  }

  update(m: TopBarModel, now: number): void {
    this.model = m;
    const { snap, layout } = m;
    setText(this.day, snap.task ? `Day ${snap.task.id}` : "Day 0");
    const v = vaultModel(snap.treasury, snap.config.reserve_low);
    render(
      this.reserve,
      h("span", { class: "wide-only" }, "Reserve "),
      h("b", {}, payout(v.reserve, { digits: 1 })),
      h("span", { class: "muted wide-only" }, v.noCosts ? " · no operating costs" : ` · runway ${plural(v.runway ?? 0, "task")}`),
      v.low ? h("span", { class: "chip bad" }, "LOW") : null,
    );
    render(this.headcount, String(layout.employees), h("span", { class: "long" }, layout.employees === 1 ? " employee" : " employees"));
    this.headcount.setAttribute("aria-label", `${plural(layout.employees, "employee")}: company details`);
    const bots = layout.characters.filter((c) => c.crowd).length;
    this.crowd.hidden = m.preview || bots === 0;
    setText(this.crowd, `Crowd: simulated (${plural(bots, "bot")})`);
    this.stale.hidden = !snap.stale;
    setText(this.stale, "Reconnecting…");
    this.previewBtn.hidden = m.standalone;
    this.previewBtn.setAttribute("aria-pressed", String(m.preview));
    this.sizes.classList.toggle("on", m.preview);
    const sizesKey = `${m.preview}|${m.previewSize}`;
    if (sizesKey !== this.sizesKey) {
      this.sizesKey = sizesKey;
      render(
      this.sizes,
      ...PREVIEW_SIZES.map((n) => {
        const b = h("button", { class: "btn small", "aria-pressed": String(m.previewSize === n), title: `Preview with ${n} holders` }, String(n));
        b.addEventListener("click", () => this.handlers.preview(true, n));
        return b;
      }),
      );
    }
    this.deskBtn.hidden = !m.badged;
    this.tick(now);
    if (!this.popover.hidden) this.renderPopover(m);
  }

  tick(now: number): void {
    const m = this.model;
    if (!m) return;
    const s = statusText(m.snap, now);
    setText(this.status, s.text);
    this.status.className = `status ${s.cls}`;
  }

  private renderPopover(m: TopBarModel): void {
    const { snap, layout } = m;
    const v = vaultModel(snap.treasury, snap.config.reserve_low);
    const bots = layout.characters.filter((c) => c.crowd).length;
    const key = [layout.tierCounts.join(","), layout.bench.length, layout.visitors.length, v.reserve, v.runway, m.preview, m.previewSize, bots, m.standalone].join("|");
    if (key === this.popoverKey && this.popover.childElementCount) return;
    this.popoverKey = key;
    const row = (k: string, val: string | HTMLElement) => h("tr", {}, h("td", {}, k), h("td", {}, val));
    render(
      this.popover,
      h("h3", {}, "Reorg Inc."),
      h(
        "table",
        {},
        ...TIER_PLURALS.map((t, i) => row(t, String(layout.tierCounts[i]))),
        row("Laid off", String(layout.bench.length)),
        row("Visitors", String(layout.visitors.length)),
        row("Reserve", payout(v.reserve, { digits: 2 })),
        row("Runway", v.noCosts ? "No operating costs" : plural(v.runway ?? 0, "task")),
        m.preview ? row("Data", h("span", { class: "chip sim" }, "SIMULATED PREVIEW")) : bots ? row("Crowd", h("span", { class: "chip sim" }, `simulated (${plural(bots, "bot")})`)) : null,
      ),
      // Compact layouts move these controls here (design §10).
      h(
        "div",
        { class: "compact-only", style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" },
        m.standalone
          ? null
          : (() => {
              const b = h("button", { class: "btn small", "aria-pressed": String(m.preview) }, "Preview growth");
              b.addEventListener("click", () => this.handlers.preview(!m.preview, m.previewSize));
              return b;
            })(),
        ...(m.preview
          ? PREVIEW_SIZES.map((n) => {
              const b = h("button", { class: "btn small", "aria-pressed": String(m.previewSize === n) }, `${n}`);
              b.addEventListener("click", () => this.handlers.preview(true, n));
              return b;
            })
          : []),
      ),
    );
  }
}
