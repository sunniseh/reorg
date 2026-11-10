// Developer harness for the live client (roadmap W-11, W-12): a local near-sandbox with the real
// token and contract, a small bot crowd, the real boss service (with the demo faucet) and the web
// client wired to them. `npm run dev:live` (needs `npm run contracts:build` once). Ctrl-C stops all.
//
// Not the judged demo (that is `npm run demo`, roadmap D-01); this exists to see live state, the
// burner wallet and the faucet end to end. Throwaway keys on a throwaway local chain only.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crowdDistribution, ConfigSchema, answerHashBase64, solvePuzzle, type SubmissionView } from "@reorg/core";
import { startSandbox, DEFAULT_SUPPLY } from "@reorg/chain-near/sandbox";
import { KeyPair, nearToYocto, teraToGas } from "near-api-js";

const CROWD_SIZE = Number(process.env.CROWD_SIZE ?? 12);
const EPOCH = Number(process.env.EPOCH_SECONDS ?? 60);
const BOSS_PORT = 8787;
const WEB_PORT = 5173;
const repo = new URL("../", import.meta.url).pathname;
const children: ChildProcess[] = [];
const log = (msg: string) => console.log(`[dev-live] ${msg}`);

async function main(): Promise<void> {
  log("starting near-sandbox and deploying the token and contract…");
  const env = await startSandbox({ config: { min_window_ns: "5000000000" } });
  const stop = async () => {
    children.forEach((c) => c.kill("SIGINT"));
    await env.tearDown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  // The crowd lives under `crowd.<root>`, so the client can label it from deployment config.
  const crowdRoot = await env.createPlayer("crowd", 0n, "120");
  const config = ConfigSchema.parse(await env.provider.callFunction({ contractId: env.contractId, method: "get_config", args: {} }));
  const dist = crowdDistribution(CROWD_SIZE, DEFAULT_SUPPLY, config.tier_thresholds_ppm);
  const publicKey = KeyPair.fromString(env.key).getPublicKey();
  const bounds = (await env.provider.callFunction({ contractId: env.tokenId, method: "storage_balance_bounds", args: {} })) as { min: string };
  const bots: { id: string; role: string; pass: number }[] = [];
  for (const c of dist) {
    const id = `${c.name}.${crowdRoot}`;
    await env.account(crowdRoot).createSubAccount({ accountOrPrefix: id, publicKey, nearToTransfer: nearToYocto("8") });
    await env.account(id).callFunction({ contractId: env.tokenId, methodName: "storage_deposit", args: {}, deposit: BigInt(bounds.min) });
    await env.sendTokens(id, c.amount);
    bots.push({ id, role: c.role, pass: c.index % 6 === 2 ? 0.2 : 0.88 });
  }
  log(`crowd: ${bots.length} bots under ${crowdRoot}`);

  const db = join(mkdtempSync(join(tmpdir(), "reorg-dev-")), "boss.sqlite");
  const bossEnv = {
    ...process.env,
    NETWORK: "sandbox",
    NEAR_RPC_URL: env.rpcUrl,
    REORG_CONTRACT_ID: env.contractId,
    BOSS_ACCOUNT_ID: env.bossId,
    BOSS_PRIVATE_KEY: env.key,
    BOSS_PORT: String(BOSS_PORT),
    BOSS_DB_PATH: db,
    WEB_ORIGIN: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    EPOCH_SECONDS: String(EPOCH),
    WINDOW_FRACTION: "0.6",
    WARMUP_TASKS: "2",
    WARMUP_WINDOW_SECONDS: "8",
    FAUCET_ENABLED: "1",
    FAUCET_ACCOUNT_ID: env.deployerId,
    FAUCET_PRIVATE_KEY: env.key,
  };
  children.push(spawn("npx", ["tsx", "apps/boss/src/main.ts"], { cwd: repo, env: bossEnv, stdio: ["ignore", "ignore", "inherit"] }));
  const webEnv = {
    ...process.env,
    VITE_NETWORK: "sandbox",
    VITE_RPC_URL: env.rpcUrl,
    VITE_REORG_CONTRACT_ID: env.contractId,
    VITE_TOKEN_CONTRACT_ID: env.tokenId,
    VITE_BOSS_URL: `http://127.0.0.1:${BOSS_PORT}`,
    VITE_CROWD_ROOT: crowdRoot,
    VITE_DEMO: "1",
  };
  children.push(spawn("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], { cwd: join(repo, "apps/web"), env: webEnv, stdio: "inherit" }));
  log(`web: http://localhost:${WEB_PORT}  boss: http://127.0.0.1:${BOSS_PORT}  rpc: ${env.rpcUrl}`);

  // Income bot (simulated client jobs, D-08) and a tiny crowd runner (the real one is D-02).
  const boss = `http://127.0.0.1:${BOSS_PORT}`;
  const seen = new Set<number>();
  const claimed = new Set<string>();
  let lastIncome = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if (Date.now() - lastIncome > EPOCH * 1000) {
        lastIncome = Date.now();
        await env.account(env.deployerId).callFunction({ contractId: env.contractId, methodName: "deposit_income", args: { tag: "client_job" }, deposit: nearToYocto("1") });
      }
      const res = await fetch(`${boss}/api/task/current`);
      if (!res.ok) continue;
      const t = (await res.json()) as { task_id: number; status: string; closes_at: string };
      if (t.status === "open" && !seen.has(t.task_id)) {
        seen.add(t.task_id);
        const windowMs = Number(BigInt(t.closes_at) / 1_000_000n) - Date.now();
        for (const b of bots) {
          if (b.role === "visitor" || Math.random() > 0.85) continue;
          setTimeout(() => void file(b, t.task_id), Math.max(500, Math.random() * windowMs * 0.8));
        }
      }
      if (t.status === "finalized") {
        for (const b of bots) {
          const key = `${t.task_id}|${b.id}`;
          if (claimed.has(key)) continue;
          claimed.add(key);
          const s = (await env.provider.callFunction({ contractId: env.contractId, method: "get_submission", args: { task_id: t.task_id, account_id: b.id } })) as SubmissionView | null;
          if (s?.passed && s.pay !== "0" && !s.reapply)
            setTimeout(() => void env.account(b.id).callFunction({ contractId: env.contractId, methodName: "claim_salary", args: { task_id: t.task_id }, gas: teraToGas("100") }).catch(() => undefined), 1000 + Math.random() * 8000);
        }
      }
    } catch (e) {
      log(`runner: ${(e as Error).message}`);
    }
  }

  async function file(b: { id: string; pass: number }, taskId: number): Promise<void> {
    try {
      const p = (await (await fetch(`${boss}/api/puzzle?wallet=${encodeURIComponent(b.id)}`)).json()) as { display: string; hint: string };
      const [answer] = solvePuzzle("decode-memo", p.display, p.hint);
      if (!answer) return;
      const filed = Math.random() < b.pass ? answer : `${answer.slice(0, 7)}${answer.endsWith("A") ? "E" : "A"}`;
      await env.submit(b.id, taskId, answerHashBase64(filed, b.id));
    } catch {
      /* late or rejected: fine for a bot */
    }
  }
}

main().catch((e) => {
  console.error(e);
  children.forEach((c) => c.kill("SIGINT"));
  process.exit(1);
});

