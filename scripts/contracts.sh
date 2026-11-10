#!/bin/sh
# Rust contract tasks (contracts/). Falls back to ~/.cargo/bin when cargo is not on PATH.
#   build    wasm for the token and the REORG contract → contracts/target/near/*/ and contracts/res/
#   test     unit tests + protocol vectors (core, token, contract); no sandbox needed
#   sandbox  build, then the near-sandbox integration and gas tests (C-17, C-18)
set -eu
export PATH="$PATH:$HOME/.cargo/bin"
if ! command -v cargo >/dev/null 2>&1; then
  echo "contracts.sh: cargo not found. Install Rust (https://rustup.rs) and cargo-near." >&2
  exit 1
fi
cd "$(dirname "$0")/../contracts"

build() {
  for crate in token reorg; do
    (cd "$crate" && cargo near build non-reproducible-wasm --no-abi)
  done
  # Prebuilt copies for clones without Rust (`npm run demo` falls back to them); commit them.
  mkdir -p res
  cp target/near/reorg_token/reorg_token.wasm target/near/reorg_contract/reorg_contract.wasm res/
}

case "${1:-}" in
  build) build ;;
  test) cargo test -q -p reorg-core -p reorg-token -p reorg-contract ;;
  sandbox) build && cargo test -p reorg-integration-tests -- --nocapture ;;
  *) echo "usage: scripts/contracts.sh build|test|sandbox" >&2; exit 2 ;;
esac
