// The simulated crowd on NEAR (roadmap D-02, D-06, D-08) behind the chain-agnostic `CrowdSigner`
// and `DemoOperator` (packages/core/src/chain.ts). Crowd keys derive from CROWD_SEED at runtime
// and are never written to disk; the operator key comes from the environment.
import {
  REORG_METHODS,
  sha256Bytes,
  type ClaimOutcome,
  type CrowdSigner,
  type DemoOperator,
  type IncomeTag,
  type SubmitOutcome,
  type TaskId,
  type WalletId,
} from "@reorg/core";
import { Account, baseEncode, JsonRpcProvider, KeyPair, KeyPairEd25519, type KeyPairString } from "near-api-js";
import { PLAYER_GAS } from "./wallets";

/** ed25519 key of crowd member `index`: seed = sha256("reorg-crowd-key|<seed>|<index>"). */
export function crowdKey(seed: string, index: number): KeyPairString {
  if (!seed) throw new Error("CROWD_SEED is empty");
  const secret = sha256Bytes(new TextEncoder().encode(`reorg-crowd-key|${seed}|${index}`));
  const pub = new KeyPairEd25519(baseEncode(new Uint8Array([...secret, ...new Uint8Array(32)]))).getPublicKey().data;
  return `ed25519:${baseEncode(new Uint8Array([...secret, ...pub]))}`;
}

/** Public key (`ed25519:…`) for `crowdKey(seed, index)`. */
export function crowdPublicKey(seed: string, index: number): string {
  return KeyPair.fromString(crowdKey(seed, index)).getPublicKey().toString();
}

/**
 * Runs one account's transactions one at a time: nonces are per access key, so two transactions
 * signed in parallel with the same key can collide ("Invalid nonce").
 */
class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const provider = (rpcUrl: string, headers?: Record<string, string>) =>
  new JsonRpcProvider({ url: rpcUrl, ...(headers ? { headers } : {}) }, { retries: 3, wait: 500, backoff: 2 });

export interface NearCrowdOptions {
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  contractId: string;
  tokenId: string;
  /** Crowd accounts are `<name>.<root>`. */
  root: string;
  /** Account name prefix per index (`c001`, …), from `crowdDistribution`. */
  names: readonly string[];
  seed: string;
}

export class NearCrowdSigner implements CrowdSigner {
  private readonly provider: JsonRpcProvider;
  private readonly accounts = new Map<number, { account: Account; lane: Lane }>();

  constructor(private readonly opts: NearCrowdOptions) {
    this.provider = provider(opts.rpcUrl, opts.rpcHeaders);
  }

  accountId(index: number): WalletId {
    const name = this.opts.names[index];
    if (name === undefined) throw new Error(`no crowd member ${index}`);
    return `${name}.${this.opts.root}`;
  }

  /** Signs as member `index`, one transaction at a time. */
  private as<T>(index: number, fn: (a: Account) => Promise<T>): Promise<T> {
    let m = this.accounts.get(index);
    if (!m) {
      m = { account: new Account(this.accountId(index), this.provider, crowdKey(this.opts.seed, index)), lane: new Lane() };
      this.accounts.set(index, m);
    }
    const { account, lane } = m;
    return lane.run(() => fn(account));
  }

  async submit(index: number, taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome> {
    const args = { task_id: taskId, answer_hash: answerHashB64 };
    return (await this.as(index, (a) => a.callFunction({ contractId: this.opts.contractId, methodName: REORG_METHODS.submit, args, gas: PLAYER_GAS }))) as SubmitOutcome;
  }

  async claimSalary(index: number, taskId: TaskId): Promise<ClaimOutcome> {
    const args = { task_id: taskId };
    return (await this.as(index, (a) => a.callFunction({ contractId: this.opts.contractId, methodName: REORG_METHODS.claimSalary, args, gas: PLAYER_GAS }))) as ClaimOutcome;
  }

  async sendTokens(index: number, to: WalletId, amount: bigint): Promise<void> {
    const args = { receiver_id: to, amount: amount.toString() };
    await this.as(index, (a) => a.callFunction({ contractId: this.opts.tokenId, methodName: "ft_transfer", args, deposit: 1n }));
  }
}

export interface NearOperatorOptions {
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  contractId: string;
  tokenId: string;
  accountId: string;
  /** `ed25519:…`, read from the environment by the caller. */
  key: string;
}

export class NearDemoOperator implements DemoOperator {
  readonly accountId: WalletId;
  private readonly account: Account;
  private readonly lane = new Lane();

  constructor(private readonly opts: NearOperatorOptions) {
    this.accountId = opts.accountId;
    this.account = new Account(opts.accountId, provider(opts.rpcUrl, opts.rpcHeaders), opts.key as KeyPairString);
  }

  async depositIncome(amount: bigint, tag: IncomeTag): Promise<void> {
    await this.lane.run(() =>
      this.account.callFunction({ contractId: this.opts.contractId, methodName: REORG_METHODS.depositIncome, args: { tag }, deposit: amount }),
    );
  }

  async sendTokens(to: WalletId, amount: bigint): Promise<void> {
    const args = { receiver_id: to, amount: amount.toString() };
    await this.lane.run(() => this.account.callFunction({ contractId: this.opts.tokenId, methodName: "ft_transfer", args, deposit: 1n }));
  }
}
