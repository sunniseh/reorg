// D-05: deploy the REORG token and contract to testnet under a root account YOU created.
//
//   npm run testnet:deploy -- --dry-run     print every transaction and the NEAR it needs; signs nothing
//   npm run testnet:deploy                  print the plan, ask for "yes", then sign
//
// Needs (environment or .env.testnet): ROOT_ACCOUNT_ID (e.g. reorg-demo.testnet), ROOT_PRIVATE_KEY,
// NEAR_RPC_URL; optional NEAR_RPC_API_KEY, CONTRACT_CONFIG_PATH (JSON overriding protocol/config.default.json).
// Creates token.<root>, reorg.<root>, boss.<root> and deployer.<root> (the token owner, income bot and
// demo faucet), generating fresh keys for boss, deployer and faucet. Idempotent and resumable: every
// step is skipped when it is already on chain, so a failed run is fixed by running it again.
import { readFileSync } from "node:fs";
import type { ContractConfig } from "@reorg/core";
import {
  DEFAULT_DEPLOY_FUNDING,
  NearChainReader,
  accountNames,
  formatNear,
  formatPlan,
  parseNear,
  planDeploy,
  runSteps,
} from "@reorg/chain-near";
import { ENV_FILE, confirm, explorer, guardNetwork, keyFromEnvOrNew, loadEnv, parseArgs, requireEnv, requireKey, rpcHeaders, upsertEnv } from "./testnet-lib";

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2), ["token-near", "contract-near", "boss-near", "deployer-near", "config"]);
  const dryRun = args.flags.has("dry-run");
  const rootId = requireEnv("ROOT_ACCOUNT_ID");
  const rpcUrl = requireEnv("NEAR_RPC_URL");
  guardNetwork(rootId, rpcUrl);
  const rootKey = requireKey("ROOT_PRIVATE_KEY");
  const headers = rpcHeaders();
  const names = accountNames(rootId);

  const generated: Record<string, string> = {};
  const keys = {
    boss: keyFromEnvOrNew("BOSS_PRIVATE_KEY", generated),
    deployer: keyFromEnvOrNew("INCOME_BOT_PRIVATE_KEY", generated),
    faucet: keyFromEnvOrNew("FAUCET_PRIVATE_KEY", generated),
  };
  const funding = { ...DEFAULT_DEPLOY_FUNDING };
  for (const [flag, field] of [["token-near", "token"], ["contract-near", "contract"], ["boss-near", "boss"], ["deployer-near", "deployer"]] as const) {
    const v = args.values.get(flag);
    if (v !== undefined) funding[field] = parseNear(v);
  }
  const configPath = args.values.get("config") ?? process.env["CONTRACT_CONFIG_PATH"];
  // The default minimum window is 1 h, which would reject open_task for the 30 min epoch (D11: window 22.5 min)
  // and for the warm-up tasks; PROTOCOL.md has deployments override it. Same 5 s as the local demo. A config
  // file wins; the owner can change it later with update_config.
  const config: Partial<ContractConfig> = { min_window_ns: "5000000000", ...(configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as Partial<ContractConfig>) : {}) };

  const reader = new NearChainReader({ rpcUrl, ...(headers ? { rpcHeaders: headers } : {}) });
  const plan = await planDeploy({ reader, rpcUrl, ...(headers ? { rpcHeaders: headers } : {}), rootId, rootKey, keys, funding, config });

  console.log(`\nREORG testnet deploy (D-05), root ${rootId}, rpc ${rpcUrl}\n  config: protocol/config.default.json with min_window_ns = ${config.min_window_ns} ns${configPath ? ` and the overrides in ${configPath}` : ""}\n`);
  for (const line of formatPlan(plan)) console.log(line);
  if (Object.keys(generated).length > 0) console.log(`\nNew keys will be generated for: ${Object.keys(generated).join(", ")} and saved to ${ENV_FILE} (mode 0600).`);

  if (dryRun) {
    console.log("\n--dry-run: nothing was signed.");
    return;
  }
  if (plan.steps.length > 0) {
    if (!args.flags.has("yes") && !(await confirm(`\nSign ${plan.steps.length} transactions on ${rpcUrl} with ${rootId}?`))) {
      console.log("Not confirmed: nothing was signed.");
      process.exitCode = 1;
      return;
    }
    // Keys first: if the run dies halfway, the accounts it created already have keys we can find again.
    if (Object.keys(generated).length > 0) upsertEnv(generated);
    await runSteps(plan.steps);
  }

  upsertEnv({
    NETWORK: "testnet",
    NEAR_RPC_URL: rpcUrl,
    ROOT_ACCOUNT_ID: rootId,
    TOKEN_CONTRACT_ID: names.token,
    REORG_CONTRACT_ID: names.contract,
    OWNER_ACCOUNT_ID: names.deployer,
    BOSS_ACCOUNT_ID: names.boss,
    INCOME_BOT_ACCOUNT_ID: names.deployer,
    FAUCET_ACCOUNT_ID: names.deployer,
    VITE_NETWORK: "testnet",
    VITE_RPC_URL: rpcUrl,
    VITE_TOKEN_CONTRACT_ID: names.token,
    VITE_REORG_CONTRACT_ID: names.contract,
    VITE_CROWD_ROOT: rootId,
  });

  const contractBalance = await reader.accountBalance(names.contract);
  console.log(`
Deployed. Contract ids for the README:
  token     ${names.token}     ${explorer(names.token)}
  contract  ${names.contract}     ${explorer(names.contract)}
  boss      ${names.boss}
  deployer  ${names.deployer}  (token owner, income bot, demo faucet; excluded from the company)
Contract balance ${contractBalance === null ? "?" : formatNear(contractBalance)} NEAR (treasury + storage float; top up with a plain transfer).
Ids and the generated keys are in ${ENV_FILE}.
Next: npm run testnet:seed -- --dry-run`);
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
