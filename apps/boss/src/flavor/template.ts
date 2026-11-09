// B-06: template flavor text in the spec §8.3 voice (a passive-aggressive executive, relentlessly
// upbeat about terrible news). The default writer and the fallback for any LLM failure.
// Deterministic in (seed, input): same request → same words. Task memos come from a grammar
// (department × subject × verb × closing = 14,400 memos); every memo passes the money-word
// check (tested exhaustively).
import { sha256Bytes } from "@reorg/core";
import type { AnnouncementEvent, FlavorOutput, FlavorRequest, FlavorTask, FlavorWriter } from "./schema";

export const DEPARTMENTS = [
  "Synergy", "Facilities", "Human Capital Optimization", "Strategic Alignment", "Workplace Joy",
  "Internal Communications", "Process Excellence", "Morale", "Compliance", "Talent Rebalancing",
  "Corporate Wellness", "Paperwork",
] as const;

export const SUBJECTS = [
  "the quarterly stapler audit", "the new hot-desking policy", "a mandatory fun initiative",
  "the kitchen fridge situation", "next week's offsite about offsites", "the updated lanyard policy",
  "a minor restructuring of the org chart", "the printer on floor three", "the revised badge photo standard",
  "the elevator small-talk policy", "a pilot program for standing meetings", "the coffee machine roadmap",
] as const;

export const VERBS = [
  "was encrypted for your protection", "was scrambled by a well-meaning intern",
  "came back from Legal slightly unreadable", "has been secured with industry-leading obfuscation",
  "was faxed to itself several times", "was shredded and lovingly reassembled",
  "has been encoded to boost engagement", "was translated into a more agile format",
  "was locked down per our new security posture", "was written in our proprietary internal dialect",
] as const;

export const CLOSINGS = [
  "Remember: we are a family, and families have deadlines.",
  "Participation is voluntary and will be tracked.",
  "Excellence is a habit. So is reading memos.",
  "Thank you for your continued alignment.",
  "Every code word submitted is a step toward synergy.",
  "Your manager has been notified that you are reading this.",
  "Please decode responsibly.",
  "Failure is a learning opportunity for whoever replaces you.",
  "We value your time, which is why this takes sixty seconds.",
  "Smile. The cameras appreciate it.",
] as const;

/** Index in [0, n) from a domain-separated hash of the parts. */
function pick<T>(items: readonly T[], ...parts: (string | number)[]): T {
  const h = sha256Bytes(new TextEncoder().encode(`reorg/flavor/v1/${parts.join("/")}`));
  const x = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return items[x % items.length]!;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function templateTaskText(seed: number, task: FlavorTask): string {
  const dept = pick(DEPARTMENTS, seed, "dept");
  const subject = pick(SUBJECTS, seed, "subject");
  const verb = pick(VERBS, seed, "verb");
  const closing = pick(CLOSINGS, seed, "closing");
  return memoText(task, dept, subject, verb, closing);
}

/** One grammar production (exported so the test can enumerate all 14,400). */
export function memoText(task: FlavorTask, dept: string, subject: string, verb: string, closing: string): string {
  const prefix = task.warmup ? "Orientation exercise. " : "";
  return (
    `${prefix}Memo #${task.number} from the Department of ${dept}: ${cap(subject)} ${verb}. ` +
    `Decode your copy using the ${task.cipher} hint and submit the code word before the window closes. ${closing}`
  );
}

type Variants<E> = readonly ((e: E) => string)[];
type Of<K extends AnnouncementEvent["kind"]> = Extract<AnnouncementEvent, { kind: K }>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const RESULTS: Variants<Of<"results">> = [
  (e) => `Task #${e.task_id} is closed. ${e.passed} of ${plural(e.submitted, "submission")} met expectations. The rest have been noted.`,
  (e) => `Results for task #${e.task_id}: ${e.passed} passed, ${e.submitted - e.passed} grew as people.`,
  (e) => `Task #${e.task_id} wrapped with ${plural(e.passed, "success", "successes")} out of ${e.submitted}. Leadership is cautiously thrilled.`,
];
const NO_SUBMISSIONS = (e: Of<"results">) =>
  `Task #${e.task_id} closed with zero submissions. Leadership has decided to see this as focus time.`;

const PAYDAY: Variants<Of<"payday">> = [
  (e) => `Payday! ${e.payroll} of payroll was allocated to ${plural(e.passers, "high performer")}. Claim it before you get any ideas about selling.`,
  (e) => `Payroll for task #${e.task_id} is out: ${e.payroll} across ${plural(e.passers, "passer")}. Please contain your gratitude.`,
  (e) => `Salaries are ready. ${e.payroll} goes to ${plural(e.passers, "employee")} who did the bare minimum, flawlessly.`,
];

const LAYOFF: Variants<Of<"layoff">> = [
  (e) => `${e.account} has been selected for a rebalancing of talent. Thank you for your service. The lobby is open for reapplication.`,
  (e) => `We are thrilled to share that ${e.account} is pursuing exciting opportunities outside the company, effective immediately.`,
  (e) => `${e.account} has been right-sized after three missed tasks. Reapply any time; the badge reader remembers you fondly.`,
];

const WARNING: Variants<Of<"layoff_warning">> = [
  (e) => `${e.account} has missed ${plural(e.misses, "task")} in a row. One more and we will need a quick chat in the small meeting room.`,
  (e) => `Friendly reminder to ${e.account}: ${plural(e.misses, "missed task")}. HR has pre-filled some paperwork, just in case.`,
];

const REHIRE: Variants<Of<"rehire">> = [
  (e) => `Welcome back, ${e.account}! Your reapplication was approved and your desk was never really reassigned.`,
  (e) => `${e.account} has been rehired. We always believed in you, intermittently.`,
  (e) => `Please welcome ${e.account} back to the team. Your lanyard is exactly where you left it.`,
];

const STREAK: Variants<Of<"streak">> = [
  (e) => `${e.account} is on a ${e.streak}-task streak. Please stop making the rest of the floor look bad.`,
  (e) => `${e.streak} tasks in a row for ${e.account}. Leadership has noticed and will mention it in a newsletter nobody reads.`,
];

const runway = (n: number | null, pre: string, post: string) => (n === null ? "" : `${pre}${plural(n, "more task")}${post}`);
const RESERVE_LOW: Variants<Of<"reserve_low">> = [
  (e) => `A friendly update from Finance: the reserve is at ${e.reserve}${runway(e.runway_tasks, ", enough for ", "")}. Please keep believing in the vision.`,
  (e) => `The vault is looking cozy at ${e.reserve}${runway(e.runway_tasks, " (runway: ", ")")}. We are calling it lean, not empty.`,
];

export function templateAnnouncement(seed: number, index: number, e: AnnouncementEvent): string {
  switch (e.kind) {
    case "results":
      return e.submitted === 0 ? NO_SUBMISSIONS(e) : pick(RESULTS, seed, index, e.kind)(e);
    case "payday":
      return pick(PAYDAY, seed, index, e.kind)(e);
    case "layoff":
      return pick(LAYOFF, seed, index, e.kind)(e);
    case "layoff_warning":
      return pick(WARNING, seed, index, e.kind)(e);
    case "rehire":
      return pick(REHIRE, seed, index, e.kind)(e);
    case "streak":
      return pick(STREAK, seed, index, e.kind)(e);
    case "reserve_low":
      return pick(RESERVE_LOW, seed, index, e.kind)(e);
  }
}

export function templateFlavor(req: FlavorRequest): FlavorOutput {
  return {
    task_text: req.task ? templateTaskText(req.seed, req.task) : "",
    announcements: req.events.map((e, i) => templateAnnouncement(req.seed, i, e)),
    tone_notes: "template",
  };
}

export const TemplateFlavor: FlavorWriter = {
  source: "template",
  write: async (req) => templateFlavor(req),
};
