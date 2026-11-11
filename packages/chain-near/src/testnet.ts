// Testnet deployment and crowd seeding (roadmap D-05, D-06), as *plans*: a plan reads the chain and
// returns the ordered transactions still missing (`Step[]`), so the same code gives
//   · a dry run: print the steps and the NEAR they would move, signing nothing, and
//   · a resumable, idempotent run: execute the steps; a re-run after a failure (or after success)
//     plans only what is left, because every step is skipped when its effect is already on chain.
// Used by scripts/deploy-testnet.ts and scripts/crowd-seed.ts; the same code runs against a local
// near-sandbox in its test. Keys are passed in by the caller (environment), never written here.
import { ConfigSchema, crowdDistribution, type ContractConfig, type ContractInfo, type CrowdAccount } from "@reorg/core";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { DEFAULT_SUPPLY, TOKEN_DECIMALS, defaultContractConfig, tokenIcon, wasm } from "./artifacts";
import { crowdPublicKey } from "./crowd";

export const NEAR = 10n ** 24n;
/** The token's NEP-145 minimum when the token is not deployed yet (dry run before D-05): 0.00125 NEAR. */
const FALLBACK_STORAGE_MIN = 1_250_000_000_000_000_000_000n;
/** Gas allowance per transaction for the budget (burnt gas is 7–14 Tgas ≈ 0.001 NEAR; a deploy costs more). */
const TX_GAS_NEAR = (3n * NEAR) / 1000n;
const DEPLOY_GAS_NEAR = (10n * NEAR) / 1000n;

/** `1.5` → yoctoNEAR. Exact decimal parsing, no floats. */
export function parseNear(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!m) throw new Error(`not an amount of NEAR: "${text}"`);
  return BigInt(m[1]!) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}

export function formatNear(yocto: bigint, digits = 4): string {
  const scale = 10n ** BigInt(24 - digits);
  const rounded = (yocto + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(digits);
  const frac = (rounded % 10n ** BigInt(digits)).toString().padStart(digits, "0");
  return `${whole}.${frac}`;
}

// ------------------------------------------------------------------ reading the chain

/** What a plan needs to know about the chain. `null` always means "not there yet". */
export interface ChainReader {
  /** Balance in yoctoNEAR, or null if the account does not exist. */
  accountBalance(accountId: string): Promise<bigint | null>;
  hasCode(accountId: string): Promise<boolean>;
  hasKey(accountId: string, publicKey: string): Promise<boolean>;
  /** A view call; null if the contract has no code, is not initialized or lacks the method (or the result is JSON null). */
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T | null>;
}

const MISSING_ACCOUNT = /does not exist|UnknownAccount|AccountDoesNotExist/i;
const NOT_INITIALIZED = /not initialized|panicked|MethodNotFound|MethodResolveError|CodeDoesNotExist|no contract code|does not exist|ContractExecutionError|CompilationError/i;
const describe = (e: unknown) => `${(e as { type?: string }).type ?? ""} ${e instanceof Error ? e.message : String(e)}`;

export class NearChainReader implements ChainReader {
  readonly provider: JsonRpcProvider;

  constructor(opts: { rpcUrl: string; rpcHeaders?: Record<string, string> }) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl, ...(opts.rpcHeaders ? { headers: opts.rpcHeaders } : {}) }, { retries: 3, wait: 500, backoff: 2 });
  }

  async accountBalance(accountId: string): Promise<bigint | null> {
    try {
      return BigInt((await this.provider.viewAccount({ accountId })).amount);
    } catch (e) {
      if (MISSING_ACCOUNT.test(describe(e))) return null;
      throw e; // a network problem must not look like "the account is missing"
    }
  }

  async hasCode(accountId: string): Promise<boolean> {
    try {
      const { code_hash } = await this.provider.viewAccount({ accountId });
      return !/^1+$/.test(code_hash); // 32 zero bytes in base58 is "1111…"
    } catch (e) {
      if (MISSING_ACCOUNT.test(describe(e))) return false;
      throw e;
    }
  }

  async hasKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      return (await this.provider.viewAccessKeyList({ accountId })).keys.some((k) => k.public_key === publicKey);
    } catch (e) {
      if (MISSING_ACCOUNT.test(describe(e))) return false;
      throw e;
    }
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!(await this.hasCode(contractId))) return null;
    try {
      return ((await this.provider.callFunction({ contractId, method, args })) ?? null) as T | null;
    } catch (e) {
      if (NOT_INITIALIZED.test(describe(e))) return null;
      throw e;
    }
  }
}

// ------------------------------------------------------------------ steps

export interface Step {
  /** Who signs (an account id). */
  signer: string;
  label: string;
  /** NEAR (yocto) that leaves the signer's balance with this transaction. */
  attached: bigint;
  /** Allowance for the gas this transaction burns (yocto), for the budget only. */
  gas: bigint;
  run(): Promise<void>;
}

export interface Plan {
  steps: Step[];
  /** Things to know before signing: shortfalls, mismatches that are only warnings. */
  warnings: string[];
}

/** Throws if a transaction response (create account, deploy, add key) carries a failure status. */
function ok(res: unknown, what: string): void {
  const status = (res as { status?: unknown } | null)?.status;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(`${what} failed on chain: ${JSON.stringify((status as { Failure: unknown }).Failure)}`);
  }
}

export interface Totals {
  transactions: number;
  /** yoctoNEAR leaving each signer, attached deposits only. */
  attachedBySigner: Map<string, bigint>;
  attached: bigint;
  gas: bigint;
}

export function totals(steps: readonly Step[]): Totals {
  const attachedBySigner = new Map<string, bigint>();
  let attached = 0n;
  let gas = 0n;
  for (const s of steps) {
    attachedBySigner.set(s.signer, (attachedBySigner.get(s.signer) ?? 0n) + s.attached);
    attached += s.attached;
    gas += s.gas;
  }
  return { transactions: steps.length, attachedBySigner, attached, gas };
}

/** The dry-run report: every planned transaction, then what it costs and who pays. */
export function formatPlan(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.steps.length === 0) out.push("Nothing to do: everything is already on chain.");
  plan.steps.forEach((s, i) => {
    const near = s.attached > 1n ? `${formatNear(s.attached).padStart(10)} NEAR` : " ".repeat(15);
    out.push(`${String(i + 1).padStart(3)}. ${s.signer.padEnd(34)} ${near}  ${s.label}`);
  });
  const t = totals(plan.steps);
  if (plan.steps.length > 0) {
    out.push("", `${t.transactions} transactions. NEAR that moves out of the signers (deposits):`);
    for (const [signer, amount] of t.attachedBySigner) if (amount > 1n) out.push(`  ${signer.padEnd(34)} ${formatNear(amount).padStart(10)} NEAR`);
    out.push(
      `  total deposits ${formatNear(t.attached)} NEAR + gas allowance ≈ ${formatNear(t.gas)} NEAR = ≈ ${formatNear(t.attached + t.gas)} NEAR`,
      "  (deposits stay in the accounts we create; only gas is spent)",
    );
  }
  for (const w of plan.warnings) out.push("", `WARNING: ${w}`);
  return out;
}

/** Runs the steps in order. A failure stops the run; re-running the same command resumes. */
export async function runSteps(steps: readonly Step[], log: (msg: string) => void = console.log): Promise<void> {
  for (const [i, s] of steps.entries()) {
    log(`[${i + 1}/${steps.length}] ${s.signer}: ${s.label}`);
    try {
      await s.run();
    } catch (e) {
      throw new Error(`step ${i + 1}/${steps.length} (${s.label}) failed: ${e instanceof Error ? e.message : String(e)}\nRe-run the same command to resume: finished steps are skipped.`, { cause: e });
    }
  }
}

// ------------------------------------------------------------------ D-05: deploy

export interface TestnetNames {
  root: string;
  token: string;
  contract: string;
  boss: string;
  /** Owner of the token supply, contract owner, income bot, dumper's market and demo faucet (excluded from the company). */
  deployer: string;
}

export function accountNames(rootId: string): TestnetNames {
  return { root: rootId, token: `token.${rootId}`, contract: `reorg.${rootId}`, boss: `boss.${rootId}`, deployer: `deployer.${rootId}` };
}

/** NEAR each account is created with; the contract account's balance is also the treasury and the storage float. */
export interface DeployFunding {
  token: bigint;
  contract: bigint;
  boss: bigint;
  deployer: bigint;
}

/** ROADMAP §8.4: stake ≈ 1.9 (token) and 2.9 (contract) NEAR, plus floats for storage, gas and the income bot. */
export const DEFAULT_DEPLOY_FUNDING: DeployFunding = { token: 4n * NEAR, contract: 10n * NEAR, boss: 3n * NEAR, deployer: 20n * NEAR };

export interface DeployOptions {
  reader: ChainReader;
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  rootId: string;
  /** The root account's key. Also signs for `token.<root>` and `reorg.<root>`, which are created with its public key. */
  rootKey: KeyPairString;
  /** Fresh keys for the accounts that run unattended; `faucet` is a second key on the deployer so the boss's faucet never races the income bot's nonces. */
  keys: { boss: KeyPairString; deployer: KeyPairString; faucet: KeyPairString };
  funding?: DeployFunding;
  /** Overrides for protocol/config.default.json (e.g. from CONTRACT_CONFIG_PATH). */
  config?: Partial<ContractConfig>;
  supply?: bigint;
}

const pub = (key: string) => KeyPair.fromString(key as KeyPairString).getPublicKey().toString();

/** The contract config a deploy would write: defaults, overrides, and the accounts that are never employees. */
export function deployConfig(names: TestnetNames, overrides: Partial<ContractConfig> = {}): ContractConfig {
  return ConfigSchema.parse({
    ...defaultContractConfig(),
    ...overrides,
    excluded_accounts: [...new Set([names.deployer, names.contract, names.token, ...(overrides.excluded_accounts ?? [])])],
  });
}

export async function planDeploy(o: DeployOptions): Promise<Plan> {
  const n = accountNames(o.rootId);
  const funding = o.funding ?? DEFAULT_DEPLOY_FUNDING;
  const supply = o.supply ?? DEFAULT_SUPPLY;
  const provider = new JsonRpcProvider({ url: o.rpcUrl, ...(o.rpcHeaders ? { headers: o.rpcHeaders } : {}) }, { retries: 3, wait: 500, backoff: 2 });
  const as = (id: string, key: KeyPairString) => new Account(id, provider, key);
  const steps: Step[] = [];
  const warnings: string[] = [];
  const rootPub = pub(o.rootKey);

  const rootBalance = await o.reader.accountBalance(n.root);
  if (rootBalance === null) throw new Error(`root account ${n.root} does not exist on this network: create it first (you own it)`);
  if (!(await o.reader.hasKey(n.root, rootPub))) throw new Error(`ROOT_PRIVATE_KEY is not a key of ${n.root}`);

  /** Plans the creation of `id` unless it exists (then its key must be ours). Returns whether it exists already. */
  const account = async (id: string, key: KeyPairString, near: bigint): Promise<boolean> => {
    if ((await o.reader.accountBalance(id)) !== null) {
      if (!(await o.reader.hasKey(id, pub(key)))) throw new Error(`${id} already exists but we hold no key for it`);
      return true;
    }
    steps.push({
      signer: n.root,
      label: `create ${id}`,
      attached: near,
      gas: TX_GAS_NEAR,
      async run() {
        ok(await as(n.root, o.rootKey).createSubAccount({ accountOrPrefix: id, publicKey: pub(key), nearToTransfer: near }), `create ${id}`);
      },
    });
    return false;
  };

  const tokenExists = await account(n.token, o.rootKey, funding.token);
  const contractExists = await account(n.contract, o.rootKey, funding.contract);
  await account(n.boss, o.keys.boss, funding.boss);
  const deployerExists = await account(n.deployer, o.keys.deployer, funding.deployer);

  // The faucet's own key on the deployer.
  if (!deployerExists || !(await o.reader.hasKey(n.deployer, pub(o.keys.faucet)))) {
    steps.push({
      signer: n.deployer,
      label: "add the faucet access key",
      attached: 0n,
      gas: TX_GAS_NEAR,
      async run() {
        ok(await as(n.deployer, o.keys.deployer).addFullAccessKey(KeyPair.fromString(o.keys.faucet).getPublicKey()), "add the faucet key");
      },
    });
  }

  // Token: code, then `new`.
  const token = wasm("reorg_token");
  if (!(tokenExists && (await o.reader.hasCode(n.token)))) {
    steps.push({
      signer: n.token,
      label: `deploy reorg_token.wasm (${Math.round(token.length / 1024)} KB)`,
      attached: 0n,
      gas: DEPLOY_GAS_NEAR,
      async run() {
        ok(await as(n.token, o.rootKey).deployContract(token), "deploy the token");
      },
    });
  }
  if (!(tokenExists && (await o.reader.view<string>(n.token, "ft_total_supply")) !== null)) {
    const icon = tokenIcon();
    steps.push({
      signer: n.token,
      label: `init the token: owner ${n.deployer}, supply ${supply / 10n ** TOKEN_DECIMALS} REORG`,
      attached: 0n,
      gas: TX_GAS_NEAR,
      async run() {
        await as(n.token, o.rootKey).callFunction({
          contractId: n.token,
          methodName: "new",
          args: { owner_id: n.deployer, total_supply: supply.toString(), metadata: { spec: "ft-1.0.0", name: "REORG", symbol: "REORG", decimals: Number(TOKEN_DECIMALS), ...(icon ? { icon } : {}) } },
        });
      },
    });
  }

  // Contract: code, then `new` with the config.
  const reorg = wasm("reorg_contract");
  const config = deployConfig(n, o.config);
  if (!(contractExists && (await o.reader.hasCode(n.contract)))) {
    steps.push({
      signer: n.contract,
      label: `deploy reorg_contract.wasm (${Math.round(reorg.length / 1024)} KB)`,
      attached: 0n,
      gas: DEPLOY_GAS_NEAR,
      async run() {
        ok(await as(n.contract, o.rootKey).deployContract(reorg), "deploy the contract");
      },
    });
  }
  const info = contractExists ? await o.reader.view<ContractInfo>(n.contract, "get_info") : null;
  if (info) {
    // Already initialized: it must be ours, or every later step would talk to someone else's game.
    for (const [field, want] of [["owner", n.deployer], ["boss", n.boss], ["token", n.token]] as const) {
      if (info[field] !== want) throw new Error(`${n.contract} is initialized with ${field} = ${info[field]}, expected ${want}`);
    }
  } else {
    steps.push({
      signer: n.contract,
      label: `init the contract: boss ${n.boss}, token ${n.token}, default config`,
      attached: 0n,
      gas: TX_GAS_NEAR,
      async run() {
        await as(n.contract, o.rootKey).callFunction({
          contractId: n.contract,
          methodName: "new",
          args: { config, token: n.token, boss: n.boss, total_supply: supply.toString(), owner: n.deployer },
        });
      },
    });
  }

  const t = totals(steps);
  const need = (t.attachedBySigner.get(n.root) ?? 0n) + t.gas;
  if (rootBalance < need) warnings.push(`${n.root} holds ${formatNear(rootBalance)} NEAR but this plan needs ≈ ${formatNear(need)} NEAR`);
  return { steps, warnings };
}

// ------------------------------------------------------------------ D-06: crowd seeding

export interface CrowdSeedOptions {
  reader: ChainReader;
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  /** Crowd accounts are `<name>.<crowdRoot>`; it signs their creation and pays their NEAR. */
  crowdRoot: string;
  crowdRootKey: KeyPairString;
  /** Holds the token supply; registers the crowd with the token and sends their shares. */
  deployerId: string;
  deployerKey: KeyPairString;
  tokenId: string;
  contractId: string;
  seed: string;
  size: number;
  /** yoctoNEAR each account is created with (gas for its submits and claims). */
  nearEach: bigint;
}

export interface CrowdSeedPlan extends Plan {
  /** The whole crowd as distributed (D13), whether or not each account still needs funding. */
  crowd: CrowdAccount[];
  supply: bigint;
}

export async function planCrowdSeed(o: CrowdSeedOptions): Promise<CrowdSeedPlan> {
  const provider = new JsonRpcProvider({ url: o.rpcUrl, ...(o.rpcHeaders ? { headers: o.rpcHeaders } : {}) }, { retries: 3, wait: 500, backoff: 2 });
  const as = (id: string, key: KeyPairString) => new Account(id, provider, key);
  const steps: Step[] = [];
  const warnings: string[] = [];

  // Before D-05 has run there is no token to ask: plan against the defaults.
  const supply = BigInt((await o.reader.view<string>(o.tokenId, "ft_total_supply")) ?? DEFAULT_SUPPLY);
  const config = ConfigSchema.parse((await o.reader.view<unknown>(o.contractId, "get_config")) ?? defaultContractConfig());
  const storageMin = BigInt((await o.reader.view<{ min: string }>(o.tokenId, "storage_balance_bounds"))?.min ?? FALLBACK_STORAGE_MIN);
  const crowd = crowdDistribution(o.size, supply, config.tier_thresholds_ppm);

  const rootBalance = await o.reader.accountBalance(o.crowdRoot);
  if (rootBalance === null) throw new Error(`crowd root ${o.crowdRoot} does not exist`);
  if ((await o.reader.accountBalance(o.deployerId)) === null) warnings.push(`${o.deployerId} does not exist yet: run the deploy (D-05) before seeding`);

  let tokensToSend = 0n;
  for (const c of crowd) {
    const id = `${c.name}.${o.crowdRoot}`;
    const key = crowdPublicKey(o.seed, c.index);
    if ((await o.reader.accountBalance(id)) === null) {
      steps.push({
        signer: o.crowdRoot,
        label: `create ${id} (${c.role})`,
        attached: o.nearEach,
        gas: TX_GAS_NEAR,
        async run() {
          ok(await as(o.crowdRoot, o.crowdRootKey).createSubAccount({ accountOrPrefix: id, publicKey: key, nearToTransfer: o.nearEach }), `create ${id}`);
        },
      });
    } else if (!(await o.reader.hasKey(id, key))) {
      throw new Error(`${id} exists but is not derived from this CROWD_SEED`);
    }
    // Registered with the token? (NEP-145: storage_balance_of is null if not.)
    if ((await o.reader.view<unknown>(o.tokenId, "storage_balance_of", { account_id: id })) === null) {
      steps.push({
        signer: o.deployerId,
        label: `register ${id} with the token (storage deposit ${formatNear(storageMin, 5)} NEAR)`,
        attached: storageMin,
        gas: TX_GAS_NEAR,
        async run() {
          await as(o.deployerId, o.deployerKey).callFunction({ contractId: o.tokenId, methodName: "storage_deposit", args: { account_id: id }, deposit: storageMin });
        },
      });
    }
    // Its share, only if it holds nothing: a balance that moved later (the dumper's sales, claims) is never topped up.
    if (BigInt((await o.reader.view<string>(o.tokenId, "ft_balance_of", { account_id: id })) ?? "0") === 0n) {
      tokensToSend += c.amount;
      steps.push({
        signer: o.deployerId,
        label: `send ${id} ${c.amount / 10n ** TOKEN_DECIMALS} REORG (${c.role})`,
        attached: 1n,
        gas: TX_GAS_NEAR,
        async run() {
          await as(o.deployerId, o.deployerKey).callFunction({
            contractId: o.tokenId,
            methodName: "ft_transfer",
            args: { receiver_id: id, amount: c.amount.toString() },
            deposit: 1n,
          });
        },
      });
    }
  }

  const t = totals(steps);
  const rootNeeds = (t.attachedBySigner.get(o.crowdRoot) ?? 0n) + t.gas;
  if (rootBalance < rootNeeds) warnings.push(`${o.crowdRoot} holds ${formatNear(rootBalance)} NEAR but the creations need ≈ ${formatNear(rootNeeds)} NEAR`);
  const deployerNear = await o.reader.accountBalance(o.deployerId);
  const deployerNeeds = t.attachedBySigner.get(o.deployerId) ?? 0n;
  if (deployerNear !== null && deployerNear < deployerNeeds) warnings.push(`${o.deployerId} holds ${formatNear(deployerNear)} NEAR but the registrations need ≈ ${formatNear(deployerNeeds)} NEAR`);
  const deployerTokens = await o.reader.view<string>(o.tokenId, "ft_balance_of", { account_id: o.deployerId });
  if (deployerTokens !== null && BigInt(deployerTokens) < tokensToSend) warnings.push(`${o.deployerId} holds ${BigInt(deployerTokens) / 10n ** TOKEN_DECIMALS} REORG but ${tokensToSend / 10n ** TOKEN_DECIMALS} still have to be sent`);
  return { steps, warnings, crowd, supply };
}

/** The crowd as a table for the dry run (D13: who holds what, and at which tier). */
export function formatCrowd(crowd: readonly CrowdAccount[], root: string, supply: bigint): string[] {
  return crowd.map((c) => {
    const pct = Number((c.amount * 1_000_000n) / supply) / 10_000;
    return `  ${`${c.name}.${root}`.padEnd(36)} ${c.role.padEnd(9)} ${(c.amount / 10n ** TOKEN_DECIMALS).toString().padStart(12)} REORG  ${pct.toFixed(4).padStart(8)} %`;
  });
}
