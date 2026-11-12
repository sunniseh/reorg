// D-06: create and fund the simulated crowd on testnet: c001…c0NN.<root>, keys derived from CROWD_SEED
// (never stored with the code), each registered with the token and sent its D13 share.
//
//   npm run testnet:seed -- --dry-run      print the crowd, every transaction and the NEAR needed; signs nothing
//   npm run testnet:seed                   print the plan, ask for "yes", then sign
//
// Needs (environment or .env.testnet): ROOT_ACCOUNT_ID, ROOT_PRIVATE_KEY, NEAR_RPC_URL, and the ids and
// INCOME_BOT_PRIVATE_KEY that `npm run testnet:deploy` saved. CROWD_SEED: if unset, a random one is generated
// on a real run and saved to .env.testnet (it must not change afterwards: it is what derives the keys).
// CROWD_SIZE (default 20). Idempotent and resumable: a balance that has moved since seeding is never topped up.
import { KeyPair } from "near-api-js";
import { NearChainReader, accountNames, formatCrowd, formatNear, formatPlan, parseNear, planCrowdSeed, runSteps } from "@reorg/chain-near/node";
import { ENV_FILE, confirm, guardNetwork, loadEnv, parseArgs, requireEnv, requireKey, rpcHeaders, upsertEnv } from "./testnet-lib";

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2), ["near-each"]);
  const dryRun = args.flags.has("dry-run");
  const rootId = requireEnv("ROOT_ACCOUNT_ID");
  const rpcUrl = requireEnv("NEAR_RPC_URL");
  guardNetwork(rootId, rpcUrl);
  const names = accountNames(rootId);
  const headers = rpcHeaders();
  const size = Number(process.env["CROWD_SIZE"] || 20);
  if (!Number.isInteger(size) || size < 1 || size > 999) throw new Error(`CROWD_SIZE must be an integer from 1 to 999, got "${process.env["CROWD_SIZE"]}"`);
  const nearEach = parseNear(args.values.get("near-each") ?? "1");

  let seed = process.env["CROWD_SEED"] ?? "";
  let newSeed = false;
  if (!seed) {
    // Only an unused seed may be generated: the plan below refuses accounts that exist under another one.
    seed = Buffer.from(KeyPair.fromRandom("ed25519").toString()).toString("base64url").slice(0, 32);
    newSeed = true;
  }
  if (seed === "reorg-local-demo") throw new Error("CROWD_SEED is the public local-demo default: pick a private one (or leave it unset to have one generated)");

  const reader = new NearChainReader({ rpcUrl, ...(headers ? { rpcHeaders: headers } : {}) });
  const plan = await planCrowdSeed({
    reader,
    rpcUrl,
    ...(headers ? { rpcHeaders: headers } : {}),
    crowdRoot: rootId,
    crowdRootKey: requireKey("ROOT_PRIVATE_KEY"),
    deployerId: names.deployer,
    deployerKey: requireKey("INCOME_BOT_PRIVATE_KEY"),
    tokenId: process.env["TOKEN_CONTRACT_ID"] || names.token,
    contractId: process.env["REORG_CONTRACT_ID"] || names.contract,
    seed,
    size,
    nearEach,
  });

  console.log(`\nREORG testnet crowd seeding (D-06), ${size} accounts under ${rootId}, ${formatNear(nearEach)} NEAR each, rpc ${rpcUrl}\n`);
  console.log("The crowd (D13), SIMULATED holders we create:");
  for (const line of formatCrowd(plan.crowd, rootId, plan.supply)) console.log(line);
  console.log("");
  for (const line of formatPlan(plan)) console.log(line);
  if (newSeed) console.log(`\nCROWD_SEED is not set: a random one will be generated and saved to ${ENV_FILE} (mode 0600) on a real run.`);

  if (dryRun) {
    console.log("\n--dry-run: nothing was signed.");
    return;
  }
  if (plan.steps.length > 0) {
    if (!args.flags.has("yes") && !(await confirm(`\nSign ${plan.steps.length} transactions on ${rpcUrl}?`))) {
      console.log("Not confirmed: nothing was signed.");
      process.exitCode = 1;
      return;
    }
    if (newSeed) upsertEnv({ CROWD_SEED: seed });
    upsertEnv({ CROWD_SIZE: String(size) });
    await runSteps(plan.steps);
  }
  console.log(`\nCrowd seeded: ${size} accounts c001…c${String(size).padStart(3, "0")}.${rootId}. Next: npm run testnet:crowd (after npm run testnet:boss).`);
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
