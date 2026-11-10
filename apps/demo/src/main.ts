// `npm run demo` (roadmap D-01): the whole game on a local chain with one command. Starts a fresh
// near-sandbox with the real contracts, the simulated crowd, the boss and the web client, then
// prints the URL and the boss's feed. Ctrl-C stops everything; a re-run starts from scratch.
// Overrides (all optional): EPOCH_SECONDS, WINDOW_FRACTION, WARMUP_TASKS, WARMUP_WINDOW_SECONDS,
// CROWD_SIZE, CROWD_SEED, INCOME_BOT_AMOUNT, BOSS_PORT, WEB_PORT; DEMO_VERBOSE=1 logs the crowd.
import { followFeed, stackConfig, startStack, type FeedEntry, type Stack } from "./stack";

const t0 = Date.now();
const clock = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const say = (msg: string) => console.log(`[demo ${clock()}] ${msg}`);

const LABEL: Record<string, string> = {
  task_opened: "TASK    ",
  results: "RESULTS ",
  payday: "PAYDAY  ",
  layoff: "LAYOFF  ",
  layoff_warning: "WARNING ",
  rehire: "REHIRE  ",
  streak: "STREAK  ",
  reserve_low: "LOW CASH",
  stalled: "STALLED ",
  recovered: "BACK    ",
};

async function main(): Promise<void> {
  const cfg = stackConfig(process.env);
  let stack: Stack | null = null;
  let stopping = 0;
  const shutdown = async (code: number) => {
    // One Ctrl-C reaches us twice (from the terminal and relayed by npm/tsx): only a second
    // press, a moment later, forces the exit.
    if (stopping) {
      if (Date.now() - stopping > 2000) process.exit(code);
      return;
    }
    stopping = Date.now();
    say("stopping the web client, the boss, the crowd and the chain…");
    await stack?.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  stack = await startStack({ ...cfg, web: true, log: say, ...(process.env["DEMO_VERBOSE"] ? { crowdLog: (m: string) => say(`crowd: ${m}`) } : {}) });
  const s = stack;
  void s.crashed.then((reason) => {
    console.error(`\n[demo] ${reason}\n`);
    void shutdown(1);
  });

  const f = s.members.find((m) => m.profile === "scripted");
  const fId = f ? s.signer.accountId(f.index) : null;
  const live = cfg.warmupTasks + 1;
  console.log(`
  ┌────────────────────────────────────────────────────────────────────────┐
    REORG local demo is up in ${Math.round((Date.now() - t0) / 1000)} s.  Open  ${s.webUrl}
  └────────────────────────────────────────────────────────────────────────┘
  Everything runs on a local near-sandbox: the token, the contract and every
  transaction are real; the ${cfg.crowdSize} holders are SIMULATED (bots we created), and
  the income is deposited by our income bot (SIMULATED). The first ${cfg.warmupTasks} tasks are
  short warm-up tasks played by the bots, so the history you see is bot-generated.

  What to watch (one task every ${cfg.epochSeconds} s, ${Math.round(cfg.epochSeconds * cfg.windowFraction)} s to answer):
    · the boss posts "Decode the Memo"; the crowd walks its answers to the outbox
    · "Badge in" (top bar) makes you a demo player: solve the memo, then claim your pay
    · payday: coins go up the tube from the vault after each task
    · ${fId ?? "wallet F"} (wallet F, an Intern) misses tasks 2-${live}: laid off at the end of
      task ${live}, walks out to the bench; passes task ${live + 1} and is rehired
    · the vault (basement) opens the ledger: income, salaries, operating cost, runway

  boss ${s.bossUrl}   rpc ${s.env.rpcUrl}   logs ${s.dir}
  Ctrl-C stops everything.
`);

  followFeed(s.bossUrl, (e: FeedEntry) => {
    const who = typeof e.data["account"] === "string" ? (e.data["account"] as string) : null;
    const mark = who && who === fId ? "  ← wallet F" : "";
    const text = e.text.length > 150 ? `${e.text.slice(0, 147)}…` : e.text;
    say(`${LABEL[e.kind] ?? e.kind.padEnd(8)} ${e.task_id !== null ? `#${e.task_id} ` : ""}${text}${mark}`);
  });
}

main().catch((e: unknown) => {
  console.error(`[demo] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
