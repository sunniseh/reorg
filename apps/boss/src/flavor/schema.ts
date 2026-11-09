// B-05: the flavor-text contract. The LLM (or the template) only writes text: it receives
// facts computed by code (spec §8.4 inputs) and returns { task_text, announcements, tone_notes }
// (spec §8.4 output). Anything that fails validation is replaced by the template (B-06).
import { containsMoneyWord } from "@reorg/core";
import { z } from "zod";

export const FLAVOR_LIMITS = {
  task_text: 600,
  announcement: 280,
  announcements: 24,
  tone_notes: 200,
} as const;

/** spec §8.4 output, validated before use. */
export const FlavorOutputSchema = z.strictObject({
  task_text: z.string().max(FLAVOR_LIMITS.task_text),
  announcements: z.array(z.string().trim().min(1).max(FLAVOR_LIMITS.announcement)).max(FLAVOR_LIMITS.announcements),
  tone_notes: z.string().max(FLAVOR_LIMITS.tone_notes),
});
export type FlavorOutput = z.infer<typeof FlavorOutputSchema>;

/** Things the boss announces. Every fact here is computed by code from chain state. */
export type AnnouncementEvent =
  | { kind: "results"; task_id: number; submitted: number; passed: number }
  | { kind: "payday"; task_id: number; passers: number; payroll: string }
  | { kind: "layoff"; account: string; tasks_left: number }
  | { kind: "layoff_warning"; account: string; misses: number }
  | { kind: "rehire"; account: string }
  | { kind: "streak"; account: string; streak: number }
  | { kind: "reserve_low"; reserve: string; runway_tasks: number | null };

export interface FlavorTask {
  /** Chain task number ("day"). */
  number: number;
  kind: "decode_memo";
  /** Human cipher name, e.g. "Caesar cipher" (never the key). */
  cipher: string;
  level: number;
  warmup: boolean;
}

/** spec §8.4 inputs. Never contains the day secret, codes or anything that decides an outcome. */
export interface FlavorRequest {
  /** Public, non-secret variety seed (the boss's task slot). */
  seed: number;
  /** Set when a task memo is wanted; null for announcements only. */
  task: FlavorTask | null;
  /** `reserve` is display text (e.g. "12.5 NEAR"). */
  stats: { headcount: number; reserve: string; runway_tasks: number | null };
  yesterday: { task_id: number; submitted: number; passed: number } | null;
  events: AnnouncementEvent[];
}

export interface FlavorWriter {
  readonly source: "ai" | "template";
  write(req: FlavorRequest): Promise<FlavorOutput>;
}

const LINK = /(https?:|www\.|:\/\/|\.(com|io|xyz|net|org)\b)/i;

/**
 * Semantic checks on top of the schema: one announcement per event, a memo exactly when one
 * was asked for, no money talk in the task (tasks never involve money), no links anywhere.
 * Returns the problem, or null if the output is usable.
 */
export function flavorProblem(out: unknown, req: FlavorRequest): string | null {
  const parsed = FlavorOutputSchema.safeParse(out);
  if (!parsed.success) return `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
  const o = parsed.data;
  if (o.announcements.length !== req.events.length) return `expected ${req.events.length} announcements, got ${o.announcements.length}`;
  if (req.task && o.task_text.trim().length === 0) return "task_text is empty";
  if (!req.task && o.task_text.trim().length > 0) return "task_text given when no task was requested";
  if (containsMoneyWord(o.task_text)) return "task_text mentions money";
  if ([o.task_text, o.tone_notes, ...o.announcements].some((s) => LINK.test(s))) return "contains a link";
  return null;
}

/** yoctoNEAR (decimal string) → "1.25 NEAR" (at most 3 decimals, trailing zeros trimmed). */
export function formatNear(yocto: string): string {
  const milli = (BigInt(yocto) + 5n * 10n ** 20n) / 10n ** 21n; // round to 0.001
  const frac = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${milli / 1000n}${frac ? `.${frac}` : ""} NEAR`;
}
