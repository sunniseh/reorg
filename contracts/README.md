# REORG contracts

Rust workspace for roadmap §5 (C-01 … C-18, C-21). `docs/PROTOCOL.md` is normative; every
crate here is tested against `protocol/vectors.json`.

| Crate | What it is | Chain code? |
|---|---|---|
| `core/` (`reorg-core`) | **All rules**: commit–reveal, HMAC code, answer hash, normalization, tiers, D5 layoffs, D6 streaks, D1 pay math with 256-bit `mul_div`, anti-dump, anti-recycling, and the state transitions (`engine`: open / submit / finalize / settle / claim / prove / deposit), events and view shapes. | **None.** Plain Rust + serde/borsh. SHA-256 is a trait the host supplies. Wallet ids are opaque strings. |
| `reorg/` (`reorg-contract`) | NEAR adapter: storage layout, promises (`ft_holder_info` reads, transfers), NEP-297 logs + event ring, access control. Calls `engine::*` and nothing decides an outcome here. | NEAR only |
| `token/` (`reorg-token`) | $REORG: NEP-141/145/148 plus `last_received_at` (D15) and an iterable holder set (D16). | NEAR only |
| `integration-tests/` | near-sandbox tests with the real token (C-17) and gas at 100 accounts (C-18). | test only |

## Commands (from the repo root)

```sh
npm run contracts:build    # wasm → contracts/target/near/{reorg_token,reorg_contract}/*.wasm
npm run contracts:test     # unit tests + vectors (core, token, contract); part of `npm test`
npm run contracts:sandbox  # build, then sandbox integration + gas tests (downloads near-sandbox once)
```

Single tests: `cd contracts && cargo test -p reorg-core <name>`, or
`cargo test -p reorg-integration-tests --test sandbox <name>`.

## Adapter contract (what a host must provide)

The engine functions validate before they mutate and return the events to publish. A host:

1. stores `Task`, `Submission` (keyed by task + wallet), `Employee` (keyed by wallet), `Treasury`, `Config`;
2. supplies SHA-256 (`crypto::Sha256`) — a host function where one exists;
3. reads `{balance, last_received_at}` for a wallet from the token, possibly asynchronously:
   `precheck_submission` → mark pending → read → `accept_submission`; claims use
   `begin_claim` → read → `resolve_claim` → transfer → `confirm_salary` / `rollback_salary`;
4. transfers the payout currency for salaries and the operating cost (`rollback_operating_cost` on failure);
5. aborts the call on `Err` (or, inside an async callback, clears its own marker and reports the error as a value);
6. publishes events (`EventEntry` = `{seq, at, event, data}`) and keeps the last 512 readable.

Nothing else is chain specific. Porting means writing a new adapter crate over `reorg-core`;
the rules, vectors and engine tests come along unchanged.

## NEAR specifics

- `submit` / `claim_salary` return their outcome as the callback's value (`SubmitOutcome`,
  `ClaimOutcome` in `packages/core/src/abi.ts`). Callbacks never panic, so the pending marker is
  always cleared. Attach 100 Tgas; the refund of unused prepaid gas lands a few blocks later.
- NEAR allows 100 log lines per call. `new` / `update_config` reject a `max_passers_per_call` that
  could exceed it (one event per passer, two if `1` is a streak milestone, plus three).
- **Storage float.** Storage stake is paid from the contract balance outside the books
  (§7.5). `submit` requires ≥ 0.05 NEAR of float (`get_storage_float`); top up with a plain
  transfer. Payouts never touch it.
- Wasm sizes (`cargo near build`, opt-level z + LTO + wasm-opt): token ≈ 190 KB, contract ≈ 290 KB
  (≈ 1.9 and 2.9 NEAR of storage stake).

## Measured gas (C-18, near-sandbox, 100 accounts across four tiers)

| Operation | Tgas | NEAR at min gas price |
|---|---|---|
| `submit` + `ft_holder_info` + `on_balance` | 7.2 | 0.0007 |
| `finalize_task`, 25 passers | 13.8 | 0.0014 |
| `finalize_task`, 50 passers + settle | 29.0 | 0.0029 |
| `claim_salary` (read + transfer + callback) | 9.5 | 0.0010 |

Finalize costs ≈ 0.5 Tgas per passer, so the 300 Tgas cap is far away; the 100-log limit binds
first (≤ 97 passers per call). Storage, not gas, is the running cost: each submission keeps
≈ 250 bytes (≈ 0.0025 NEAR of stake), a first-time employee ≈ 600 bytes.
