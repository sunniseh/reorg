// Build artifacts and defaults shared by the sandbox harness and the testnet scripts (D-05, D-06):
// the compiled contracts, the default contract config and the token constants.
import { readFileSync } from "node:fs";
import { ConfigSchema, type ContractConfig } from "@reorg/core";

const REPO = new URL("../../../", import.meta.url);
export const TOKEN_DECIMALS = 18n;
export const ONE_TOKEN = 10n ** TOKEN_DECIMALS;
export const DEFAULT_SUPPLY = 1_000_000_000n * ONE_TOKEN;

/**
 * A fresh local build (`npm run contracts:build`) wins; otherwise the prebuilt copy in
 * `contracts/res/` (refreshed by every build), so a clone without Rust still runs the demo.
 */
export function wasm(name: "reorg_token" | "reorg_contract"): Uint8Array {
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

/** The token icon as a data URI (brand/icon/token-icon.datauri.txt, placeholder art), or null if absent. */
export function tokenIcon(): string | null {
  try {
    return readFileSync(new URL("brand/icon/token-icon.datauri.txt", REPO), "utf8").trim() || null;
  } catch {
    return null;
  }
}
