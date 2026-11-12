// The local demo stack (roadmap D-01), shared by `npm run demo` and `npm run e2e`:
// near-sandbox → real token + contract → the D13 crowd → seed income → the boss service (child
// process) → crowd runner + income bot (in process) → the web client (Vite, optional).
// Everything lives in a fresh temp dir and a fresh chain, so a re-run never sees old state.
// Throwaway keys on a throwaway local chain only.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crowdProfiles, type CrowdMember } from "@reorg/core";
import { NearCrowdSigner, NearDemoOperator, NearReader } from "@reorg/chain-near";
import { addAccessKey, seedCrowd, startSandbox, type SandboxEnv } from "@reorg/chain-near/sandbox";
import { CrowdRunner, httpBoss } from "./runner";

export const REPO = new URL("../../../", import.meta.url).pathname;
export const NEAR = 10n ** 24n;

export interface StackOptions {
  epochSeconds: number;
  windowFraction: number;
  warmupTasks: number;
  warmupWindowSeconds: number;
  crowdSize: number;
  crowdSeed: string;
  /** yoctoNEAR deposited (client_job) per opened task by the income bot. */
  incomePerTask: bigint;
  /** yoctoNEAR deposited once at boot (tag seed), so the vault isn't empty on day one. */
  seedIncome: bigint;
  /** Serve the web client (the e2e runs without it). */
  web: boolean;
  /** Preferred ports; the next free one is used if taken. */
  bossPort: number;
  webPort: number;
  log: (msg: string) => void;
  crowdLog?: (msg: string) => void;
}

export interface Stack {
  env: SandboxEnv;
  crowdRoot: string;
  members: CrowdMember[];
  signer: NearCrowdSigner;
  operator: NearDemoOperator;
  reader: NearReader;
  runner: CrowdRunner;
  bossUrl: string;
  webUrl: string | null;
  /** Temp dir with boss.sqlite, boss.log and web.log. */
  dir: string;
  /** Every income deposit made so far (seed + income bot), for the books check. */
  deposited(): bigint;
  /** Resolves with a reason when the boss or the web server exits on its own. */
  crashed: Promise<string>;
  /** Stops the runner, the boss and the web server; the chain keeps running. */
  stopServices(): Promise<void>;
  /** Everything, including the chain and the temp dir. Safe to call twice. */
  stop(): Promise<void>;
}

type StackConfig = Omit<StackOptions, "web" | "log" | "crowdLog">;

/**
 * Demo defaults (D11: 75 s epoch with a 50 s window; D-03: 3 warm-up tasks of ~10 s; D13: 20
 * accounts), each overridable by the environment variable of the same name as the boss's.
 * The crowd seed has a public default because the local chain is throwaway; testnet never uses it.
 */
export function stackConfig(env: NodeJS.ProcessEnv, defaults: Partial<StackConfig> = {}): StackConfig {
  const num = (name: string, def: number, min = 1) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be a number ≥ ${min}, got "${raw}"`);
    return v;
  };
  const yocto = (name: string, def: bigint) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of yoctoNEAR, got "${raw}"`);
    return BigInt(raw);
  };
  return {
    epochSeconds: num("EPOCH_SECONDS", defaults.epochSeconds ?? 75, 20),
    windowFraction: num("WINDOW_FRACTION", defaults.windowFraction ?? 50 / 75, 0.05),
    warmupTasks: num("WARMUP_TASKS", defaults.warmupTasks ?? 3, 0),
    warmupWindowSeconds: num("WARMUP_WINDOW_SECONDS", defaults.warmupWindowSeconds ?? 10, 6),
    crowdSize: num("CROWD_SIZE", defaults.crowdSize ?? 20),
    crowdSeed: env["CROWD_SEED"] || (defaults.crowdSeed ?? "reorg-local-demo"),
    incomePerTask: yocto("INCOME_BOT_AMOUNT", defaults.incomePerTask ?? 2n * NEAR),
    seedIncome: defaults.seedIncome ?? 20n * NEAR,
    bossPort: num("BOSS_PORT", defaults.bossPort ?? 8787),
    webPort: num("WEB_PORT", defaults.webPort ?? 5173),
  };
}

/** Whether `port` can be bound on `host`; a host this machine lacks (no IPv6) counts as free. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * First port at or after `from` that is free on 127.0.0.1, ::1 and the wildcards ("localhost" is
 * ::1 on macOS, so a dev server already there would otherwise answer our readiness check; and
 * macOS lets a loopback bind succeed beside a server listening on `*:port`, which the boss, a
 * wildcard listener itself, could not then bind).
 */
export async function freePort(from: number, skip: readonly number[] = []): Promise<number> {
  const hosts = ["127.0.0.1", "::1", "0.0.0.0", "::"];
  for (let port = from; port < from + 50; port++) {
    if (skip.includes(port)) continue;
    let free = true;
    for (const host of hosts) if (free) free = await canBind(port, host);
    if (free) return port;
  }
  throw new Error(`no free port in ${from}…${from + 49}`);
}

async function waitFor(what: string, url: string, timeoutMs: number, crashed: Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let dead: string | null = null;
  void crashed.then((r) => (dead = r));
  while (Date.now() < deadline) {
    if (dead) throw new Error(dead);
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs / 1000} s`);
}

export async function startStack(o: StackOptions): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "reorg-demo-"));
  const children: ChildProcess[] = [];
  let stopping = false;
  let onCrash: (reason: string) => void = () => {};
  const crashed = new Promise<string>((resolve) => (onCrash = resolve));

  const launch = (name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const log = join(dir, `${name}.log`);
    const fd = openSync(log, "a");
    // Own process group, so stopping reaches every grandchild and nothing outlives the demo.
    const proc = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    proc.on("exit", (code, signal) => {
      if (stopping) return;
      const tail = readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n");
      onCrash(`${name} exited (${signal ?? `code ${code}`}); last lines of ${log}:\n${tail}`);
    });
    children.push(proc);
  };

  o.log("starting near-sandbox and deploying the token and the contract…");
  // 5 s minimum window so the 10 s warm-up tasks (D-03) are allowed; everything else is default config.
  const env = await startSandbox({ config: { min_window_ns: "5000000000" }, deployerNear: "5000" });
  let runner: CrowdRunner | null = null;

  const stopServices = async () => {
    stopping = true;
    await runner?.stop();
    await Promise.all(
      children.map(
        (proc) =>
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
            const signal = (s: NodeJS.Signals) => {
              try {
                process.kill(-proc.pid!, s);
              } catch {
                /* already gone */
              }
            };
            const force = setTimeout(() => signal("SIGKILL"), 5000);
            proc.once("exit", () => (clearTimeout(force), resolve()));
            signal("SIGINT");
          }),
      ),
    );
  };
  let stopped: Promise<void> | null = null;
  const stop = () =>
    (stopped ??= (async () => {
      await stopServices();
      await env.tearDown().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    })());

  try {
    o.log(`seeding the simulated crowd: ${o.crowdSize} accounts…`);
    const { root, crowd } = await seedCrowd(env, { seed: o.crowdSeed, size: o.crowdSize });
    const members = crowdProfiles(crowd);
    const common = { rpcUrl: env.rpcUrl, contractId: env.contractId, tokenId: env.tokenId };
    const signer = new NearCrowdSigner({ ...common, root, names: crowd.map((c) => c.name), seed: o.crowdSeed });
    // The deployer is excluded from the company: it is the income bot, the dumper's market and the faucet.
    const operator = new NearDemoOperator({ ...common, accountId: env.deployerId, key: env.key });
    const reader = new NearReader({ rpcUrl: env.rpcUrl, contractId: env.contractId });
    if (o.seedIncome > 0n) await operator.depositIncome(o.seedIncome, "seed");

    // The boss's faucet signs for the deployer too, from another process: give it its own key.
    const faucetKey = await addAccessKey(env, env.deployerId);
    const bossPort = await freePort(o.bossPort);
    const bossUrl = `http://127.0.0.1:${bossPort}`;
    const webPort = o.web ? await freePort(o.webPort, [bossPort]) : 0;
    o.log(`starting the boss (epoch ${o.epochSeconds} s, ${o.warmupTasks} warm-up tasks of ${o.warmupWindowSeconds} s)…`);
    launch("boss", ["--import", "tsx", "src/main.ts"], join(REPO, "apps/boss"), {
      ...process.env,
      NETWORK: "sandbox",
      NEAR_RPC_URL: env.rpcUrl,
      REORG_CONTRACT_ID: env.contractId,
      BOSS_ACCOUNT_ID: env.bossId,
      BOSS_PRIVATE_KEY: env.key,
      BOSS_PORT: String(bossPort),
      BOSS_DB_PATH: join(dir, "boss.sqlite"),
      WEB_ORIGIN: o.web ? `http://localhost:${webPort},http://127.0.0.1:${webPort}` : "",
      EPOCH_SECONDS: String(o.epochSeconds),
      WINDOW_FRACTION: String(o.windowFraction),
      WARMUP_TASKS: String(o.warmupTasks),
      WARMUP_WINDOW_SECONDS: String(o.warmupWindowSeconds),
      FAUCET_ENABLED: "1",
      FAUCET_ACCOUNT_ID: env.deployerId,
      FAUCET_PRIVATE_KEY: faucetKey,
    });
    await waitFor("the boss", `${bossUrl}/healthz`, 60_000, crashed);

    runner = new CrowdRunner({
      boss: httpBoss(bossUrl),
      reader,
      signer,
      operator,
      members,
      seed: o.crowdSeed,
      incomePerTask: o.incomePerTask,
      ...(o.crowdLog ? { log: o.crowdLog } : {}),
    });
    void runner.run();

    let webUrl: string | null = null;
    if (o.web) {
      webUrl = `http://localhost:${webPort}`;
      o.log("starting the web client…");
      launch("web", [join(REPO, "node_modules/vite/bin/vite.js"), "--port", String(webPort), "--strictPort", "--host", "localhost"], join(REPO, "apps/web"), {
        ...process.env,
        VITE_NETWORK: "sandbox",
        VITE_RPC_URL: env.rpcUrl,
        VITE_REORG_CONTRACT_ID: env.contractId,
        VITE_TOKEN_CONTRACT_ID: env.tokenId,
        VITE_BOSS_URL: bossUrl,
        VITE_CROWD_ROOT: root,
        VITE_DEMO: "1",
      });
      await waitFor("the web client", webUrl, 60_000, crashed);
    }

    const r = runner;
    return {
      env,
      crowdRoot: root,
      members,
      signer,
      operator,
      reader,
      runner: r,
      bossUrl,
      webUrl,
      dir,
      deposited: () => o.seedIncome + r.stats.income,
      crashed,
      stopServices,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** One entry of the boss's `GET /api/feed` (apps/boss/src/store.ts). */
export interface FeedEntry {
  id: number;
  at: number;
  kind: string;
  task_id: number | null;
  text: string;
  source: string;
  data: Record<string, unknown>;
}

/** Polls the boss feed and calls `on` for every new entry, in order. Returns a stop function. */
export function followFeed(bossUrl: string, on: (e: FeedEntry) => void, everyMs = 1000): () => void {
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const poll = async () => {
    try {
      const res = await fetch(`${bossUrl}/api/feed?since=${since}&limit=200`);
      if (res.ok) {
        const body = (await res.json()) as { entries: FeedEntry[]; last_id: number };
        for (const e of body.entries) on(e);
        since = body.last_id;
      }
    } catch {
      /* the boss is restarting or stopping */
    }
    if (!stopped) timer = setTimeout(() => void poll(), everyMs);
  };
  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
