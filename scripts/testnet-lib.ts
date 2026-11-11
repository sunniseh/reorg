// Shared by scripts/deploy-testnet.ts and scripts/crowd-seed.ts (roadmap D-05, D-06).
// Secrets come from the environment (`.env.testnet`, gitignored, loaded here without overriding what the
// shell already set). The only secrets these scripts ever write are keys they generate themselves
// (the boss, the income bot / deployer, the faucet, the crowd seed), appended to `.env.testnet`
// with mode 0600 *before* the first transaction that needs them, so a crash cannot lose a key.
// ROOT_PRIVATE_KEY is read, never written. Mainnet is refused.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { KeyPair, type KeyPairString } from "near-api-js";

/** `.env.testnet` in the repo root; `REORG_ENV_FILE` points the scripts at another file (used to smoke-test them on a sandbox). */
export const ENV_FILE = process.env["REORG_ENV_FILE"] || new URL("../.env.testnet", import.meta.url).pathname;

export function loadEnv(): void {
  for (const file of [ENV_FILE, new URL("../.env", import.meta.url).pathname]) if (existsSync(file)) process.loadEnvFile(file);
}

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

/** `--dry-run`, `--yes`, `--name value` and `--name=value`. */
export function parseArgs(argv: readonly string[], valued: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (valued.includes(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      values.set(name, v);
    } else if (inline === undefined) flags.add(name);
    else throw new Error(`--${name} takes no value`);
  }
  return { flags, values };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example; put it in the environment or in .env.testnet)`);
  return v;
}

export function requireKey(name: string): KeyPairString {
  const v = requireEnv(name);
  if (!v.startsWith("ed25519:")) throw new Error(`${name} must be an ed25519:… secret key`);
  return v as KeyPairString;
}

export function rpcHeaders(): Record<string, string> | undefined {
  const key = process.env["NEAR_RPC_API_KEY"];
  return key ? { "x-api-key": key } : undefined;
}

/** Testnet (or, for this repo's own tests, a local sandbox) only. */
export function guardNetwork(rootId: string, rpcUrl: string): void {
  const sandbox = process.env["NETWORK"] === "sandbox";
  if (!sandbox && !rootId.endsWith(".testnet")) throw new Error(`refusing to run: ROOT_ACCOUNT_ID "${rootId}" is not a *.testnet account (this repo never touches mainnet)`);
  if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing to run: NEAR_RPC_URL "${rpcUrl}" looks like mainnet`);
}

/** Returns `NAME` from the environment, or a fresh ed25519 key (recorded in `generated`, saved by the caller on a real run). */
export function keyFromEnvOrNew(name: string, generated: Record<string, string>): KeyPairString {
  const v = process.env[name];
  if (v) return requireKey(name);
  return (generated[name] ??= KeyPair.fromRandom("ed25519").toString()) as KeyPairString;
}

/** Sets `entries` in `.env.testnet` (replacing existing lines, keeping the rest), mode 0600. */
export function upsertEnv(entries: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [name, value] of Object.entries(entries)) {
    const line = `${name}=${value}`;
    const at = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  writeFileSync(ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

/** Asks the human to type `yes`. Never auto-confirms: without a terminal the answer is no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} Type "yes" to sign: `)).trim() === "yes";
  } finally {
    rl.close();
  }
}

export function explorer(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}
