// Local near-sandbox harness: deploys the real token and REORG contract and creates funded
// player accounts. Used by the boss end-to-end test and, later, by `npm run demo` (D-01).
// Throwaway keys only: everything here lives on a local chain that is deleted on tearDown.
import { readFileSync } from "node:fs";
import { ConfigSchema, type ContractConfig, type SubmitOutcome, type TaskId } from "@reorg/core";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";

const REPO = new URL("../../../", import.meta.url);
const TOKEN_DECIMALS = 18n;
export const ONE_TOKEN = 10n ** TOKEN_DECIMALS;
export const DEFAULT_SUPPLY = 1_000_000_000n * ONE_TOKEN;
const USER_GAS = teraToGas("100");

function wasm(name: string): Uint8Array {
  const url = new URL(`contracts/target/near/${name}/${name}.wasm`, REPO);
  try {
    return readFileSync(url);
  } catch {
    throw new Error(`${url.pathname} missing: run \`npm run contracts:build\` first`);
  }
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
  const deployerId = await create("deployer", "100");
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
