/**
 * Copy in voice (design §13.2). Rejections map the contract's reason string to REORG copy; the
 * raw reason is shown under it in a muted line. Unknown reasons use the network-error copy.
 */
export const COPY = {
  networkError: "The request has been escalated to HR. Try again in a minute.",
  emptyFeed: "Nothing to report. Per my last memo, that is not a good sign.",
  badgeIn: "Please badge in so we can find your desk.",
  visitor: "You hold too little to be on payroll. Visitors may wait in the lobby.",
  taskClosed: "Today’s window has closed. Submissions are now a matter for tomorrow.",
  laidOff: "Your position has been rebalanced. Pass today’s task to reapply. Reapplication work is unpaid.",
  reapplyNote: "Reapplication work is unpaid. Pass and you are rehired.",
  reapplyFiled: "Your application is on file. Pass and you are rehired.",
  rehired: "Welcome back. We never doubted you, officially.",
  submitted: "Filed. Results at close of business.",
  claimBlocked: (amount: string, antidumpPct: string) =>
    `Claims need at least ${amount} in this account (${antidumpPct}% of what you held at submission). This salary waits; it does not expire.`,
  forfeited: (antidumpPct: string) => `Your salary went back to the reserve: your balance was below ${antidumpPct}% of your snapshot.`,
  loading: "Filing paperwork…",
  noTask: "No task posted. The boss is in a meeting.",
  resultsPending: "Closed. Results pending.",
  excluded: "This account belongs to the company and cannot be on payroll.",
  newHire: "Your desk is ready. The next task is your first.",
  between: "Between tasks. The next memo is on its way.",
  reviewing: "Reviewing your submission…",
  claimFiled: "Payroll is processing your claim…",
  previewDock: "This is a simulated preview. Turn the preview off to get back to your desk.",
} as const;

const REASONS: [RegExp, string][] = [
  [/anti-recycling|received after the task opened/i, "Paperwork for recent transfers takes one task. Your desk is ready at the next one."],
  [/below the minimum tier|visitor/i, COPY.visitor],
  [/already submitted/i, "We already have your answer on file. One per employee."],
  [/window is closed|task is not open/i, COPY.taskClosed],
  [/account is excluded/i, COPY.excluded],
  [/storage float/i, "The office is out of filing cabinets. Facilities has been notified. Try again later."],
  [/balance read failed|transfer failed/i, "HR could not reach your records. Nothing changed. Try again in a minute."],
  [/already claimed|pending or forfeited/i, "Payroll already processed this one."],
  [/user rejected|rejected by user|cancel/i, "You closed the wallet before signing. Nothing was filed."],
];

/** Maps a contract or wallet error to `{ text, detail }` (design §13.2). */
export function rejectionCopy(reason: string | null | undefined): { text: string; detail: string } {
  const raw = (reason ?? "").trim();
  for (const [re, text] of REASONS) if (re.test(raw)) return { text, detail: raw };
  return { text: COPY.networkError, detail: raw };
}

/** The bubble carries a line, not a memo: the first sentence or two, at most ~110 characters. */
export function bubbleText(text: string): string {
  const t = text.replace(/^Day \d+\.\s*/, "").trim();
  const sentences = t.match(/[^.!?…]+[.!?…]+/g) ?? [t];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trim().length > 110) break;
    out += s;
  }
  out = out.trim() || t;
  return out.length > 110 ? `${out.slice(0, 108).replace(/\s+\S*$/, "")}…` : out;
}
