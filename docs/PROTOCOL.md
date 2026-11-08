# REORG Protocol (v1)

**Status: normative.** This file defines everything that must be computed identically by more than one component: the Rust contract, the TypeScript core (boss service, tower client) and the reference generator `protocol/gen_vectors.py`. If an implementation disagrees with this document, the implementation is wrong. If this document is ambiguous, fix this document first, then regenerate the vectors.

- Test vectors: `protocol/vectors.json` (generated, do not hand-edit). Regenerate with `python3 protocol/gen_vectors.py`. `--check` fails if it is stale.
- Default parameters: `protocol/config.default.json` (§10).
- Typed mirror of the JSON shapes in §11–§12: `packages/core/src/abi.ts`, `events.ts`, `config.ts`.
- Rationale for the decisions referenced as `D1`…`D19`: `ROADMAP.md` §2. Product rules: `REORG Product and Technical Spec.md` (the "spec").

The protocol is chain-agnostic. It needs SHA-256, unsigned integer arithmetic and a monotonic timestamp in nanoseconds. Wallet identity is an **opaque string**, hashed as UTF-8. Appendix A describes the NEAR binding.

---

## 1. Conventions

- **bps**: basis points, denominator `BPS = 10000`.
- **Integer math only.** All amounts and weights are unsigned integers. `/` means floor division. Every product listed in §7 needs 256-bit intermediates (vector `pay/u256-overflow`). Every rounding remainder ("dust") has a named destination; none is lost.
- **Amounts**: token amounts are in token base units (the token has 18 decimals). Payout amounts are in the payout currency's base unit (yoctoNEAR on NEAR, 10^24 per NEAR).
- **Time**: nanoseconds since the Unix epoch (`u64`).
- **Tiers** are indexed `0 = Director, 1 = Manager, 2 = Associate, 3 = Intern`. "No tier" means *visitor*.
- `‖` is byte concatenation. `utf8(s)` is the UTF-8 encoding of `s` with no terminator.

## 2. Tasks and "days"

- Task ids are sequential, starting at **1**. A "day" in any field (`last_pass_day`, `joined_after`, streaks, layoff counters) is a **task id**, never a calendar date.
- At most one task is not Finalized at any time. A new task may open only once the previous one is Finalized.
- Stored task status: `Open → Finalizing → Finalized`. Views report **`closed`** for a stored `Open` task when `now ≥ closes_at`. `closed` is derived and never stored.
- `last_finalized` = id of the most recent Finalized task (0 if none). Every derived employee state (§6) is computed against `last_finalized`.
- A task's window is `[opens_at, closes_at)`. `closes_at − opens_at ≥ min_window_ns`.
- The epoch length (time between task openings) is **boss scheduler config** (`EPOCH_SECONDS`, `WINDOW_FRACTION`), not contract config. The contract enforces only `min_window_ns`.

## 3. Commit–reveal

1. For each task the boss draws `day_secret`: **exactly 32 bytes** from a CSPRNG, fresh per task and never reused.
2. `commit_hash = sha256(day_secret)` (over the 32 raw bytes). It is published when the task opens.
3. At finalize the boss reveals `day_secret`. The verifier requires `len(day_secret) == 32` and `sha256(day_secret) == commit_hash`.
4. The boss must persist `day_secret` durably **before** publishing `commit_hash`.

## 4. The answer (Decode the Memo), D2

```
h    = HMAC-SHA256(key = day_secret, msg = utf8(wallet))          # RFC 2104, 64-byte block
code = for i in 0..4: CONSONANTS[h[2i] mod 14] ‖ VOWELS[h[2i+1] mod 5]
CONSONANTS = "BDFGKLMNPRSTVZ"   VOWELS = "AEIOU"
```

- `code` is 8 ASCII uppercase letters in consonant-vowel pairs (e.g. `ZADENELU`), giving 14⁴·5⁴ = 24,010,000 possible codes. The modulo bias is accepted.
- The task id is not an HMAC input: `day_secret` is already unique per task.
- With a 32-byte key, HMAC needs no key hashing. Implementations that hand-roll HMAC must still pass the RFC 4231 vectors in `hmac_sha256`.
- The puzzle shown to the wallet encodes `code` (cipher, memo text, hint). Puzzle generation is boss-side, and the protocol fixes only the answer. The puzzle must have exactly one candidate in code format that is consistent with the displayed text and hint (roadmap B-04).

## 5. Normalization and the answer hash

```
norm(s)     = s
              → trim leading/trailing ASCII whitespace (0x20, 0x09, 0x0A, 0x0D, 0x0B, 0x0C)
              → ASCII a–z to A–Z (nothing else is case-mapped)
              → replace "0" with "O" and "1" with "I"
answer_hash = sha256( utf8(norm(answer)) ‖ 0x00 ‖ utf8(wallet) )      # 32 bytes
```

- The submitter computes `answer_hash` locally and submits only the hash. The verifier never sees the raw answer. It recomputes `answer_hash(code, wallet)` from the revealed secret, and `norm(code) == code`.
- Internal whitespace is **kept**, so `"bado kigu"` does not match. Non-ASCII characters are left as-is.
- Binding the hash to `wallet` makes a copied hash useless to any other wallet (vector `wallet_binding`).

## 6. Employees and derived state

### 6.1 Tiers, D12

```
tier(balance, total_supply) = smallest k in 0..4 with  balance × BPS ≥ tier_thresholds_bps[k] × total_supply
                              else visitor
```
Exact integer comparison: holding exactly the threshold qualifies. `total_supply > 0`. Thresholds are strictly descending.

### 6.2 Records

A wallet gets an employee record on its **first accepted submission** (§7.1):

| Field | Meaning |
|---|---|
| `joined_after` | `last_finalized` at the moment the record was created |
| `last_pass_day` | id of the last task the wallet passed, or none |
| `streak` | stored streak, updated only on a pass (§6.4) |
| `last_tier`, `last_balance` | tier and snapshot balance of the wallet's most recent accepted submission (sets the tower floor, §6.5) |
| `total_earned` | sum of salaries actually paid |
| `badges` | bitmask (bit 0 = `rehired`; other bits reserved) |

No field is written when a wallet misses. Everything below is derived lazily, so no loop over employees is ever needed (D5).

### 6.3 Gap, layoff, misses, D5

With `A = layoff_after` and `L = layoff_len`:

```
base   = last_pass_day if present else joined_after
gap    = max(0, last_finalized − base)

if gap < A:                 laid_off = false, misses_in_row = gap
else: r = (gap − A) mod (A + L)
      if r < L:             laid_off = true,  layoff_tasks_left = L − r
      else:                 laid_off = false, misses_in_row = r − L
```

- With the defaults (A=3, L=7): gaps 0–2 are active (1–2 is *struggling*), 3–9 are laid off, 10–12 are active again (11–12 struggling), 13–19 are laid off again, and so on. A wallet that keeps not playing gets laid off again.
- `L = 0` disables layoffs.
- `max(0, …)` matters while a task is Finalizing: a passer already has `last_pass_day = last_finalized + 1`.
- `misses_in_row` is 0 while laid off, and `layoff_tasks_left` is 0 while not laid off.

### 6.4 Streak, D6

```
effective_streak       = stored streak  if gap == 0 and last_pass_day is present,  else 0
on pass of task N:     streak = streak + 1  if last_pass_day == N − 1,  else 1;   last_pass_day = N
multiplier_bps(s)      = BPS + streak_step_bps × min(s, streak_max_steps)          # 10000 … 15000
```

- The multiplier is fixed **at submission time** from `effective_streak` evaluated against `last_finalized = N − 1`, i.e. the streak *before* this task.
- A streak milestone fires when the new streak is in `streak_milestones` (3, 7, 14).

### 6.5 Status

Employee status (in contract views and in core):

| Status | Condition |
|---|---|
| `laid_off` | §6.3 `laid_off` |
| `struggling` | not laid off and `misses_in_row ≥ 1` |
| `active` | otherwise |

Character status in the tower (computed in `packages/core` from holders ⋈ employees, D16). Rules apply top to bottom:

1. Account in `excluded_accounts` → not shown.
2. Current balance gives no tier → **visitor** (lobby, outside the glass).
3. Holder with no employee record → **new hire**. The floor uses the tier of the current balance. A new hire is never "missing" and never laid off.
4. Otherwise → the employee status above. The floor uses the tier of the wallet's most recent submission snapshot, so tier changes show at the next submission (spec §9.4).

Per-task overlays come from submissions, not employee state: *submitted* (a submission exists for the open task), *passed* / *missed* (for the last finalized task, shown until the next task opens). Flame level = the number of milestones ≤ `effective_streak`.

### 6.6 Reapplication and rehire, D4

At submission time, if the wallet is `laid_off`, its submission is flagged `reapply`. A reapply submission carries no weight, adds nothing to tier totals and is never paid. If it passes, `last_pass_day` updates as for any pass: the gap resets, the wallet becomes `active`, the `rehired` badge bit is set, and a `rehired` event is emitted.

## 7. Submissions, pay, claims

### 7.1 Accepting a submission

A submission for task N by `wallet` is accepted only if all of these hold:

1. Task N is `Open` and `now < closes_at`.
2. `wallet ∉ excluded_accounts`.
3. The wallet has no submission and no pending submission for task N (one per wallet per task).
4. **Anti-recycling, D15:** the token's `last_received_at(wallet)` is **strictly before** `opens_at`. A wallet that received tokens at or after the task opened takes part from the next task on (vectors `recycle`).
5. `tier(balance, total_supply) ≠ visitor`, using the balance read at submission time (the *snapshot*).

The stored submission holds `answer_hash`, the snapshot `balance`, `tier`, `streak_before`, `multiplier_bps`, `weight = balance × multiplier_bps`, `submitted_at` and `reapply` (§6.6). Weight carries the bps factor and is never divided. Unless `reapply` is set, `weight` is added to `tier_submitted_weight[tier]`.

### 7.2 Finalize

The finalize call checks the commit (§3). Each listed passer must have a submission whose stored `answer_hash` equals `answer_hash(derive_code(day_secret, wallet), wallet)`, or the whole call fails. Passers may be split across calls, at most `max_passers_per_call` per call, and the last call is flagged. A passer listed twice fails.

Income is snapshotted on the **first** finalize call: `income = income_accrued`, then `income_accrued = 0`. Deposits that arrive later count toward the next task.

### 7.3 Pay math, D1 (exact order of operations)

```
payroll        = income × payroll_bps / BPS
jackpot        = income × jackpot_bps / BPS          # v1: goes to reserve (D9)
reserve_share  = income − payroll − jackpot          # absorbs rounding
bucket[k]      = payroll × tier_bucket_bps[k] / BPS
payroll_dust   = payroll − Σ bucket[k]

submitted_w[k] = Σ weight of non-reapply submissions in tier k        (accumulated at submit)
pay(i)         = bucket[tier_i] × weight_i / submitted_w[tier_i]      # 256-bit product, passers only
tier_payable[k]= Σ pay(i) over verified non-reapply passers in tier k (accumulated per finalize call)

to_reserve     = reserve_share + jackpot + payroll_dust + Σ_k (bucket[k] − tier_payable[k])
```

- Invariant: `Σ tier_payable + to_reserve == income`, exactly.
- Non-submitters don't dilute. Submitters who failed keep their weight in the denominator, so their share goes to the reserve (spec §5.3 example; vectors `pay/spec-5.3-*`). A passer's pay does not depend on who else passed. A tier with one submitter takes its whole bucket (known limitation).
- A tier with no submitters or no passers sends its whole bucket to the reserve.

On the last finalize call, in this order:

```
reserve        += to_reserve
operating_paid  = min(operating_cost, reserve);  reserve −= operating_paid    # sent to the boss operator (D10)
runway_tasks    = reserve / operating_cost        (none if operating_cost == 0)
reserve_low     = reserve < reserve_low
```

### 7.4 Claims and anti-dump

`claim_salary(N)` by a verified, non-reapply passer with `pay > 0` that has neither claimed nor forfeited:

```
allowed = current_balance × BPS ≥ antidump_bps × snapshot_balance
```

If allowed, pay `pay(i)` and add it to `total_earned`. Otherwise move `pay(i)` to the reserve (forfeit). The claimed or forfeited mark is set **before** any async balance read, and it is cleared again if the payout fails. Unclaimed salaries do not expire (v1). Vectors: `antidump`.

### 7.5 Treasury books

`reserve`, `income_accrued` and `outstanding` (allocated but unclaimed salaries) are internal books. Payouts never exceed them. Funds the contract holds outside the books (for example storage deposits) are not treasury.

## 8. Stretch rules (not in v1, reserved)

- `prove_pass(N)` (D17, P1): after the reveal and until task N+1 is finalized, a submitter whose hash verifies may prove their own pass. Their `pay(i)` moves from reserve to outstanding, and streak and `last_pass_day` update as in §6.4. The window closes when N+1 finalizes, because by then N+1's weights have already used the old streak.
- `void_task` (P2): voided ids must be skipped in §6.3 and §6.4 (gaps and "N − 1" count only non-voided tasks). v1 has no voids.
- Jackpot, bankruptcy and severance: `jackpot_bps` and `bankruptcy_empty_tasks` exist in config but are unused in v1.

## 9. Test vectors (`protocol/vectors.json`)

| Section | Covers |
|---|---|
| `hmac_sha256` | RFC 4231 cases 1–3, for hand-rolled HMAC |
| `crypto` | 12 × (secret, wallet) → commit hash, HMAC, code, answer hash (hex and base64) |
| `wallet_binding` | same code, different wallet → different hash |
| `normalization` | §5 edge cases |
| `tier` | exact boundaries, a non-divisible supply |
| `multiplier`, `streak_update` | §6.4 |
| `layoff` | gaps 0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 19, 20, 22, 23 at A=3/L=7, plus L=0 |
| `status` | full §6.3–§6.4 derivation from record fields |
| `antidump`, `recycle` | §7.4, §7.1 rule 4 |
| `pay` | spec §5.3 example (all pass / one fails), rounding with reapply and empty tiers, zero income, a u256-overflow case |

Big integers are decimal strings, and bytes are lowercase hex (plus base64 where the wire format uses it). Each implementation's test suite must load this file directly. Never copy values out of it.

## 10. Configuration (P-04)

Contract config, set at deploy and changeable only by the owner. Defaults are in `protocol/config.default.json` (spec §13). Deployments override values per network (for example a short `min_window_ns` for the local demo). Contracts have **no** demo flags.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tier_thresholds_bps` | u16[4] | 300, 100, 25, 5 | 3% / 1% / 0.25% / 0.05% of supply |
| `tier_bucket_bps` | u16[4] | 3500, 3000, 2000, 1500 | payroll share per tier, sums to 10000 |
| `payroll_bps` / `reserve_bps` / `jackpot_bps` | u16 | 6000 / 3000 / 1000 | income split, sums to 10000 (reserve takes the rounding remainder, §7.3) |
| `streak_step_bps` | u16 | 1000 | +10% per streak step |
| `streak_max_steps` | u8 | 5 | cap → multiplier 15000 bps (1.5×) |
| `streak_milestones` | u32[] | 3, 7, 14 | ascending; `streak_milestone` events, flame levels |
| `layoff_after` (A) | u32 | 3 | consecutive misses before layoff, ≥ 1 |
| `layoff_len` (L) | u32 | 7 | layoff length in tasks; 0 disables |
| `antidump_bps` | u16 | 9000 | claim needs ≥ 90% of snapshot balance |
| `bankruptcy_empty_tasks` | u32 | 3 | reserved (P2) |
| `operating_cost` | u128 | 0.1 NEAR | paid from reserve per finalized task |
| `reserve_low` | u128 | 1 NEAR | `reserve_low` event threshold |
| `min_window_ns` | u64 | 1 h | minimum `closes_at − opens_at` |
| `max_passers_per_call` | u32 | 50 | finalize batch cap (tune with C-18 gas numbers) |
| `excluded_accounts` | string[] | [] | never employees, hidden in the tower (deployer, contract, treasury/LP, crowd root) |

Validation (contract `new` / `update_config` and core `ConfigSchema` must agree): thresholds strictly descending and > 0; both bps arrays and the split sum to 10000; every bps value ≤ 10000; `layoff_after ≥ 1`; milestones strictly ascending and > 0; `max_passers_per_call ≥ 1`; `min_window_ns > 0`.

Contract-level identities (not config): `owner`, `boss`, `token`, cached `total_supply`.

## 11. JSON wire encoding

- `u128` amounts and weights, and `u64` timestamps → **decimal strings**.
- Task ids, counts, bps, tier indexes, gaps, badges → JSON numbers (< 2⁵³).
- 32-byte values (`commit_hash`, `day_secret`, `answer_hash`) → **standard base64 with padding** (44 chars).
- Optional values → `null`.
- Tier → index 0–3.

## 12. Events

Every event has a sequence number `seq` (starting at 1, gapless), a timestamp `at` and a `data` object. Payloads (all fields required):

| Event | Data |
|---|---|
| `task_opened` | `task_id, kind, commit_hash, opens_at, closes_at` |
| `submission_received` | `task_id, account_id, tier, balance, weight, reapply` |
| `task_finalized` | `task_id, day_secret, submitted, passed` (counts; per-wallet results via `list_submissions`) |
| `payroll_allocated` | `task_id, income, payroll, jackpot, reserve_share, buckets[4], tier_payable[4], to_reserve, operating_cost_paid, reserve_after, runway_tasks` |
| `salary_paid` | `task_id, account_id, amount` |
| `salary_forfeited` | `task_id, account_id, amount, snapshot_balance, current_balance` |
| `income_deposited` | `from, amount, tag` (`client_job` \| `fee_share` \| `seed`) |
| `streak_milestone` | `task_id, account_id, streak` |
| `rehired` | `task_id, account_id` |
| `reserve_low` | `task_id, reserve, threshold` |

There is no `laid_off` event: layoff is derived state (D7). Clients animate it when the derived status changes.

---

## Appendix A: NEAR binding (non-normative)

- `wallet` = the NEAR `AccountId` string. The submitting account is the predecessor of `submit`.
- Events are logged as NEP-297, `EVENT_JSON:{"standard":"reorg","version":"1.0.0","event":"<name>","data":[<data>]}`, **and** appended to an on-chain ring buffer (last 512) read via `get_events(since_seq, limit)` (D8).
- The balance snapshot and `last_received_at` come from the custom token's `ft_holder_info(account_id) → {balance, last_received_at}` (D15, D16), read in the `submit → on_balance` callback.
- `sha256` = `env::sha256`. HMAC is built on it (§4).
- `u128` in JSON is `near_sdk::json_types::U128`, and 32-byte values are `Base64VecU8`.
