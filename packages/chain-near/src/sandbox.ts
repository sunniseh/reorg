// Local near-sandbox harness: deploys the real token and REORG contract and creates funded
// player accounts. Used by the boss end-to-end test and by `npm run demo` / `npm run e2e` (D-01, D-04).
// Throwaway keys only: everything here lives on a local chain that is deleted on tearDown.
import { readFileSync } from "node:fs";
import { ConfigSchema, crowdDistribution, type ContractConfig, type CrowdAccount, type SubmitOutcome, type TaskId } from "@reorg/core";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { crowdPublicKey } from "./crowd";

const REPO = new URL("../../../", import.meta.url);
const TOKEN_DECIMALS = 18n;
export const ONE_TOKEN = 10n ** TOKEN_DECIMALS;
export const DEFAULT_SUPPLY = 1_000_000_000n * ONE_TOKEN;
const USER_GAS = teraToGas("100");

/**
 * A fresh local build (`npm run contracts:build`) wins; otherwise the prebuilt copy in
 * `contracts/res/` (refreshed by every build), so a clone without Rust still runs the demo.
 */
function wasm(name: string): Uint8Array {
  const built = new URL(`contracts/target/near/${name}/${name}.wasm`, REPO);
  const prebuilt = new URL(`contracts/res/${name}.wasm`, REPO);
  for (const url of [built, prebuilt]) {
    try {
      return readFileSync(url);
    } catch {
      /* try the next */
    }
  }
  throw new Error(`${name}.wasm missing (${built.pathname} or ${prebuilt.pathname}): run \`npm run contracts:build\` first`);
}

export function defaultContractConfig(): ContractConfig {
  return ConfigSchema.parse(JSON.parse(readFileSync(new URL("protocol/config.default.json", REPO), "utf8")));
}

export interface SandboxEnv {
  sandbox: Sandbox;
  rpcUrl: string;
  provider: JsonRpcProvider;
  /** Every account created here shares this throwaway key. */
  key: KeyPairString;
  tokenId: string;
  contractId: string;
  bossId: string;
  deployerId: string;
  account(id: string): Account;
  /** Creates `<name>.<root>` with NEAR, registers it with the token and sends it tokens. */
  createPlayer(name: string, tokens: bigint, near?: `${number}`): Promise<string>;
  sendTokens(to: string, amount: bigint): Promise<void>;
  /** Submits an answer hash (base64) as `playerId`; returns the callback outcome. */
  submit(playerId: string, taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome>;
  depositIncome(yocto: bigint): Promise<void>;
  tearDown(): Promise<void>;
}

export interface SandboxOptions {
  /** Overrides for protocol/config.default.json (e.g. a short `min_window_ns`). */
  config?: Partial<ContractConfig>;
  supply?: bigint;
  /** NEAR for the deployer (default 100). The demo uses it as the income bot and faucet. */
  deployerNear?: `${number}`;
}

export async function startSandbox(opts: SandboxOptions = {}): Promise<SandboxEnv> {
  const sandbox = await Sandbox.start({});
  try {
    return await setup(sandbox, opts);
  } catch (e) {
    await sandbox.tearDown();
    throw e;
  }
}

async function setup(sandbox: Sandbox, opts: SandboxOptions): Promise<SandboxEnv> {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
  const key = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
  const publicKey = KeyPair.fromString(key).getPublicKey();
  const account = (id: string) => new Account(id, provider, key);
  const create = async (name: string, near: `${number}`): Promise<string> => {
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await root.createSubAccount({ accountOrPrefix: id, publicKey, nearToTransfer: nearToYocto(near) });
    return id;
  };

  const supply = opts.supply ?? DEFAULT_SUPPLY;
  const deployerId = await create("deployer", opts.deployerNear ?? "100");
  const bossId = await create("boss", "20");
  const tokenId = await create("token", "10");
  const contractId = await create("reorg", "20");

  await account(tokenId).deployContract(wasm("reorg_token"));
  await account(tokenId).callFunction({
    contractId: tokenId,
    methodName: "new",
    args: {
      owner_id: deployerId,
      total_supply: supply.toString(),
      metadata: { spec: "ft-1.0.0", name: "REORG", symbol: "REORG", decimals: Number(TOKEN_DECIMALS) },
    },
  });

  const config: ContractConfig = ConfigSchema.parse({
    ...defaultContractConfig(),
    ...opts.config,
    excluded_accounts: [deployerId, contractId, tokenId, ...(opts.config?.excluded_accounts ?? [])],
  });
  await account(contractId).deployContract(wasm("reorg_contract"));
  await account(contractId).callFunction({
    contractId,
    methodName: "new",
    args: { config, token: tokenId, boss: bossId, total_supply: supply.toString(), owner: deployerId },
  });

  const bounds = (await provider.callFunction({ contractId: tokenId, method: "storage_balance_bounds", args: {} })) as {
    min: string;
  };
  const sendTokens = async (to: string, amount: bigint) => {
    await account(deployerId).callFunction({
      contractId: tokenId,
      methodName: "ft_transfer",
      args: { receiver_id: to, amount: amount.toString() },
      deposit: 1n,
    });
  };

  return {
    sandbox,
    rpcUrl: sandbox.rpcUrl,
    provider,
    key,
    tokenId,
    contractId,
    bossId,
    deployerId,
    account,
    sendTokens,
    async createPlayer(name, tokens, near = "5") {
      const id = await create(name, near);
      await account(id).callFunction({
        contractId: tokenId,
        methodName: "storage_deposit",
        args: {},
        deposit: BigInt(bounds.min),
      });
      if (tokens > 0n) await sendTokens(id, tokens);
      return id;
    },
    async submit(playerId, taskId, answerHashB64) {
      return (await account(playerId).callFunction({
        contractId,
        methodName: "submit",
        args: { task_id: taskId, answer_hash: answerHashB64 },
        gas: USER_GAS,
      })) as SubmitOutcome;
    },
    async depositIncome(yocto) {
      await root.callFunction({ contractId, methodName: "deposit_income", args: { tag: "seed" }, deposit: yocto });
    },
    tearDown: () => sandbox.tearDown(),
  };
}

/**
 * Adds a fresh full-access key to `accountId` and returns it. Two processes signing for one account
 * (the demo's income bot and the boss's faucet, both the deployer) each get their own key, so their
 * nonces never collide.
 */
export async function addAccessKey(env: SandboxEnv, accountId: string): Promise<KeyPairString> {
  const key = KeyPair.fromRandom("ed25519");
  await env.account(accountId).addFullAccessKey(key.getPublicKey());
  return key.toString() as KeyPairString;
}

export interface SandboxCrowd {
  /** Crowd accounts are `<name>.<root>`; the client labels them SIMULATED from this. */
  root: string;
  crowd: CrowdAccount[];
}

/**
 * Creates the D13 crowd on a sandbox (roadmap D-01): `c001…<size>.crowd.<sandbox root>`, keys from
 * `crowdKey(seed, i)`, each registered with the token and holding its `crowdDistribution` share.
 * Two sequential lanes run side by side, one per signer (nonces are per account key): the crowd
 * root creates the accounts while the deployer registers and funds them with the token (which does
 * not need the account to exist yet).
 */
export async function seedCrowd(env: SandboxEnv, opts: { seed: string; size: number; nearEach?: `${number}` }): Promise<SandboxCrowd> {
  const nearEach = opts.nearEach ?? "5";
  const config = ConfigSchema.parse(await env.provider.callFunction({ contractId: env.contractId, method: "get_config", args: {} }));
  const supply = BigInt((await env.provider.callFunction({ contractId: env.tokenId, method: "ft_total_supply", args: {} })) as string);
  const crowd = crowdDistribution(opts.size, supply, config.tier_thresholds_ppm);
  const root = await env.createPlayer("crowd", 0n, `${Number(nearEach) * opts.size + 5}`);
  const bounds = (await env.provider.callFunction({ contractId: env.tokenId, method: "storage_balance_bounds", args: {} })) as { min: string };
  const creator = env.account(root);
  const deployer = env.account(env.deployerId);
  const id = (c: CrowdAccount) => `${c.name}.${root}`;
  await Promise.all([
    (async () => {
      for (const c of crowd) {
        await creator.createSubAccount({ accountOrPrefix: id(c), publicKey: crowdPublicKey(opts.seed, c.index), nearToTransfer: nearToYocto(nearEach) });
      }
    })(),
    (async () => {
      for (const c of crowd) {
        await deployer.callFunction({ contractId: env.tokenId, methodName: "storage_deposit", args: { account_id: id(c) }, deposit: BigInt(bounds.min) });
        await deployer.callFunction({ contractId: env.tokenId, methodName: "ft_transfer", args: { receiver_id: id(c), amount: c.amount.toString() }, deposit: 1n });
      }
    })(),
  ]);
  return { root, crowd };
}
