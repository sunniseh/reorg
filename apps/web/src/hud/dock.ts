/**
 * RgDeskDock + RgTaskPanel (design §3, §3.1, §15.2; roadmap W-10): the player's desk. Bottom right,
 * 360 px; a bottom sheet at ≤ 820 px. Collapsed it shows the status line and the primary button.
 * Exactly one primary button at a time (desk.ts decides which). The answer input is uppercase,
 * Enter submits; the contract normalizes case and 0→O, 1→I (design §8).
 */
import type { TowerCharacter } from "@reorg/core";
import { multiplierBps } from "@reorg/core";
import { COPY } from "../copy";
import { payout, plural, share, shortName, TIER_TITLES, tokens } from "../format";
import type { DeskModel } from "../state/desk";
import type { PlayerView, Puzzle, Snapshot } from "../state/types";
import { h, render, setText } from "./dom";

export interface DockHandlers {
  primary(): void;
  submit(answer: string): void;
  disconnect(): void;
  goToDesk(): void;
}

export interface DockMessage {
  text: string;
  detail?: string;
  tone: "good" | "bad" | "info";
}

export interface DockModel {
  desk: DeskModel;
  player: PlayerView | null;
  me: TowerCharacter | null;
  snap: Snapshot;
  puzzle: Puzzle | null;
  walletLabel: string | null;
  busy: "submit" | "claim" | "connect" | null;
  message: DockMessage | null;
  /** The building shows the simulated preview while a live chain exists. */
  previewNote: boolean;
}

export class RgDeskDock {
  readonly el: HTMLElement;
  private readonly name = h("div", { class: "name" });
  private readonly line = h("div", { class: "line", "aria-live": "polite" });
  private readonly primary = h("button", { class: "btn primary" });
  private readonly toggle = h("button", { class: "btn icon small", "aria-expanded": "true", "aria-label": "Collapse the desk" }, "▾");
  private readonly body = h("div", { class: "body" });
  private readonly stats = h("div", { class: "stats" });
  private readonly memo = h("div", { class: "memo" });
  private readonly memoBoss = h("p", { class: "boss" });
  private readonly memoCipher = h("div", { class: "cipher", lang: "en" });
  private readonly memoHint = h("div", { class: "hint" });
  private readonly input = h("input", {
    type: "text",
    name: "answer",
    id: "answer",
    inputmode: "text",
    autocapitalize: "characters",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    maxlength: "16",
    placeholder: "8 letters",
    "aria-label": "Your answer",
  });
  private readonly answerRow = h("div", { class: "answer" }, this.input, h("span", { class: "muted", style: "font-size:12px" }, "Enter files it"));
  private readonly msg = h("div", { class: "msg", role: "status" });
  private readonly note = h("p", { class: "note" });
  private readonly actions = h("div", { class: "actions" });
  private puzzleKey = "";
  private model: DockModel | null = null;

  constructor(private readonly handlers: DockHandlers) {
    append(this.memo, this.memoBoss, this.memoCipher, this.memoHint, this.answerRow);
    append(this.body, this.stats, this.note, this.memo, this.msg, this.actions);
    this.el = h(
      "section",
      { class: "dock surface", "aria-label": "My desk" },
      h("div", { class: "bar" }, h("div", { class: "who" }, this.name, this.line), this.primary, this.toggle),
      this.body,
    );
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.el.classList.contains("collapsed")));
    this.primary.addEventListener("click", () => {
      const m = this.model;
      if (!m?.desk.primary) return;
      if ((m.desk.primary.kind === "submit" || m.desk.primary.kind === "reapply") && !this.input.value.trim()) {
        this.setCollapsed(false);
        this.input.focus();
        this.input.setAttribute("aria-invalid", "true");
        return;
      }
      if (m.desk.primary.kind === "submit" || m.desk.primary.kind === "reapply") handlers.submit(this.input.value);
      else handlers.primary();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.input.value.trim()) handlers.submit(this.input.value);
    });
    this.input.addEventListener("input", () => this.input.removeAttribute("aria-invalid"));
    if (window.matchMedia("(max-width: 820px)").matches) this.setCollapsed(true);
  }

  setCollapsed(c: boolean): void {
    this.el.classList.toggle("collapsed", c);
    this.toggle.setAttribute("aria-expanded", String(!c));
    this.toggle.setAttribute("aria-label", c ? "Expand the desk" : "Collapse the desk");
    setText(this.toggle, c ? "▴" : "▾");
  }

  /** Height the dock covers at the bottom of the stage (camera insets). */
  coveredHeight(): number {
    return window.matchMedia("(max-width: 820px)").matches ? this.el.getBoundingClientRect().height : 0;
  }

  clearAnswer(): void {
    this.input.value = "";
  }

  update(m: DockModel): void {
    this.model = m;
    const { desk, player, me, snap } = m;
    // Bar: who, status line, the one primary button.
    setText(this.name, player ? shortName(player.wallet) + (m.walletLabel ? ` · ${m.walletLabel}` : "") : "My desk");
    setText(this.line, m.previewNote ? COPY.previewDock : desk.line);
    const p = m.previewNote ? null : desk.primary;
    this.primary.hidden = !p;
    if (p) {
      const busyLabel = m.busy === "submit" ? "Filing…" : m.busy === "claim" ? "Processing…" : m.busy === "connect" ? "Badging in…" : null;
      setText(this.primary, busyLabel ?? p.label);
      this.primary.disabled = !!m.busy;
    }

    // Stats.
    if (player && !m.previewNote) {
      const emp = player.employee;
      const c = snap.config;
      const title = me?.tier !== null && me?.tier !== undefined ? TIER_TITLES[me.tier] : "Visitor";
      const status = !me ? "" : me.status === "new_hire" ? "New hire" : me.status === "laid_off" ? "Laid off" : me.status === "struggling" ? "Struggling" : "Active";
      const streak = emp?.effective_streak ?? 0;
      const mult = multiplierBps(streak, c.streak_step_bps, c.streak_max_steps) / 10_000;
      const claimable = player.claimables.reduce((a, s) => a + BigInt(s.pay), 0n);
      const stat = (k: string, v: string | HTMLElement) => h("div", {}, h("span", {}, k), h("b", {}, v));
      render(
        this.stats,
        stat("Title", `${title}${status ? ` · ${status}` : ""}`),
        stat("Share of supply", me ? share(me.sharePpm) : tokens(player.holder.balance)),
        stat("Streak", `${plural(streak, "day")} · ×${mult.toFixed(1)}`),
        emp?.status === "laid_off"
          ? stat("Layoff", `${plural(emp.layoff_tasks_left, "task")} left`)
          : stat("Misses in a row", `${emp?.misses_in_row ?? 0} of ${c.layoff_after}`),
        stat("Total earned", payout(emp?.total_earned ?? "0")),
        stat("Claimable", payout(claimable)),
        emp && emp.recent.length
          ? h(
              "div",
              { style: "grid-column: 1 / -1" },
              h("span", {}, "Last 7 days"),
              h(
                "div",
                { class: "recent", role: "img", "aria-label": emp.recent.map((r) => `day ${r.task_id}: ${r.result}`).join(", ") },
                ...[...emp.recent].reverse().map((r) => h("span", { class: `dot ${r.result}`, title: `Day ${r.task_id}: ${r.result}` }, r.result === "pass" ? "✓" : r.result === "pending" ? "·" : "✕")),
              ),
            )
          : null,
      );
      this.stats.hidden = false;
    } else {
      render(this.stats);
      this.stats.hidden = true;
    }

    // Note (claim blocked, reapplication, layoff countdown).
    this.note.hidden = !desk.note || m.previewNote;
    setText(this.note, desk.note ?? "");

    // Memo and the answer input.
    const pz = m.puzzle;
    const showMemo = desk.showPuzzle && !!pz && !m.previewNote;
    this.memo.hidden = !showMemo;
    if (showMemo && pz) {
      const key = `${pz.task_id}|${pz.display}`;
      if (key !== this.puzzleKey) {
        this.puzzleKey = key;
        this.input.value = "";
        setText(this.memoBoss, pz.task_text);
        setText(this.memoCipher, pz.display);
        this.memoCipher.classList.toggle("long", pz.display.length > 48);
        setText(this.memoHint, `${pz.hint} Answer: ${pz.answer_format}.`);
      }
      this.input.disabled = !!m.busy;
    } else if (desk.showPuzzle && !pz && !m.previewNote) {
      this.memo.hidden = false;
      setText(this.memoBoss, COPY.loading);
      setText(this.memoCipher, "");
      setText(this.memoHint, "");
      this.puzzleKey = "";
    }
    this.answerRow.hidden = !showMemo;

    // Message from the last action.
    const msg = m.message;
    this.msg.hidden = !msg;
    if (msg) {
      render(this.msg, h("span", { class: msg.tone === "good" ? "good" : msg.tone === "bad" ? "bad" : "" }, msg.text), msg.detail ? h("span", { class: "detail" }, msg.detail) : null);
    }

    // Secondary actions.
    render(
      this.actions,
      player && !m.previewNote ? btn("Go to my desk", () => this.handlers.goToDesk()) : null,
      player ? btn(m.walletLabel?.includes("Simulated") ? "Leave" : "Badge out", () => this.handlers.disconnect()) : null,
    );
    this.actions.hidden = !player;
  }
}

function btn(label: string, fn: () => void): HTMLButtonElement {
  const b = h("button", { class: "btn small" }, label);
  b.addEventListener("click", fn);
  return b;
}

function append(el: Element, ...c: Element[]): void {
  el.append(...c);
}
