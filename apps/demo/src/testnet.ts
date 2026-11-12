// `npm run testnet:crowd` (roadmap D-07): the simulated crowd and the income bot against the game that
// `npm run testnet:deploy` / `testnet:seed` put on testnet, until Ctrl-C. The boss runs separately
// (`npm run testnet:boss`, hosted per D-10); this process only talks to it over HTTP, like a player.
// Same runner as the local demo (D-02, D-08), so every behavior profile and the scripted wallet F play
// out on a real chain, throttled for a public RPC. SIMULATED: real accounts we created, driven by bots.
//
// Environment (`.env.testnet` is loaded by the npm script): ROOT_ACCOUNT_ID, NEAR_RPC_URL, CROWD_SEED,
// INCOME_BOT_PRIVATE_KEY; optional BOSS_URL (default http://127.0.0.1:8787), NEAR_RPC_API_KEY,
// TOKEN_CONTRACT_ID / REORG_CONTRACT_ID (default token.<root> / reorg.<root>), CROWD_SIZE (20),
// INCOME_BOT_ACCOUNT_ID (deployer.<root>), INCOME_BOT_AMOUNT in yoctoNEAR (default 0.2 NEAR per task:
// the demo's 2 NEAR would burn ~100 NEAR a day at a 30 min epoch), RPC_MIN_INTERVAL_MS (default 400).
import { ConfigSchema, crowdDistribution, crowdProfiles } from "@reorg/core";
import { NearCrowdSigner, NearDemoOperator, NearReader, Throttle } from "@reorg/chain-near";
import { NearChainReader, accountNames, formatNear } from "@reorg/chain-near/node";
import { CrowdRunner, httpBoss } from "./runner";

const t0 = Date.now();
const say = (msg: string) => console.log(`[crowd ${new Date().toISOString().slice(11, 19)}] ${msg}`);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example; \`npm run testnet:deploy\` and \`testnet:seed\` write it to .env.testnet)`);
  return v;
}

async function main(): Promise<void> {
  const rootId = need("ROOT_ACCOUNT_ID");
  const rpcUrl = need("NEAR_RPC_URL");
  if (process.env["NETWORK"] !== "sandbox" && !rootId.endsWith(".testnet")) throw new Error(`refusing to run: ROOT_ACCOUNT_ID "${rootId}" is not a *.testnet account (this repo never touches mainnet)`);
  if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing to run: NEAR_RPC_URL "${rpcUrl}" looks like mainnet`);
  const names = accountNames(rootId);
  const tokenId = process.env["TOKEN_CONTRACT_ID"] || names.token;
  const contractId = process.env["REORG_CONTRACT_ID"] || names.contract;
  const seed = need("CROWD_SEED");
  const size = Number(process.env["CROWD_SIZE"] || 20);
  if (!Number.isInteger(size) || size < 1) throw new Error(`CROWD_SIZE must be a positive integer, got "${process.env["CROWD_SIZE"]}"`);
  const bossUrl = (process.env["BOSS_URL"] || "http://127.0.0.1:8787").replace(/\/$/, "");
  const income = BigInt(process.env["INCOME_BOT_AMOUNT"] || "200000000000000000000000");
  const headers = process.env["NEAR_RPC_API_KEY"] ? { "x-api-key": process.env["NEAR_RPC_API_KEY"] } : undefined;
  const throttle = new Throttle(Number(process.env["RPC_MIN_INTERVAL_MS"] || 400));
  const rpc = { rpcUrl, ...(headers ? { rpcHeaders: headers } : {}) };

  const reader = new NearReader({ ...rpc, contractId, tokenId });
  const info = await reader.getInfo().catch((e: unknown) => {
    throw new Error(`cannot read ${contractId} on ${rpcUrl}: ${e instanceof Error ? e.message : String(e)}. Run \`npm run testnet:deploy\` first.`);
  });
  const config = ConfigSchema.parse(await reader.getConfig());
  const crowd = crowdDistribution(size, BigInt(info.total_supply), config.tier_thresholds_ppm);
  const members = crowdProfiles(crowd);

  // Everything the runner will sign for must exist: fail now, not on the first task.
  const chain = new NearChainReader(rpc);
  const unseeded: string[] = [];
  for (const c of crowd) {
    const held = await chain.view<string>(tokenId, "ft_balance_of", { account_id: `${c.name}.${rootId}` });
    if (held === null || BigInt(held) === 0n) unseeded.push(`${c.name}.${rootId}`);
  }
  if (unseeded.length > 0) throw new Error(`${unseeded.length} of ${size} crowd accounts hold no tokens (${unseeded.slice(0, 3).join(", ")}…): run \`npm run testnet:seed\` first`);
  const bossHealth = await fetch(`${bossUrl}/healthz`).then((r) => r.ok, () => false);
  if (!bossHealth) throw new Error(`the boss does not answer at ${bossUrl}/healthz: start it with \`npm run testnet:boss\` (or set BOSS_URL)`);

  const common = { ...rpc, contractId, tokenId, throttle };
  const signer = new NearCrowdSigner({ ...common, root: rootId, names: crowd.map((c) => c.name), seed });
  const operatorId = process.env["INCOME_BOT_ACCOUNT_ID"] || names.deployer;
  const operator = new NearDemoOperator({ ...common, accountId: operatorId, key: need("INCOME_BOT_PRIVATE_KEY") });
  const runner = new CrowdRunner({ boss: httpBoss(bossUrl), reader, signer, operator, members, seed, incomePerTask: income, log: say });

  const f = members.find((m) => m.profile === "scripted");
  say(`${size} SIMULATED holders under ${rootId} on ${rpcUrl}; contract ${contractId}, boss ${bossUrl}`);
  say(`income bot ${operatorId} deposits ${formatNear(income)} NEAR (client_job, simulated) per task; RPC calls spaced ≥ ${process.env["RPC_MIN_INTERVAL_MS"] || 400} ms`);
  if (f) say(`wallet F is ${signer.accountId(f.index)}`);

  const status = () => {
    const s = runner.stats;
    say(`up ${Math.round((Date.now() - t0) / 60_000)} min: submitted ${s.submitted}, rejected ${s.rejected}, paid ${s.paid}, forfeited ${s.forfeited}, dumps ${s.dumps}, errors ${s.errors}, income ${formatNear(s.income)} NEAR`);
  };
  const timer = setInterval(status, 10 * 60_000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    say("stopping: waiting for transactions in flight…");
    await runner.stop();
    status();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await runner.run();
}

main().catch((e: unknown) => {
  console.error(`[crowd] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
