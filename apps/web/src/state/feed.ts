/**
 * The feed (design §3, §15.2 `RgFeed`): contract events and the boss's announcements, newest
 * first. Consecutive submissions to one task merge into one line so a busy window does not push
 * the boss off the list.
 */
import type { ReorgEvent, WalletId } from "@reorg/core";
import { payout, plural, shortName } from "../format";
import type { FeedItem } from "./types";

const MAX_ITEMS = 60;

export class FeedLog {
  private items: FeedItem[] = [];
  private listeners = new Set<(items: readonly FeedItem[]) => void>();

  list(): readonly FeedItem[] {
    return this.items;
  }

  on(fn: (items: readonly FeedItem[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Adds items (any order); keeps newest first; merges submission runs. */
  add(...items: FeedItem[]): void {
    if (items.length === 0) return;
    // Linear in the batch: a big company's payday is thousands of lines in one call.
    const ids = new Set(this.items.map((x) => x.id));
    const fresh: FeedItem[] = []; // oldest first; the newest is the current top
    for (const it of items.sort((a, b) => a.at - b.at)) {
      if (ids.has(it.id)) continue;
      ids.add(it.id);
      const top = fresh.length > 0 ? fresh[fresh.length - 1] : this.items[0];
      // Runs of submissions (or of claims) for one task merge into one counted line.
      if ((it.kind === "submission" || it.kind === "claim") && top?.kind === it.kind && top.taskId === it.taskId) {
        const count = (top.count ?? 1) + 1;
        const { wallet: _drop, ...rest } = top;
        const text = it.kind === "submission" ? `${plural(count, "answer")} filed for day ${it.taskId}.` : `${plural(count, "salary", "salaries")} collected for day ${it.taskId}.`;
        const merged = { ...rest, id: it.id, at: it.at, count, text };
        if (fresh.length > 0) fresh[fresh.length - 1] = merged;
        else this.items[0] = merged;
        continue;
      }
      fresh.push(it);
    }
    this.items = [...fresh.reverse(), ...this.items];
    this.items.sort((a, b) => b.at - a.at);
    if (this.items.length > MAX_ITEMS) {
      const pinned = this.items.filter((x) => x.pinned);
      this.items = [...this.items.filter((x) => !x.pinned).slice(0, MAX_ITEMS - pinned.length), ...pinned];
    }
    for (const fn of this.listeners) fn(this.items);
  }
}

/**
 * A feed line for a contract event. `bossCovers` = the boss service is connected and posts its
 * own lines for openings, results, payday, streaks and low reserve, so those are skipped here.
 */
export function feedFromEvent(e: ReorgEvent, opts: { bossCovers: boolean; nowMs?: number; name?: (w: WalletId) => string }): FeedItem | null {
  const name = opts.name ?? shortName;
  const base = { id: `ev${e.seq}`, at: opts.nowMs ?? Number(BigInt(e.at) / 1_000_000n), source: "chain" as const };
  switch (e.event) {
    case "submission_received":
      return {
        ...base,
        kind: "submission",
        taskId: e.data.task_id,
        wallet: e.data.account_id,
        text: e.data.reapply ? `${name(e.data.account_id)} filed a reapplication.` : `${name(e.data.account_id)} filed an answer.`,
      };
    case "salary_paid":
      return { ...base, kind: "claim", wallet: e.data.account_id, taskId: e.data.task_id, text: `${name(e.data.account_id)} collected ${payout(e.data.amount)} for day ${e.data.task_id}.` };
    case "salary_forfeited":
      return {
        ...base,
        kind: "forfeit",
        wallet: e.data.account_id,
        taskId: e.data.task_id,
        text: `${name(e.data.account_id)} sold below 90% of their snapshot. ${payout(e.data.amount)} went back to the reserve.`,
      };
    case "income_deposited":
      return { ...base, kind: "income", text: `Income received: ${payout(e.data.amount)} (${e.data.tag.replace("_", " ")}).` };
    case "rehired":
      return opts.bossCovers ? null : { ...base, kind: "rehire", wallet: e.data.account_id, taskId: e.data.task_id, text: `${name(e.data.account_id)} passed the reapplication and is rehired.` };
    case "streak_milestone":
      return opts.bossCovers ? null : { ...base, kind: "streak", wallet: e.data.account_id, text: `${name(e.data.account_id)} reached a ${e.data.streak}-day streak.` };
    case "task_opened":
      return opts.bossCovers ? null : { ...base, kind: "task", taskId: e.data.task_id, text: `Day ${e.data.task_id} is open. Decode the memo.` };
    case "task_finalized":
      return opts.bossCovers
        ? null
        : { ...base, kind: "results", taskId: e.data.task_id, text: `Day ${e.data.task_id} results: ${e.data.passed} of ${e.data.submitted} passed.` };
    case "payroll_allocated":
      return opts.bossCovers
        ? null
        : { ...base, kind: "payroll", taskId: e.data.task_id, text: `Payroll for day ${e.data.task_id}: ${payout(sum(e.data.tier_payable))} to passers, ${payout(e.data.to_reserve)} to the reserve.` };
    case "reserve_low":
      return opts.bossCovers ? null : { ...base, kind: "system", taskId: e.data.task_id, text: `The reserve is low: ${payout(e.data.reserve)}.` };
  }
}

const sum = (xs: readonly string[]) => xs.reduce((a, b) => a + BigInt(b), 0n);
