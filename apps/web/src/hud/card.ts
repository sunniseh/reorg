/**
 * RgCharacterCard and RgTooltip (design §3, §15.2). The card is anchored next to its character and
 * follows it while the camera pans; it closes on Escape, on a tap outside and with its button.
 * Crowd accounts carry a SIMULATED tag (design §12.5).
 */
import type { TowerCharacter } from "@reorg/core";
import type { EmployeeView } from "@reorg/core";
import { payout, plural, share, shortName, TIER_TITLES } from "../format";
import { h, render } from "./dom";
import { icon, portrait } from "./sprites";

/** The last results as the desk's pass and miss dots (oldest first), text in the label. */
export function recentDots(results: EmployeeView["recent"]): HTMLElement {
  return h(
    "span",
    { class: "recent", role: "img", "aria-label": results.map((r) => `day ${r.task_id}: ${r.result}`).join(", ") },
    ...[...results].reverse().map((r) =>
      r.result === "pass"
        ? h("span", { class: "dot pass", title: `Day ${r.task_id}: pass` }, icon("fx.dot.pass"))
        : r.result === "pending"
          ? h("span", { class: "dot pending", title: `Day ${r.task_id}: pending` })
          : h("span", { class: `dot ${r.result}`, title: `Day ${r.task_id}: ${r.result}` }, icon("fx.dot.miss")),
    ),
  );
}

const STATUS: Record<TowerCharacter["status"], string> = {
  new_hire: "New hire",
  active: "Active",
  struggling: "Struggling",
  laid_off: "Laid off",
  visitor: "Visitor",
};

export function titleOf(c: TowerCharacter): string {
  return c.tier === null ? "Visitor" : TIER_TITLES[c.tier];
}

export class RgCard {
  readonly el = h("aside", { class: "card surface", role: "dialog", "aria-label": "Employee card", hidden: true });
  private wallet: string | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly onClose: () => void) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.wallet && !e.defaultPrevented) {
        // Handled: the staff list behind the card stays open for this Escape.
        e.preventDefault();
        this.close();
      }
    });
  }

  get current(): string | null {
    return this.wallet;
  }

  private renderedKey = "";

  /** `you`: this is the badged-in player's own card (the emphasized variant, design §15.2). */
  open(c: TowerCharacter, simulated: boolean, layoffAfter: number, you = false): void {
    const first = this.wallet !== c.wallet;
    // Re-render only when something shown changed, so keyboard focus survives snapshots.
    const e0 = c.employee;
    const key = [c.wallet, c.status, c.tier, c.sharePpm, c.streak, c.missesInRow, c.layoffTasksLeft, c.result, c.submitted, c.pay, e0?.total_earned, e0?.badges, JSON.stringify(e0?.recent ?? []), simulated, you].join("|");
    if (!first && key === this.renderedKey && !this.el.hidden) return;
    this.renderedKey = key;
    this.wallet = c.wallet;
    if (first) this.returnFocus = document.activeElement as HTMLElement | null;
    const e = c.employee;
    const closeBtn = h("button", { class: "btn icon small close", "aria-label": "Close" }, "✕");
    closeBtn.addEventListener("click", () => this.close());
    const results = e?.recent ?? [];
    this.el.classList.toggle("you", you);
    this.el.setAttribute("aria-label", you ? "Your employee card" : "Employee card");
    render(
      this.el,
      closeBtn,
      h(
        "div",
        { class: "id" },
        portrait(c.wallet, { tier: c.tier, kind: c.status === "visitor" ? "visitor" : "employee", scale: 3 }),
        h(
          "div",
          { class: "id-text" },
          h("h2", { title: c.wallet }, shortName(c.wallet), you ? h("span", { class: "chip accent" }, "You") : null),
          h("div", { class: "title" }, `${titleOf(c)} · ${STATUS[c.status]}`),
          shortName(c.wallet) !== c.wallet ? h("div", { class: "account" }, c.wallet) : null,
        ),
      ),
      h(
        "div",
        { class: "tags" },
        c.crowd || simulated ? h("span", { class: "chip sim" }, "SIMULATED") : null,
        c.status === "new_hire" ? h("span", { class: "chip" }, "NEW") : null,
        e && e.badges & 1 ? h("span", { class: "chip good" }, "Rehired") : null,
        c.result === "pass" ? h("span", { class: "chip good" }, "Passed today") : c.result === "miss" ? h("span", { class: "chip bad" }, "Missed today") : null,
        c.submitted ? h("span", { class: "chip accent" }, "Filed") : null,
      ),
      h(
        "dl",
        {},
        h("dt", {}, "Share of supply"),
        h("dd", {}, share(c.sharePpm)),
        h("dt", {}, "Streak"),
        h("dd", {}, plural(c.streak, "day")),
        c.status === "laid_off" ? h("dt", {}, "Layoff") : h("dt", {}, "Misses in a row"),
        c.status === "laid_off" ? h("dd", {}, `${plural(c.layoffTasksLeft, "task")} left`) : h("dd", {}, `${c.missesInRow} of ${layoffAfter}`),
        h("dt", {}, "Total earned"),
        h("dd", {}, payout(e?.total_earned ?? "0")),
        c.pay > 0n ? h("dt", {}, "Today’s pay") : null,
        c.pay > 0n ? h("dd", { class: "good" }, icon("prop.coin.0"), " ", payout(c.pay)) : null,
      ),
      results.length
        ? h("div", { class: "last7" }, h("span", { class: "label" }, "Last 7 days"), recentDots(results))
        : h("div", { class: "muted" }, c.status === "visitor" ? "Holds too little to be on payroll." : "No results yet."),
    );
    this.el.hidden = false;
    if (first) closeBtn.focus({ preventScroll: true });
  }

  /** Places the card beside the character's head (screen px), kept inside the stage. */
  place(x: number, y: number, bounds: { w: number; h: number; top: number; bottom: number }): void {
    if (this.el.hidden) return;
    const r = this.el.getBoundingClientRect();
    if (r.width > bounds.w * 0.6) {
      // Narrow screens: the card spans the width, so it goes below the character, or above it.
      const below = y + 34;
      const top = below + r.height <= bounds.h - bounds.bottom - 8 ? below : Math.max(bounds.top + 8, y - 30 - r.height);
      this.el.style.top = `${Math.round(top)}px`;
      return;
    }
    let left = x + 18;
    if (left + r.width > bounds.w - 8) left = x - 18 - r.width;
    left = Math.max(8, Math.min(bounds.w - r.width - 8, left));
    const top = Math.max(bounds.top + 8, Math.min(bounds.h - bounds.bottom - r.height - 8, y - 20));
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  close(): void {
    if (!this.wallet) return;
    this.wallet = null;
    this.el.hidden = true;
    this.returnFocus?.focus?.({ preventScroll: true });
    this.onClose();
  }
}

export class RgTooltip {
  readonly el = h("div", { class: "tooltip surface", role: "tooltip", hidden: true });

  show(c: TowerCharacter, x: number, y: number): void {
    render(this.el, h("b", {}, shortName(c.wallet)), ` · ${titleOf(c)} · ${share(c.sharePpm)}${c.streak ? ` · streak ${c.streak}` : ""}${c.crowd ? " · SIMULATED" : ""}`);
    this.el.hidden = false;
    this.el.style.left = `${Math.round(x + 14)}px`;
    this.el.style.top = `${Math.round(y - 34)}px`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
