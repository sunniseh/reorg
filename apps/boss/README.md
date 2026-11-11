# REORG boss service (`apps/boss`)

Roadmap §6 (B-05 … B-13, B-15, B-16). Runs the daily cycle against the REORG contract, serves
each wallet its puzzle, and writes the feed. **The boss decides nothing the contract can't
check**: pass/fail is the answer hash re-verified on chain at finalize, and the LLM (optional)
only writes text.

```sh
npm run boss            # env vars: see .env.example (NEAR_RPC_URL, REORG_CONTRACT_ID, BOSS_* …)
npm run boss:sandbox    # adapter + boss end-to-end tests on a local near-sandbox (~2 min; needs `npm run contracts:build`)
```

## Files

| File | What |
|---|---|
| `src/scheduler.ts` | The state machine (B-08/B-09/B-11). One tick = at most one step. |
| `src/store.ts` | SQLite (`node:sqlite`, WAL, `synchronous=FULL`): one row per task slot, the feed, employee status snapshots. |
| `src/picker.ts` | Which cipher/level each slot gets (B-10): weekly level rhythm, no repeat of yesterday's cipher, optional auto difficulty, fixed demo schedule. |
| `src/flavor/` | Flavor text (B-05/06/07): zod schema + semantic checks, template grammar (default), NEAR AI / OpenAI-compatible client with one retry and template fallback. |
| `src/notices.ts` | Layoff / warning / rehire notices from status diffs (there is no `laid_off` event, D7); payday / streak / low-reserve from contract events. |
| `src/api.ts` | HTTP API (B-12), `node:http`, read-only, served from the store (no RPC per request). |
| `src/env.ts`, `src/main.ts` | Config from env, wiring, clean Ctrl-C. |

Chain access goes through `ChainAdapter` (`packages/core/src/chain.ts`), implemented for NEAR
in `packages/chain-near`. Nothing in this app imports a NEAR library.

## The cycle

```
PICKED → GENERATED → CHECKED → OPENING → OPEN → CLOSED → FINALIZING → FINALIZED
 pick     secret      self-     memo text  announced  closes_at   freeze call,    results, payday,
 params   drawn and   check     written,   (feed)     + margin    passer batches  streaks, layoffs,
          stored      (fallback chain id                          (last = true)   rehires (feed)
                      if bad)   reserved,
                                open_task
```

- **The secret is stored before its commit exists anywhere** (GENERATED), and never cleared.
- The next `LOOKAHEAD_TASKS` slots are generated and self-checked ahead of time; a failure shows in `/healthz` long before that task is due. A day whose puzzle fails the check uses the level-1 Caesar fallback; it is never skipped.
- **Finalize is two-phase.** First an empty `finalize_task(passers: [], last: false)` reveals the secret and freezes the submission set (a submit callback still in flight is rejected from then on). Then the boss re-lists all submissions, recomputes the passers locally (`answer_hash == hash(code(secret, wallet), wallet)`), drops those already verified, and sends batches of `max_passers_per_call`, the last one with `last: true`.
- **Every chain step reconciles before acting.** `open` checks whether its reserved task id already exists with its commit (a lost response); `finalize` recomputes the remaining passers from chain state. So a crash, timeout or restart anywhere resumes without a double open or a duplicate passer. `test/restart.test.ts` kills the boss after every persisted write and before/after every chain call, then checks this.
- Timing: the next task opens `EPOCH_SECONDS` after the previous one opened (and never before it is finalized). The window is `EPOCH_SECONDS × WINDOW_FRACTION`, but never shorter than the contract's `min_window_ns` + 3 s. The first `WARMUP_TASKS` slots are level 1, use `WARMUP_WINDOW_SECONDS`, and run back to back (D-03).

## HTTP API

All `GET` (except the demo faucet), JSON, `cache-control: no-store`. CORS only for origins in `WEB_ORIGIN` (comma-separated).

| Route | Returns |
|---|---|
| `GET /api/task/current` | Newest opened task: `task_id, status (open/closed/finalizing/finalized), cipher, cipher_label, level, warmup, commit_hash, opens_at, closes_at (ns strings), task_text, written_by (ai/template), submitted, passed`. 404 before the first task. |
| `GET /api/puzzle?wallet=<id>` | The wallet's personal puzzle while the task is open: `task_id, display, hint, answer_format, task_text, closes_at`. 404 if no task is open, 409 after `closes_at`, 400 for a missing, over-128-character or control-character wallet. Unauthenticated by design (D3): the answer hash is bound to the submitting account. |
| `GET /api/feed?since=<id>&limit=<≤200>` | `{entries, last_id}`. Entry: `id, at (ms), kind, task_id, text, source (ai/template/system), data`. `data` holds the code-computed facts; `text` is flavor. Kinds: `task_opened, results, payday, streak, reserve_low, layoff_warning, layoff, rehire, stalled, recovered`. |
| `GET /api/tower[?you=<id>]` | The big-company tower (`src/tower.ts`, D22): `{at (ms), task_id, tower}`, where `tower` is `encodeTower(layoutTower(…))` from `packages/core` (drawn floors, folded runs with exact counts, drawn visitors). The boss reads every holder, employee and submission once per `TOWER_REFRESH_SECONDS` (default 15; 0 turns the route off, 404); `you` unfolds that wallet's floor. 503 before the first read. Clients use it past 2,000 holders and still read their own state from the chain. |
| `GET /api/feed/stream` | Server-sent events (`event: feed`, `id` = entry id). Resumes after `Last-Event-ID` or `?since=`. |
| `GET /api/reveal/<task_id>[?wallet=<id>]` | **Only after FINALIZED**: the day secret (check `sha256(secret) == commit_hash` yourself), plus that wallet's puzzle and `expected_answer`. 409 before. |
| `POST /api/faucet` | **Demo only** (D-09), off unless `FAUCET_ENABLED=1`: body `{public_key: "ed25519:…"}` → creates `p<random>.<FAUCET_ACCOUNT_ID>` with that key, registers it with the token, sends `FAUCET_NEAR_AMOUNT` yoctoNEAR and `FAUCET_TOKEN_AMOUNT` $REORG; returns `{account_id, tokens, native}`. At most `FAUCET_RATE_LIMIT_PER_IP` per address per hour and `20 ×` that across all addresses (429), and at most `FAUCET_MAX_ACCOUNTS` burners per boss process (default 25 on testnet, unlimited on the sandbox; the cap resets on a restart, so the funder's balance is the hard limit). The web client's demo player uses it. |
| `GET /healthz` | 200 / 503. Scheduler status (`RUNNING`/`STALLED`), head slot and state, retry count and last error (secrets redacted), the look-ahead queue with self-check results, the flavor source, `now_ms` (the boss clock) and whether the faucet is on. |

The client computes `answer_hash` itself (`answerHashBase64` in `@reorg/core`) and submits it to
the contract with its own wallet. The boss never sees an answer.

## Failures and manual recovery (B-11)

- RPC errors are retried with exponential backoff (1 s … 60 s). After 5 failed attempts at one step, or immediately on a chain state only a human can fix, `/healthz` turns 503 with `status: "STALLED"` and the feed gets a `stalled` entry. It keeps retrying, and posts `recovered` when it gets through.
- **"chain task N is not finalized and is not this boss's"**: the contract has an open task that this boss's database does not know (for example a fresh `BOSS_DB_PATH` against a running contract). Restore the old database file. Without its `day_secret`, the task cannot be finalized: `void_task` is P2, so the only way forward is a fresh contract deployment.
- **"chain task N exists with a different commit"**: another process with the boss key opened a task. Run only one boss per contract.
- Losing the database while a task is open loses that task's secret (R-09). Back up `BOSS_DB_PATH`. Its WAL files (`-wal`, `-shm`) are part of it.
- Logs are JSON lines on stdout/stderr. Neither secrets nor keys are ever logged.
