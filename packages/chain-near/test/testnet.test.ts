// D-05 / D-06 plans. The unit tests run against an in-memory chain and sign nothing. The sandbox test
// (REORG_SANDBOX=1) runs the same plans for real on a local near-sandbox: dry run changes nothing,
// the run deploys and seeds, and a second plan is empty (idempotent, resumable).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPair, type KeyPairString } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { crowdPublicKey } from "../src/crowd";
import {
  NEAR,
  NearChainReader,
  accountNames,
  deployConfig,
  formatNear,
  formatPlan,
  parseNear,
  planCrowdSeed,
  planDeploy,
  runSteps,
  totals,
  type ChainReader,
  type DeployOptions,
} from "../src/node";

const key = () => KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const pubOf = (k: string) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString();

/** An in-memory chain: which accounts exist (with keys), which have code, and canned view results. */
class FakeChain implements ChainReader {
  accounts = new Map<string, { balance: bigint; keys: Set<string>; code: boolean }>();
  views = new Map<string, unknown>();
  add(id: string, k: string | null, balance = 100n * NEAR, code = false): this {
    this.accounts.set(id, { balance, keys: new Set(k ? [pubOf(k)] : []), code });
    return this;
  }
  async accountBalance(id: string) {
    return this.accounts.get(id)?.balance ?? null;
  }
  async hasCode(id: string) {
    return this.accounts.get(id)?.code ?? false;
  }
  async hasKey(id: string, publicKey: string) {
    return this.accounts.get(id)?.keys.has(publicKey) ?? false;
  }
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}) {
    const v = this.views.get(`${contractId}.${method}.${JSON.stringify(args)}`) ?? this.views.get(`${contractId}.${method}`);
    return (v ?? null) as T | null;
  }
}

const ROOT = "reorg-demo.testnet";
const rootKey = key();
const keys = { boss: key(), deployer: key(), faucet: key() };
const base = (reader: ChainReader): DeployOptions => ({ reader, rpcUrl: "http://127.0.0.1:1", rootId: ROOT, rootKey, keys });
const n = accountNames(ROOT);

describe("amounts", () => {
  it("parses and formats NEAR exactly", () => {
    expect(parseNear("1.5")).toBe((15n * NEAR) / 10n);
    expect(parseNear("0.000000000000000000000001")).toBe(1n);
    expect(() => parseNear("1e3")).toThrow();
    expect(() => parseNear("-1")).toThrow();
    expect(formatNear(1_234_567_000_000_000_000_000_000n)).toBe("1.2346");
  });
});

describe("planDeploy", () => {
  it("plans accounts, key, token and contract in order, and the root pays the funding", async () => {
    const chain = new FakeChain().add(ROOT, rootKey);
    const plan = await planDeploy(base(chain));
    expect(plan.steps.map((s) => s.label.split(" ").slice(0, 2).join(" "))).toEqual([
      `create ${n.token}`,
      `create ${n.contract}`,
      `create ${n.boss}`,
      `create ${n.deployer}`,
      "add the",
      "deploy reorg_token.wasm",
      "init the",
      "deploy reorg_contract.wasm",
      "init the",
    ]);
    expect(totals(plan.steps).attachedBySigner.get(ROOT)).toBe(37n * NEAR);
    expect(plan.warnings).toEqual([]);
    expect(formatPlan(plan).join("\n")).toContain("9 transactions");
  });

  it("warns when the root cannot pay", async () => {
    const chain = new FakeChain().add(ROOT, rootKey, 5n * NEAR);
    expect((await planDeploy(base(chain))).warnings[0]).toMatch(/holds 5\.0000 NEAR/);
  });

  it("plans nothing once everything is deployed and initialized", async () => {
    const chain = new FakeChain().add(ROOT, rootKey);
    chain.add(n.token, rootKey, 4n * NEAR, true).add(n.contract, rootKey, 10n * NEAR, true).add(n.boss, keys.boss).add(n.deployer, keys.deployer);
    chain.accounts.get(n.deployer)!.keys.add(pubOf(keys.faucet));
    chain.views.set(`${n.token}.ft_total_supply`, "1");
    chain.views.set(`${n.contract}.get_info`, { owner: n.deployer, boss: n.boss, token: n.token });
    expect((await planDeploy(base(chain))).steps).toEqual([]);
  });

  it("resumes: only the missing steps are planned after a partial run", async () => {
    const chain = new FakeChain().add(ROOT, rootKey);
    chain.add(n.token, rootKey, 4n * NEAR, true).add(n.contract, rootKey).add(n.boss, keys.boss).add(n.deployer, keys.deployer);
    const labels = (await planDeploy(base(chain))).steps.map((s) => s.label);
    expect(labels).toEqual(["add the faucet access key", expect.stringMatching(/^init the token/), expect.stringMatching(/^deploy reorg_contract/), expect.stringMatching(/^init the contract/)]);
  });

  it("refuses a missing root, a foreign key, and a contract initialized for someone else", async () => {
    await expect(planDeploy(base(new FakeChain()))).rejects.toThrow(/does not exist/);
    await expect(planDeploy(base(new FakeChain().add(ROOT, key())))).rejects.toThrow(/not a key of/);
    const chain = new FakeChain().add(ROOT, rootKey).add(n.token, key()); // exists, but not our key
    await expect(planDeploy(base(chain))).rejects.toThrow(/we hold no key/);
    const other = new FakeChain().add(ROOT, rootKey).add(n.contract, rootKey, 10n * NEAR, true);
    other.views.set(`${n.contract}.get_info`, { owner: n.deployer, boss: "someone.testnet", token: n.token });
    await expect(planDeploy(base(other))).rejects.toThrow(/boss = someone\.testnet/);
  });

  it("excludes the deployer, the contract and the token from the company", () => {
    const c = deployConfig(n, { excluded_accounts: ["lp.testnet"] });
    expect([...c.excluded_accounts].sort()).toEqual([n.contract, n.deployer, n.token, "lp.testnet"].sort());
  });
});

describe("planCrowdSeed", () => {
  const seedOpts = (reader: ChainReader, size = 20) => ({
    reader,
    rpcUrl: "http://127.0.0.1:1",
    crowdRoot: ROOT,
    crowdRootKey: rootKey,
    deployerId: n.deployer,
    deployerKey: keys.deployer,
    tokenId: n.token,
    contractId: n.contract,
    seed: "test-seed",
    size,
    nearEach: parseNear("1"),
  });

  it("before the deploy: create, register and fund every account (dry run needs no token)", async () => {
    const chain = new FakeChain().add(ROOT, rootKey);
    const plan = await planCrowdSeed(seedOpts(chain));
    expect(plan.crowd).toHaveLength(20);
    expect(plan.steps).toHaveLength(60);
    expect(plan.steps[0]!.label).toBe(`create c001.${ROOT} (${plan.crowd[0]!.role})`);
    expect(totals(plan.steps).attachedBySigner.get(ROOT)).toBe(20n * NEAR);
    expect(plan.warnings[0]).toMatch(/does not exist yet/);
  });

  it("skips what is on chain, never tops up a moved balance, and refuses a foreign account", async () => {
    const chain = new FakeChain().add(ROOT, rootKey).add(n.deployer, keys.deployer);
    const first = (await planCrowdSeed(seedOpts(chain))).crowd[0]!;
    const id = `${first.name}.${ROOT}`;
    chain.add(id, null);
    chain.accounts.get(id)!.keys.add(crowdPublicKey("test-seed", 0));
    chain.views.set(`${n.token}.storage_balance_of.${JSON.stringify({ account_id: id })}`, { total: "1", available: "0" });
    chain.views.set(`${n.token}.ft_balance_of.${JSON.stringify({ account_id: id })}`, "5");
    const plan = await planCrowdSeed(seedOpts(chain));
    expect(plan.steps).toHaveLength(57);
    expect(plan.steps.some((s) => s.label.includes(id))).toBe(false);

    chain.accounts.get(id)!.keys = new Set([pubOf(key())]);
    await expect(planCrowdSeed(seedOpts(chain))).rejects.toThrow(/not derived from this CROWD_SEED/);
  });

  it("warns when the deployer lacks the tokens", async () => {
    const chain = new FakeChain().add(ROOT, rootKey).add(n.deployer, keys.deployer);
    chain.views.set(`${n.token}.ft_balance_of.${JSON.stringify({ account_id: n.deployer })}`, "1000");
    expect((await planCrowdSeed(seedOpts(chain))).warnings.join("\n")).toMatch(/REORG but .* still have to be sent/);
  });
});

describe("runSteps", () => {
  it("runs in order and names the failed step so a re-run can resume", async () => {
    const ran: string[] = [];
    const step = (label: string, fail = false) => ({
      signer: "a",
      label,
      attached: 0n,
      gas: 0n,
      async run() {
        if (fail) throw new Error("boom");
        ran.push(label);
      },
    });
    await expect(runSteps([step("one"), step("two", true), step("three")], () => {})).rejects.toThrow(/step 2\/3 \(two\) failed: boom.*Re-run/s);
    expect(ran).toEqual(["one"]);
  });
});

const RUN = process.env["REORG_SANDBOX"] === "1";
describe.skipIf(!RUN)("deploy and seed on near-sandbox", () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await Sandbox.start({});
  }, 240_000);
  afterAll(async () => {
    await sandbox?.tearDown();
  });

  it("dry run changes nothing; the run deploys a working game; a re-plan is empty", async () => {
    const reader = new NearChainReader({ rpcUrl: sandbox.rpcUrl });
    const root = DEFAULT_ACCOUNT_ID;
    const names = accountNames(root);
    const opts: DeployOptions = { reader, rpcUrl: sandbox.rpcUrl, rootId: root, rootKey: DEFAULT_PRIVATE_KEY as KeyPairString, keys: { boss: key(), deployer: key(), faucet: key() } };

    const plan = await planDeploy(opts);
    expect(plan.steps).toHaveLength(9);
    expect(await reader.accountBalance(names.token)).toBeNull(); // planning signed nothing

    await runSteps(plan.steps, () => {});
    const info = await reader.view<{ owner: string; boss: string; token: string }>(names.contract, "get_info");
    expect(info).toMatchObject({ owner: names.deployer, boss: names.boss, token: names.token });
    expect(await reader.hasKey(names.deployer, pubOf(opts.keys.faucet))).toBe(true);
    expect((await planDeploy(opts)).steps).toEqual([]);

    const seedOpts = {
      reader,
      rpcUrl: sandbox.rpcUrl,
      crowdRoot: root,
      crowdRootKey: DEFAULT_PRIVATE_KEY as KeyPairString,
      deployerId: names.deployer,
      deployerKey: opts.keys.deployer,
      tokenId: names.token,
      contractId: names.contract,
      seed: "sandbox-seed",
      size: 20,
      nearEach: parseNear("1"),
    };
    const seed = await planCrowdSeed(seedOpts);
    expect(seed.steps).toHaveLength(60);
    await runSteps(seed.steps.slice(0, 31), () => {}); // interrupted halfway…
    const rest = await planCrowdSeed(seedOpts);
    expect(rest.steps).toHaveLength(29); // …resumes with exactly what is left
    await runSteps(rest.steps, () => {});
    expect((await planCrowdSeed(seedOpts)).steps).toEqual([]);

    const first = seed.crowd[0]!;
    const held = await reader.view<string>(names.token, "ft_balance_of", { account_id: `${first.name}.${root}` });
    expect(BigInt(held!)).toBe(first.amount);
  }, 600_000);
});
