/**
 * RgEmployeeList (roadmap W-18, design §3, §11, §15.2): every drawn character in building order,
 * as a DOM table grouped by floor tier, then the visitors. It is the keyboard and screen-reader
 * path to every card: each name is a button that centers the camera on the character and opens
 * its card. A non-modal panel: the building stays live behind it; Escape closes it (after the card).
 */
import type { TowerCharacter, TowerLayout } from "@reorg/core";
import { plural, share, shortName, TIER_PLURALS, TIER_TITLES } from "../format";
import { h, render } from "./dom";
import { portrait } from "./sprites";

export interface StaffRow {
  wallet: string;
  name: string;
  title: string;
  /** Floor tier (0 = Directors), null for visitors: the badge photo's backdrop. */
  tier: number | null;
  visitor: boolean;
  status: string;
  streak: number;
  share: string;
  /** Today's desk mark: filed, passed, missed, or nothing. */
  today: "Filed" | "Passed" | "Missed" | "";
  simulated: boolean;
  you: boolean;
}

export interface StaffGroup {
  label: string;
  rows: StaffRow[];
}

export interface StaffOptions {
  you: string | null;
  /** The whole building is the simulated preview. */
  simulated: boolean;
  layoffAfter: number;
}

function statusText(c: TowerCharacter, layoffAfter: number): string {
  switch (c.status) {
    case "new_hire":
      return "New hire";
    case "active":
      return "Active";
    case "struggling":
      return `Struggling: ${c.missesInRow} of ${layoffAfter} misses`;
    case "laid_off":
      return `Laid off: ${plural(c.layoffTasksLeft, "task")} left`;
    case "visitor":
      return "Visitor";
  }
}

/**
 * The list's rows in building order (design §4.3: tier, then balance, then account id), with the
 * badged-in player's own card pinned first in a "You" group (and not repeated in its floor). Pure.
 */
export function staffGroups(layout: TowerLayout, opts: StaffOptions): StaffGroup[] {
  const mine: StaffGroup = { label: "You", rows: [] };
  const groups: StaffGroup[] = TIER_PLURALS.map((label) => ({ label, rows: [] }));
  const visitors: StaffGroup = { label: "Visitors", rows: [] };
  for (const c of layout.characters) {
    const row: StaffRow = {
      wallet: c.wallet,
      name: shortName(c.wallet),
      title: c.tier === null ? "Visitor" : TIER_TITLES[c.tier],
      tier: c.tier,
      visitor: c.status === "visitor",
      status: statusText(c, opts.layoffAfter),
      streak: c.streak,
      share: share(c.sharePpm),
      today: c.submitted ? "Filed" : c.result === "pass" ? "Passed" : c.result === "miss" ? "Missed" : "",
      simulated: opts.simulated || c.crowd,
      you: c.wallet === opts.you,
    };
    (row.you ? mine : c.tier === null ? visitors : groups[c.tier]!).rows.push(row);
  }
  return [mine, ...groups, visitors].filter((g) => g.rows.length > 0);
}

export class RgEmployeeList {
  readonly el = h("aside", { class: "staff surface", role: "dialog", "aria-modal": "false", "aria-labelledby": "staff-title", hidden: true });
  private readonly body = h("div", { class: "staff-body" });
  private readonly count = h("span", { class: "muted" });
  /** The whole list is the simulated preview: one label in the header instead of one per row. */
  private readonly simChip = h("span", { class: "chip sim", hidden: true }, "SIMULATED PREVIEW");
  private key = "";
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly handlers: {
      /** Centers the camera on the character and opens its card. */
      open(wallet: string): void;
      /** True while a character card is open (Escape closes the card first). */
      cardOpen(): boolean;
      onToggle?(open: boolean): void;
    },
  ) {
    const close = h("button", { class: "btn icon small close", "aria-label": "Close the staff list" }, "✕");
    close.addEventListener("click", () => this.close());
    this.el.append(h("div", { class: "staff-head" }, h("h2", { id: "staff-title" }, "Staff list"), this.count, this.simChip, close), this.body);
    // Escape closes the list once nothing in front of it (the card, the popover) took the key.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.open || e.defaultPrevented || this.handlers.cardOpen()) return;
      e.preventDefault();
      this.close();
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    this.handlers.onToggle?.(true);
    (this.body.querySelector<HTMLElement>("button.who") ?? this.el.querySelector<HTMLElement>(".close"))?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.open) return;
    this.el.hidden = true;
    this.handlers.onToggle?.(false);
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  update(layout: TowerLayout, opts: StaffOptions): void {
    const groups = staffGroups(layout, opts);
    const key = JSON.stringify(groups);
    if (key === this.key) return;
    this.key = key;
    this.simChip.hidden = !opts.simulated;
    this.count.textContent = `${plural(layout.employees, "employee")}${layout.visitorCount ? `, ${plural(layout.visitorCount, "visitor")}` : ""}`;
    const focused = this.body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.wallet : undefined;
    if (groups.length === 0) {
      render(this.body, h("p", { class: "muted" }, "Nobody works here yet. HR is accepting applications: hold $REORG to get a desk."));
      return;
    }
    // One small badge card per person, grouped by floor; each card is one button (a list, not a
    // table: the text of the button carries every column for screen readers).
    const list = h(
      "div",
      {},
      h("p", { class: "sr-only" }, "Every employee in building order, top floor first, your own card first. Choose a card to see it in the building."),
      ...groups.map((g) =>
        h(
          "section",
          { class: `group${g.label === "You" ? " mine" : ""}`, "aria-label": `${g.label}, ${g.rows.length}` },
          h("h3", {}, g.label, h("span", { class: "n" }, String(g.rows.length))),
          h(
            "ul",
            {},
            ...g.rows.map((r) => {
              const mark = r.today === "Passed" ? "✓ " : r.today === "Missed" ? "✕ " : "";
              const who = h(
                "button",
                { class: "who", "data-wallet": r.wallet, title: r.wallet, "aria-label": `${r.wallet}, ${r.title}, ${r.status}${r.streak ? `, streak ${r.streak}` : ""}, share ${r.share}${r.today ? `, today ${r.today}` : ""}${r.you ? ", you" : ""}${r.simulated ? ", simulated" : ""}` },
                portrait(r.wallet, { tier: r.tier, kind: r.visitor ? "visitor" : "employee", scale: 2 }),
                h(
                  "span",
                  { class: "main" },
                  h("span", { class: "name" }, r.name, r.you ? h("span", { class: "chip accent" }, "You") : null, r.simulated && !opts.simulated ? h("span", { class: "chip sim" }, "SIMULATED") : null),
                  h("span", { class: "status" }, r.title === "Visitor" ? r.status : `${r.title} · ${r.status}`),
                ),
                h(
                  "span",
                  { class: "nums" },
                  h("span", { class: "share" }, r.share),
                  h("span", { class: "streak" }, r.streak ? `streak ${r.streak}` : "—"),
                  r.today ? h("span", { class: `today ${r.today === "Passed" ? "good" : r.today === "Missed" ? "bad" : "filed"}` }, `${mark}${r.today}`) : null,
                ),
              );
              who.addEventListener("click", () => this.handlers.open(r.wallet));
              return h("li", { class: r.you ? "you" : "" }, who);
            }),
          ),
        ),
      ),
    );
    render(this.body, list);
    if (focused) this.body.querySelector<HTMLElement>(`[data-wallet="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
}
