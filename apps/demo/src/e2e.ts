// `npm run e2e` (roadmap D-04): boots the demo stack without the web client, plays the judge with a
// faucet-funded burner wallet, runs until the scripted wallet F has been laid off and rehired,
// then asserts the six steps of ROADMAP §1 against contract state, recomputes every payout with
// the core pay-math mirror and balances the treasury books to the yoctoNEAR. Exit code 0 = pass.
// Same knobs as the demo; the epoch defaults to 45 s here so the run takes ~3 minutes.
import {
  answerHashBase64,
  readAll,
  solvePuzzle,
  towerCharacters,
  type ClaimOutcome,
  type ReorgEvent,
  type SubmissionView,
  type TaskView,
} from "@reorg/core";
import { BurnerWallet, type KeyStore } from "@reorg/chain-near";
import { checkBooks, checkTaskPay } from "./checks";
import { httpBoss } from "./runner";
import { stackConfig, startStack, type FeedEntry, type Stack } from "./stack";

const t0 = Date.now();
const say = (msg: string) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MemStore implements KeyStore {
  private readonly m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

interface Step {
  name: string;
  problems: string[];
  notes: string[];
}

async function main(): Promise<number> {
  const cfg = stackConfig(process.env, { epochSeconds: 45 });
  const timeoutMs = Number(process.env["E2E_TIMEOUT_SECONDS"] ?? 600) * 1000;
  const stack: Stack = await startStack({ ...cfg, web: false, log: say, ...(process.env["E2E_VERBOSE"] ? { crowdLog: (m: string) => say(`crowd: ${m}`) } : {}) });
  let crash: string | null = null;
  void stack.crashed.then((r) => (crash = r));
  try {
    return await run(stack, cfg.warmupTasks, timeoutMs, () => crash);
  } finally {
    await stack.stop();
  }
}

async function run(stack: Stack, warmupTasks: number, timeoutMs: number, crashed: () => string | null): Promise<number> {
  const { reader, env } = stack;
  const live = warmupTasks + 1; // F is laid off at this task's finalize
  const rehire = live + 1; // and rehired at this one's
  const fMember = stack.members.find((m) => m.profile === "scripted");
  if (!fMember) throw new Error("the crowd has no scripted wallet F (CROWD_SIZE too small?)");
  const F = stack.signer.accountId(fMember.index);
  const boss = httpBoss(stack.bossUrl);

  // The judge: a burner from the boss's faucet, like "Badge in" in the browser.
  const judge = new BurnerWallet({ rpcUrl: env.rpcUrl, contractId: env.contractId, bossUrl: stack.bossUrl, network: "sandbox", store: new MemStore() });
  const J = await judge.connect();
  say(`judge badged in as ${J}; wallet F is ${F}; waiting for task ${rehire} to finalize…`);

  const fStatus = new Map<number, string>();
  let judgeFiled = false;
  let judgeClaim: ClaimOutcome | null = null;
  let doneAt: number | null = null;
  let lastSeen = -1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const crash = crashed();
    if (crash) throw new Error(crash);
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s (last finalized task ${lastSeen})`);
    const info = await reader.getInfo();
    if (info.last_finalized !== lastSeen) {
      lastSeen = info.last_finalized;
      if (lastSeen > 0) say(`task ${lastSeen} finalized`);
    }
    if (!fStatus.has(info.last_finalized)) fStatus.set(info.last_finalized, (await reader.getEmployee(F))?.status ?? "none");
    const cur = await boss.current();
    if (!judgeFiled && cur?.status === "open" && cur.task_id === live) {
      const p = await boss.puzzle(J);
      const [answer] = solvePuzzle("decode-memo", p.display, p.hint);
      if (!answer) throw new Error("the judge could not solve the puzzle from display + hint");
      const out = await judge.submit(p.task_id, answerHashBase64(answer, J));
      if (!out.accepted) throw new Error(`the judge's submission was rejected: ${out.reason}`);
      judgeFiled = true;
      say(`judge solved task ${live} (${answer}) and submitted`);
    }
    if (judgeFiled && !judgeClaim && info.last_finalized >= live) {
      judgeClaim = await judge.claimSalary(live);
      say(`judge claimed task ${live}: ${judgeClaim.status}${"amount" in judgeClaim ? ` ${judgeClaim.amount} yocto` : ""}`);
    }
    if (info.last_finalized >= rehire && doneAt === null) doneAt = Date.now();
    // Bots claim 1-6 s after a finalize; give them time, then freeze everything for the checks.
    if (doneAt !== null && Date.now() - doneAt > 10_000) break;
    await sleep(1000);
  }

  const feed = await readFeed(stack.bossUrl);
  say("stopping the boss and the crowd; reading the chain…");
  await stack.stopServices();

  const [info, config, treasury] = await Promise.all([reader.getInfo(), reader.getConfig(), reader.getTreasury()]);
  const events: ReorgEvent[] = [];
  while (events.length < info.event_seq) {
    const page = await reader.getEvents(events.at(-1)?.seq ?? 0, 100);
    if (page.length === 0) break;
    events.push(...page);
  }
  const tasks = new Map<number, TaskView>();
  const subs = new Map<number, SubmissionView[]>();
  for (let id = 1; id <= info.current_task_id; id++) {
    tasks.set(id, (await reader.getTask(id))!);
    subs.set(id, await readAll((from, limit) => reader.listSubmissions(id, from, limit)));
  }
  const ev = <N extends ReorgEvent["event"]>(name: N) => events.filter((e): e is Extract<ReorgEvent, { event: N }> => e.event === name);
  const sub = (id: number, who: string) => subs.get(id)?.find((s) => s.account_id === who) ?? null;
  const fed = (kind: string, task: number, who?: string) => feed.some((e) => e.kind === kind && e.task_id === task && (who === undefined || e.data["account"] === who));
  const steps: Step[] = [];
  const step = (name: string, fill: (p: string[], n: string[]) => void) => {
    const s: Step = { name, problems: [], notes: [] };
    fill(s.problems, s.notes);
    steps.push(s);
  };

  // 1. The building renders the crowd across all four tiers, plus visitors; vault and runway.
  const holders = await readAll((from, limit) => reader.listHolders(from, limit), 200);
  const employees = await readAll((from, limit) => reader.listEmployees(from, limit));
  const newest = tasks.get(info.current_task_id) ?? null;
  const chars = towerCharacters({
    config,
    totalSupply: BigInt(info.total_supply),
    holders,
    employees,
    task: newest,
    submissions: newest ? (subs.get(newest.id) ?? []) : [],
    isCrowd: (w) => w.endsWith(`.${stack.crowdRoot}`),
  });
  step("1. the building shows the crowd on every floor, visitors outside, vault and runway", (p, n) => {
    const staff = chars.filter((c) => c.tier !== null);
    const tiers = new Set(staff.map((c) => c.tier));
    const visitors = chars.filter((c) => c.status === "visitor").length;
    if (staff.length < 18) p.push(`${staff.length} employees on floors, expected ≥ 18`);
    if (tiers.size !== 4) p.push(`floors for tiers ${[...tiers].join(",")}, expected all four`);
    if (visitors < 2) p.push(`${visitors} visitors, expected ≥ 2`);
    if (chars.filter((c) => c.crowd).length !== stack.members.length) p.push("not every crowd account is labeled SIMULATED");
    if (BigInt(treasury.reserve) === 0n || treasury.runway_tasks === null) p.push("no reserve or runway");
    n.push(`${staff.length} employees, ${visitors} visitors, reserve ${treasury.reserve} yocto, runway ${treasury.runway_tasks} tasks`);
  });

  // 2. The boss posts Decode the Memo on schedule (warm-up first); the feed carries the text.
  step("2. the boss posts Decode the Memo (scheduler-driven, warm-up first)", (p, n) => {
    for (let id = 1; id <= rehire; id++) {
      const t = tasks.get(id);
      const opened = feed.find((e) => e.kind === "task_opened" && e.task_id === id);
      if (t?.kind !== "decode_memo") p.push(`task ${id} kind ${t?.kind}`);
      if (!opened) p.push(`no task_opened feed entry for task ${id}`);
      else if (!["template", "ai"].includes(opened.source)) p.push(`task ${id} written by ${opened.source}`);
      const warm = id <= warmupTasks;
      if (opened && opened.data["warmup"] !== warm) p.push(`task ${id} warm-up flag ${String(opened.data["warmup"])}`);
      const windowS = t ? Number((BigInt(t.closes_at) - BigInt(t.opens_at)) / 1_000_000_000n) : 0;
      if (warm && windowS > 15) p.push(`warm-up task ${id} window ${windowS} s, expected ~10 s`);
    }
    n.push(`written by ${feed.find((e) => e.kind === "task_opened")?.source}; ${feed.filter((e) => e.kind === "task_opened").length} tasks opened`);
  });

  // 3. Wallets solve it (bots and the judge), payroll is allocated, a claim pays on chain.
  step("3. bots and the judge solve it; payroll is allocated; claims pay on chain", (p, n) => {
    for (let id = 1; id <= rehire; id++) {
      if ((tasks.get(id)?.passed ?? 0) < 1) p.push(`nobody passed task ${id}`);
      if (!ev("payroll_allocated").some((e) => e.data.task_id === id)) p.push(`no payroll_allocated for task ${id}`);
    }
    const j = sub(live, J);
    if (!j?.passed) p.push(`the judge's task ${live} submission did not pass`);
    if (judgeClaim?.status !== "paid") p.push(`the judge's claim: ${JSON.stringify(judgeClaim)}`);
    if (!ev("salary_paid").some((e) => e.data.account_id === J)) p.push("no salary_paid event for the judge");
    const crowdPaid = ev("salary_paid").filter((e) => e.data.account_id !== J).length;
    if (crowdPaid < 1) p.push("no crowd claim was paid");
    const judgePaid = judgeClaim && "amount" in judgeClaim ? judgeClaim.amount : "?";
    n.push(`${crowdPaid} crowd claims paid, ${ev("salary_forfeited").length} forfeited (anti-dump); judge paid ${judgePaid} yocto`);
  });

  // 4. Wallet F misses its 3rd task: laid off, with the boss's notice.
  step(`4. wallet F misses tasks 2-${live} and is laid off at task ${live}`, (p, n) => {
    for (let id = 2; id <= live; id++) if (sub(id, F)) p.push(`F submitted task ${id}`);
    if (!sub(1, F)?.passed) p.push("F did not pass task 1");
    if (fStatus.get(live) !== "laid_off") p.push(`F's status after task ${live}: ${fStatus.get(live)}`);
    if (!fed("layoff", live, F)) p.push(`no layoff notice for F at task ${live}`);
    n.push(`F's status by last finalized task: ${[...fStatus].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  });

  // 5. F passes the next task as a reapplication and is rehired.
  step(`5. wallet F reapplies at task ${rehire} and is rehired`, (p) => {
    const s = sub(rehire, F);
    if (!s?.reapply || !s.passed) p.push(`F's task ${rehire} submission: ${JSON.stringify(s && { reapply: s.reapply, passed: s.passed })}`);
    if (!ev("rehired").some((e) => e.data.task_id === rehire && e.data.account_id === F)) p.push("no rehired event for F");
    if (fStatus.get(rehire) !== "active") p.push(`F's status after task ${rehire}: ${fStatus.get(rehire)}`);
    if (!fed("rehire", rehire, F)) p.push(`no rehire notice for F at task ${rehire}`);
  });

  // 6. The ledger: income in, salaries out, operating cost, runway; payouts and books exact.
  const acct = await env.provider.viewAccount({ accountId: env.contractId });
  const held = BigInt(String((acct as { amount: unknown }).amount));
  step("6. the ledger shows income, salaries, operating cost and runway; payouts and books are exact", (p, n) => {
    const t = treasury;
    if (BigInt(t.income_by_tag.client_job) === 0n) p.push("no client_job income");
    if (BigInt(t.income_by_tag.seed) === 0n) p.push("no seed income");
    if (BigInt(t.total_paid) === 0n) p.push("no salaries paid");
    if (BigInt(t.total_operating_cost) === 0n) p.push("no operating cost paid");
    if (t.runway_tasks === null) p.push("no runway");
    // The dumper sells after submitting on even live tasks (D-02): its claim must forfeit.
    const dumper = stack.members.find((m) => m.profile === "dumper");
    const dumpTask = live % 2 === 0 ? live : rehire;
    const dumped = dumper ? sub(dumpTask, stack.signer.accountId(dumper.index)) : null;
    if (dumped?.passed && dumped.claim !== "forfeited") p.push(`the dumper's task ${dumpTask} claim is ${dumped.claim}, expected forfeited`);
    for (const [id, task] of tasks) if (task.status === "finalized") p.push(...checkTaskPay(task, subs.get(id)!, config));
    p.push(...checkBooks(t, { deposited: stack.deposited(), submissions: [...subs.values()].flat(), events }));
    const owed = BigInt(t.reserve) + BigInt(t.income_accrued) + BigInt(t.outstanding);
    if (held < owed) p.push(`the contract holds ${held} yocto but owes ${owed}`);
    n.push(`income ${t.total_income}, paid ${t.total_paid}, forfeited ${t.total_forfeited}, operating ${t.total_operating_cost}, reserve ${t.reserve}, outstanding ${t.outstanding}`);
  });

  console.log("");
  for (const s of steps) {
    console.log(`${s.problems.length === 0 ? "✓" : "✗"} ${s.name}`);
    for (const n of s.notes) console.log(`    ${n}`);
    for (const p of s.problems) console.log(`    ✗ ${p}`);
  }
  const failed = steps.filter((s) => s.problems.length > 0).length;
  const stats = JSON.stringify(stack.runner.stats, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${steps.length - failed}/${steps.length} steps, ${info.last_finalized} tasks, ${Math.round((Date.now() - t0) / 1000)} s; crowd ${stats}`);
  return failed === 0 ? 0 : 1;
}

async function readFeed(bossUrl: string): Promise<FeedEntry[]> {
  const out: FeedEntry[] = [];
  for (;;) {
    const res = await fetch(`${bossUrl}/api/feed?since=${out.at(-1)?.id ?? 0}&limit=200`);
    const body = (await res.json()) as { entries: FeedEntry[] };
    out.push(...body.entries);
    if (body.entries.length < 200) return out;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`[e2e] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
