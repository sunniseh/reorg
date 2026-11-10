/**
 * RgSimBanner, RgToast and RgDialog (design §12.4, §15.2). The banner cannot be dismissed. Dialogs
 * trap focus, close on Escape and return focus to their trigger. The ledger opens from the vault.
 */
import type { TreasuryView } from "@reorg/core";
import { payout, plural, shortName } from "../format";
import type { LedgerRow } from "../state/types";
import { h, render } from "./dom";
import { icon, portrait } from "./sprites";

export class RgSimBanner {
  readonly el = h("div", { class: "sim-banner", role: "note", hidden: true });

  show(on: boolean, text: string): void {
    this.el.hidden = !on;
    render(this.el, h("b", {}, "SIMULATED PREVIEW"), h("span", {}, text));
    document.getElementById("app")?.classList.toggle("has-banner", on);
  }
}

export class RgToast {
  readonly el = h("div", { class: "toast surface", role: "status", hidden: true });
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** One at a time, 4 seconds (design §15.2). */
  show(text: string): void {
    render(this.el, text);
    this.el.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.el.hidden = true), 4000);
  }
}

export class RgDialog {
  private scrim: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly host: HTMLElement) {}

  get open(): boolean {
    return !!this.scrim;
  }

  show(title: string, ...content: (Node | string | null)[]): void {
    this.close();
    this.returnFocus = document.activeElement as HTMLElement | null;
    const close = h("button", { class: "btn small" }, "Close");
    close.addEventListener("click", () => this.close());
    const box = h("div", { class: "dialog surface", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", {}, title), ...content, h("div", { class: "row" }, close));
    const scrim = h("div", { class: "scrim" }, box);
    scrim.addEventListener("click", (e) => e.target === scrim && this.close());
    scrim.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Handled here: the card and the staff list behind the dialog stay open.
        e.preventDefault();
        this.close();
      }
      if (e.key === "Tab") {
        const f = [...box.querySelectorAll<HTMLElement>("button, a[href], input")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    this.host.append(scrim);
    this.scrim = scrim;
    (box.querySelector<HTMLElement>(".choices .btn") ?? close).focus();
  }

  close(): void {
    if (!this.scrim) return;
    this.scrim.remove();
    this.scrim = null;
    this.returnFocus?.focus?.({ preventScroll: true });
  }
}

/** One way to badge in, as the login dialog lists it. */
export interface BadgeInChoice {
  label: string;
  description: string;
  simulated: boolean;
  pick(): void;
}

/**
 * The badge-in (login) dialog's body: the blank visitor badge you are about to fill in, then one
 * button per wallet. Holding $REORG is the job; badging in only tells the building who you are.
 */
export function badgeInContent(intro: string, choices: readonly BadgeInChoice[]): HTMLElement {
  const list = h("div", { class: "choices" });
  for (const c of choices) {
    const b = h(
      "button",
      { class: "btn choice" },
      h("span", {}, h("b", {}, c.label), c.simulated ? h("span", { class: "chip sim", style: "margin-left:8px" }, "SIMULATED") : null, h("br"), h("span", { class: "muted" }, c.description)),
    );
    b.addEventListener("click", () => c.pick());
    list.append(b);
  }
  return h(
    "div",
    { class: "login" },
    h(
      "div",
      { class: "badge-card", "aria-hidden": "true" },
      portrait("visitor", { tier: null, kind: "visitor", scale: 3 }),
      h("div", { class: "badge-lines" }, icon("lobby.logo", { scale: 1 }), h("b", {}, "VISITOR"), h("span", { class: "muted" }, "Name: ________"), h("span", { class: "muted" }, "Desk: ________")),
    ),
    h("p", { class: "muted", style: "margin:0" }, intro),
    choices.length ? list : h("p", { class: "bad" }, "No wallet is configured for this deployment."),
    h("p", { class: "muted fine" }, "Hold $REORG to get a desk. Badging in never moves your tokens."),
  );
}

/** The ledger (design §3): income by tag (simulated marked), salaries, forfeits, operating costs. */
export function ledgerContent(
  t: TreasuryView,
  rows: readonly LedgerRow[],
  opts: {
    simulatedIncome: boolean;
    isCrowd?: (w: string) => boolean;
    /** Explorer page of an account (testnet), or null on a local chain. */
    accountUrl?: (account: string) => string | null;
    /** The contract: its explorer page lists every transaction behind these rows. */
    contract?: { id: string; url: string | null } | null;
  },
): HTMLElement {
  const sumRow = (k: string, v: string, note?: string) => h("tr", {}, h("td", {}, k, note ? h("span", { class: "chip sim", style: "margin-left:6px" }, note) : null), h("td", { class: "num" }, v));
  const kindText: Record<LedgerRow["kind"], string> = { income: "Income", salary: "Salary paid", forfeit: "Forfeited to reserve", operating: "Operating cost" };
  return h(
    "div",
    {},
    h("p", { class: "muted", style: "margin:0" }, t.runway_tasks === null ? "No operating costs." : `Runway: ${plural(t.runway_tasks, "task")} at ${payout(t.operating_cost)} per task.`),
    h(
      "table",
      {},
      h("tbody", {},
        sumRow("Reserve", payout(t.reserve)),
        sumRow("Income: client jobs", payout(t.income_by_tag.client_job), opts.simulatedIncome ? "simulated" : undefined),
        sumRow("Income: fee share", payout(t.income_by_tag.fee_share)),
        sumRow("Income: seed", payout(t.income_by_tag.seed)),
        sumRow("Salaries paid", payout(t.total_paid)),
        sumRow("Forfeited to reserve", payout(t.total_forfeited)),
        sumRow("Allocated, not yet claimed", payout(t.outstanding)),
        sumRow("Operating costs", payout(t.total_operating_cost)),
      ),
    ),
    h("h3", { style: "margin:14px 0 0;font-size:15px" }, "Recent entries"),
    rows.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "What"), h("th", {}, "Who"), h("th", { class: "num" }, "Amount"))),
          h(
            "tbody",
            {},
            ...rows.slice(0, 30).map((r) => {
              const who = r.wallet ? `${shortName(r.wallet)}${opts.isCrowd?.(r.wallet) ? " (bot)" : ""}` : "—";
              const whoUrl = r.wallet ? opts.accountUrl?.(r.wallet) ?? null : null;
              const what = `${kindText[r.kind]}${r.tag ? ` (${r.tag.replace("_", " ")})` : ""}${r.taskId ? `, day ${r.taskId}` : ""}`;
              return h(
                "tr",
                {},
                h("td", {}, what, r.simulated ? h("span", { class: "chip sim", style: "margin-left:6px" }, "simulated") : null),
                // Payouts to crowd bots are real transfers to simulated holders: label the holder.
                h("td", {}, whoUrl ? h("a", { href: whoUrl, target: "_blank", rel: "noopener" }, who) : who),
                h("td", { class: `num ${r.kind === "income" ? "good" : r.kind === "forfeit" ? "bad" : ""}` }, payout(r.amount)),
              );
            }),
          ),
        )
      : h("p", { class: "muted" }, "Nothing booked since you arrived."),
    opts.contract
      ? h(
          "p",
          { class: "muted", style: "margin:12px 0 0" },
          "Every entry is a transaction on the contract ",
          opts.contract.url ? h("a", { href: opts.contract.url, target: "_blank", rel: "noopener" }, opts.contract.id) : h("code", {}, opts.contract.id),
          opts.contract.url ? "." : " (a local chain: no explorer).",
        )
      : null,
  );
}
