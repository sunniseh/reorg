// Player wallets (roadmap W-11) behind the chain-agnostic WalletAdapter (packages/core/src/chain.ts).
//
// - BurnerWallet: the demo player. A throwaway ed25519 key kept in this browser's localStorage;
//   the boss service's demo faucet (D-09) creates and funds an account for it. Demo mode only.
// - NearConnectWallet: a real NEAR wallet through NEAR Connect (@hot-labs/near-connect, the
//   successor of wallet-selector). Loaded on demand so the burner path never pulls it in.
import {
  REORG_METHODS,
  type ClaimOutcome,
  type FaucetGrant,
  type SubmitOutcome,
  type TaskId,
  type WalletAdapter,
  type WalletId,
} from "@reorg/core";
import { Account, JsonRpcProvider, KeyPair, getTransactionLastResult, teraToGas, type FinalExecutionOutcome, type KeyPairString } from "near-api-js";

/** submit + its balance callback burn ~7 Tgas, claim ~10 Tgas (contracts/README.md); 100 leaves headroom. */
export const PLAYER_GAS = teraToGas("100");

/** The part of `Storage` the burner uses (localStorage in browsers; a Map in tests). */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BurnerOptions {
  rpcUrl: string;
  contractId: string;
  /** Boss service base URL; the faucet is `POST <bossUrl>/api/faucet`. */
  bossUrl: string;
  network: string;
  store?: KeyStore;
  fetch?: typeof fetch;
}

interface BurnerRecord {
  account_id: WalletId;
  key: KeyPairString;
}

/** Turns a failed transaction into an Error that keeps the contract's reason string. */
function reasonOf(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /Smart contract panicked: ([^"\n]+)/.exec(msg) ?? /panicked at[^:]*: ([^"\n]+)/.exec(msg);
  return new Error(m ? m[1]!.trim() : msg);
}

export class BurnerWallet implements WalletAdapter {
  readonly label = "Demo player";
  readonly burner = true;
  private record: BurnerRecord | null = null;
  private readonly provider: JsonRpcProvider;
  private readonly store: KeyStore;
  private readonly storeKey: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: BurnerOptions) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl });
    this.store = opts.store ?? globalThis.localStorage;
    this.storeKey = `reorg.burner.${opts.network}.${opts.contractId}`;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  accountId(): WalletId | null {
    return this.record?.account_id ?? null;
  }

  async restore(): Promise<WalletId | null> {
    const raw = this.store.getItem(this.storeKey);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as BurnerRecord;
      // A local chain restarts empty: drop a burner whose account no longer exists.
      await this.provider.viewAccount({ accountId: rec.account_id });
      this.record = rec;
      return rec.account_id;
    } catch (e) {
      // Forget the key only when the chain says the account is gone (a restarted local chain);
      // a network error or rate limit must never cost the player their funded desk.
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(msg)) this.store.removeItem(this.storeKey);
      return null;
    }
  }

  private connecting: Promise<WalletId> | null = null;

  connect(): Promise<WalletId> {
    // One faucet request at a time, however often the button is pressed.
    this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect(): Promise<WalletId> {
    if (this.record || (await this.restore())) return this.record!.account_id;
    const key = KeyPair.fromRandom("ed25519");
    const res = await this.doFetch(`${this.opts.bossUrl.replace(/\/$/, "")}/api/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: key.getPublicKey().toString() }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FaucetGrant> & { error?: string };
    if (!res.ok || !body.account_id) throw new Error(body.error ?? `faucet failed (${res.status})`);
    this.record = { account_id: body.account_id, key: key.toString() as KeyPairString };
    try {
      this.store.setItem(this.storeKey, JSON.stringify(this.record));
    } catch {
      /* storage unavailable (private mode): the burner lasts for this page only */
    }
    return body.account_id;
  }

  async disconnect(): Promise<void> {
    // The key stays in this browser so badging in again returns to the same desk.
    this.record = null;
  }

  /** Forgets the burner for good (a fresh demo player next time). */
  forget(): void {
    this.record = null;
    this.store.removeItem(this.storeKey);
  }

  private account(): Account {
    if (!this.record) throw new Error("not connected");
    return new Account(this.record.account_id, this.provider, this.record.key);
  }

  async submit(taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome> {
    try {
      return (await this.account().callFunction({
        contractId: this.opts.contractId,
        methodName: REORG_METHODS.submit,
        args: { task_id: taskId, answer_hash: answerHashB64 },
        gas: PLAYER_GAS,
      })) as SubmitOutcome;
    } catch (e) {
      throw reasonOf(e);
    }
  }

  async claimSalary(taskId: TaskId): Promise<ClaimOutcome> {
    try {
      return (await this.account().callFunction({
        contractId: this.opts.contractId,
        methodName: REORG_METHODS.claimSalary,
        args: { task_id: taskId },
        gas: PLAYER_GAS,
      })) as ClaimOutcome;
    } catch (e) {
      throw reasonOf(e);
    }
  }

  async provePass(taskId: TaskId): Promise<string> {
    try {
      return String(
        await this.account().callFunction({ contractId: this.opts.contractId, methodName: REORG_METHODS.provePass, args: { task_id: taskId }, gas: PLAYER_GAS }),
      );
    } catch (e) {
      throw reasonOf(e);
    }
  }
}

export interface NearConnectOptions {
  contractId: string;
  network: "testnet" | "mainnet";
}

type Connector = import("@hot-labs/near-connect").NearConnector;
type ConnectorWallet = Awaited<ReturnType<Connector["wallet"]>>;

/** A real NEAR wallet via NEAR Connect. Testnet only in this repo (never mainnet, CLAUDE.md). */
export class NearConnectWallet implements WalletAdapter {
  readonly label = "NEAR wallet";
  readonly burner = false;
  private connector: Connector | null = null;
  private wallet: ConnectorWallet | null = null;
  private account: WalletId | null = null;

  constructor(private readonly opts: NearConnectOptions) {}

  private async load(): Promise<Connector> {
    if (!this.connector) {
      const { NearConnector } = await import("@hot-labs/near-connect");
      this.connector = new NearConnector({ network: this.opts.network });
      this.connector.on("wallet:signOut", () => {
        this.wallet = null;
        this.account = null;
      });
    }
    return this.connector;
  }

  accountId(): WalletId | null {
    return this.account;
  }

  async restore(): Promise<WalletId | null> {
    try {
      const c = await this.load();
      const { wallet, accounts } = await c.getConnectedWallet();
      this.wallet = wallet;
      this.account = accounts[0]?.accountId ?? null;
      return this.account;
    } catch {
      return null;
    }
  }

  async connect(): Promise<WalletId> {
    const c = await this.load();
    this.wallet = await c.connect();
    const accounts = await this.wallet.getAccounts();
    this.account = accounts[0]?.accountId ?? null;
    if (!this.account) throw new Error("the wallet returned no account");
    return this.account;
  }

  async disconnect(): Promise<void> {
    if (this.connector && this.wallet) await this.connector.disconnect(this.wallet);
    this.wallet = null;
    this.account = null;
  }

  private async call<T>(methodName: string, args: object): Promise<T> {
    if (!this.wallet || !this.account) throw new Error("not connected");
    try {
      const outcome = await this.wallet.signAndSendTransaction({
        signerId: this.account,
        receiverId: this.opts.contractId,
        actions: [{ type: "FunctionCall", params: { methodName, args, gas: PLAYER_GAS.toString(), deposit: "0" } }],
      });
      return getTransactionLastResult(outcome as unknown as FinalExecutionOutcome) as T;
    } catch (e) {
      throw reasonOf(e);
    }
  }

  submit(taskId: TaskId, answerHashB64: string): Promise<SubmitOutcome> {
    return this.call(REORG_METHODS.submit, { task_id: taskId, answer_hash: answerHashB64 });
  }

  claimSalary(taskId: TaskId): Promise<ClaimOutcome> {
    return this.call(REORG_METHODS.claimSalary, { task_id: taskId });
  }

  async provePass(taskId: TaskId): Promise<string> {
    return String(await this.call(REORG_METHODS.provePass, { task_id: taskId }));
  }
}
