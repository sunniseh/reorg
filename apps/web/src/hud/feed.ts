/**
 * RgFeed (design §3, §15.2): the ticker shows the newest item; expanded, the last 8, newest first.
 * A polite live region, so screen readers hear new items (design §11).
 */
import { COPY } from "../copy";
import type { FeedItem } from "../state/types";
import { h, render, setText } from "./dom";

const SHOWN = 8;

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export class RgFeed {
  readonly el: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly headText = h("span", { class: "text" });
  private readonly count = h("span", { class: "chip" });
  private readonly list = h("ol", { "aria-live": "polite", "aria-relevant": "additions", id: "feed-list" });
  private lastTop = "";

  constructor() {
    this.head = h("button", { class: "head", "aria-expanded": "false", "aria-controls": "feed-list" }, h("span", { class: "kind" }), this.headText, this.count);
    this.el = h("section", { class: "feed surface", "aria-label": "Company feed" }, this.head, this.list);
    this.head.addEventListener("click", () => {
      const open = !this.el.classList.contains("open");
      this.el.classList.toggle("open", open);
      this.head.setAttribute("aria-expanded", String(open));
    });
  }

  update(items: readonly FeedItem[]): void {
    const top = items[0];
    const kindDot = this.head.querySelector(".kind") as HTMLElement;
    if (!top) {
      setText(this.headText, COPY.emptyFeed);
      kindDot.className = "kind";
      render(this.list);
      this.count.hidden = true;
      return;
    }
    const isNew = top.id !== this.lastTop;
    this.lastTop = top.id;
    setText(this.headText, top.text);
    kindDot.className = `kind ${top.kind}`;
    this.count.hidden = items.length < 2;
    setText(this.count, String(Math.min(items.length, SHOWN)));
    this.head.setAttribute("aria-label", `Company feed: ${top.text}`);
    render(
      this.list,
      ...items.slice(0, SHOWN).map((it, i) =>
        h(
          "li",
          { class: i === 0 && isNew ? "new" : "" },
          h("span", { class: `kind ${it.kind}`, "aria-hidden": "true" }),
          h("time", { datetime: new Date(it.at).toISOString() }, clock(it.at)),
          h("span", {}, it.text, it.source === "ai" || it.source === "template" ? h("span", { class: "src" }, ` · written by ${it.source === "ai" ? "AI" : "template"}`) : null),
        ),
      ),
    );
  }
}
