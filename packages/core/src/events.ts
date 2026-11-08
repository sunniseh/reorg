/**
 * Event schemas (roadmap P-03, D8). Normative source: docs/PROTOCOL.md §12.
 * Shape of every entry returned by `get_events` and carried in the event log:
 *   { seq, at, event, data }
 */
import { z } from "zod";
import { INCOME_TAGS, TASK_KINDS } from "./abi";

const u128 = z.string().regex(/^(0|[1-9]\d*)$/);
const u64 = u128;
const b64_32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "32 bytes, base64 with padding");
const wallet = z.string().min(1);
const taskId = z.number().int().min(1);
const tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const tuple4 = z.tuple([u128, u128, u128, u128]);

export const EventData = {
  task_opened: z.strictObject({
    task_id: taskId,
    kind: z.enum(TASK_KINDS),
    commit_hash: b64_32,
    opens_at: u64,
    closes_at: u64,
  }),
  submission_received: z.strictObject({
    task_id: taskId,
    account_id: wallet,
    tier,
    balance: u128,
    weight: u128,
    reapply: z.boolean(),
  }),
  task_finalized: z.strictObject({
    task_id: taskId,
    day_secret: b64_32,
    submitted: z.number().int().min(0),
    passed: z.number().int().min(0),
  }),
  payroll_allocated: z.strictObject({
    task_id: taskId,
    income: u128,
    payroll: u128,
    jackpot: u128,
    reserve_share: u128,
    buckets: tuple4,
    tier_payable: tuple4,
    to_reserve: u128,
    operating_cost_paid: u128,
    reserve_after: u128,
    runway_tasks: z.number().int().min(0).nullable(),
  }),
  salary_paid: z.strictObject({ task_id: taskId, account_id: wallet, amount: u128 }),
  salary_forfeited: z.strictObject({
    task_id: taskId,
    account_id: wallet,
    amount: u128,
    snapshot_balance: u128,
    current_balance: u128,
  }),
  income_deposited: z.strictObject({ from: wallet, amount: u128, tag: z.enum(INCOME_TAGS) }),
  streak_milestone: z.strictObject({ task_id: taskId, account_id: wallet, streak: z.number().int().min(1) }),
  rehired: z.strictObject({ task_id: taskId, account_id: wallet }),
  reserve_low: z.strictObject({ task_id: taskId, reserve: u128, threshold: u128 }),
} as const;

export type EventName = keyof typeof EventData;
export const EVENT_NAMES = Object.keys(EventData) as EventName[];

const envelope = <N extends EventName>(name: N) =>
  z.strictObject({
    seq: z.number().int().min(1),
    at: u64,
    event: z.literal(name),
    data: EventData[name],
  });

export const ReorgEventSchema = z.discriminatedUnion("event", [
  envelope("task_opened"),
  envelope("submission_received"),
  envelope("task_finalized"),
  envelope("payroll_allocated"),
  envelope("salary_paid"),
  envelope("salary_forfeited"),
  envelope("income_deposited"),
  envelope("streak_milestone"),
  envelope("rehired"),
  envelope("reserve_low"),
]);

export type ReorgEvent = z.infer<typeof ReorgEventSchema>;
export type EventOf<N extends EventName> = Extract<ReorgEvent, { event: N }>;
