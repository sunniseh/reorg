#!/usr/bin/env python3
"""Reference implementation of the REORG protocol and generator for protocol/vectors.json.

This file is the third, independent implementation of docs/PROTOCOL.md (the
other two are the Rust contract and packages/core in TypeScript). Both of
those must reproduce every vector this script writes. If this script and
PROTOCOL.md disagree, PROTOCOL.md wins and this script is the bug.

Usage (stdlib only, Python >= 3.8):
    python3 protocol/gen_vectors.py           # rewrite protocol/vectors.json
    python3 protocol/gen_vectors.py --check   # exit 1 if vectors.json is stale
"""

import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VECTORS_PATH = HERE / "vectors.json"
CONFIG_PATH = HERE / "config.default.json"

BPS = 10_000
CONSONANTS = "BDFGKLMNPRSTVZ"  # 14
VOWELS = "AEIOU"  # 5
ASCII_WS = " \t\n\r\x0b\x0c"
TIER_NAMES = ["director", "manager", "associate", "intern"]

ONE_NEAR = 10**24
ONE_TOKEN = 10**18


# --------------------------------------------------------------------------
# Protocol functions (PROTOCOL.md §3-§7)
# --------------------------------------------------------------------------


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def derive_code(day_secret: bytes, wallet: str) -> str:
    assert len(day_secret) == 32
    h = hmac_sha256(day_secret, wallet.encode("utf-8"))
    return "".join(
        CONSONANTS[h[2 * i] % len(CONSONANTS)] + VOWELS[h[2 * i + 1] % len(VOWELS)]
        for i in range(4)
    )


def normalize(answer: str) -> str:
    s = answer.strip(ASCII_WS)
    s = "".join(chr(ord(c) - 32) if "a" <= c <= "z" else c for c in s)
    return s.replace("0", "O").replace("1", "I")


def answer_hash(normalized_answer: str, wallet: str) -> bytes:
    return sha256(normalized_answer.encode("utf-8") + b"\x00" + wallet.encode("utf-8"))


def tier_of(balance: int, total_supply: int, thresholds_bps):
    assert total_supply > 0
    for k, t in enumerate(thresholds_bps):
        if balance * BPS >= t * total_supply:
            return k
    return None


def multiplier_bps(streak_before: int, step_bps: int, max_steps: int) -> int:
    return BPS + step_bps * min(streak_before, max_steps)


def employee_state(last_finalized, joined_after, last_pass_day, stored_streak, A, L):
    """Derived employee state (PROTOCOL.md §6). Never stored."""
    base = joined_after if last_pass_day is None else last_pass_day
    gap = max(0, last_finalized - base)
    if gap < A:
        laid_off, left, misses = False, 0, gap
    else:
        r = (gap - A) % (A + L)
        if r < L:
            laid_off, left, misses = True, L - r, 0
        else:
            laid_off, left, misses = False, 0, r - L
    streak = stored_streak if (gap == 0 and last_pass_day is not None) else 0
    if laid_off:
        status = "laid_off"
    elif misses > 0:
        status = "struggling"
    else:
        status = "active"
    return {
        "gap": gap,
        "status": status,
        "laid_off": laid_off,
        "layoff_tasks_left": left,
        "misses_in_row": misses,
        "effective_streak": streak,
    }


def streak_after_pass(task_id, last_pass_day, stored_streak):
    return stored_streak + 1 if last_pass_day == task_id - 1 else 1


def claim_allowed(current_balance: int, snapshot_balance: int, antidump_bps: int) -> bool:
    return current_balance * BPS >= antidump_bps * snapshot_balance


def submission_allowed_after_receive(last_received_at, opens_at) -> bool:
    """Anti-recycling (D15): tokens received at or after opens_at disqualify."""
    return last_received_at is None or last_received_at < opens_at


def allocate(income, cfg, submissions, reserve_before):
    """Payroll allocation at finalize (PROTOCOL.md §7).

    submissions: list of {account_id, tier, weight, passed, reapply}.
    """
    payroll = income * cfg["payroll_bps"] // BPS
    jackpot = income * cfg["jackpot_bps"] // BPS
    reserve_share = income - payroll - jackpot
    buckets = [payroll * b // BPS for b in cfg["tier_bucket_bps"]]
    payroll_dust = payroll - sum(buckets)

    submitted_w = [0, 0, 0, 0]
    passed_w = [0, 0, 0, 0]
    for s in submissions:
        if s["reapply"]:
            continue
        submitted_w[s["tier"]] += s["weight"]
        if s["passed"]:
            passed_w[s["tier"]] += s["weight"]

    pays = []
    tier_payable = [0, 0, 0, 0]
    for s in submissions:
        pay = 0
        if s["passed"] and not s["reapply"]:
            pay = buckets[s["tier"]] * s["weight"] // submitted_w[s["tier"]]
        tier_payable[s["tier"]] += pay
        pays.append({"account_id": s["account_id"], "pay": str(pay)})

    to_reserve = (
        reserve_share + jackpot + payroll_dust
        + sum(buckets[k] - tier_payable[k] for k in range(4))
    )
    assert sum(tier_payable) + to_reserve == income

    reserve_mid = reserve_before + to_reserve
    op_cost = int(cfg["operating_cost"])
    op_paid = min(op_cost, reserve_mid)
    reserve_after = reserve_mid - op_paid
    runway = None if op_cost == 0 else reserve_after // op_cost
    reserve_low = reserve_after < int(cfg["reserve_low"])

    s = str
    return {
        "income": s(income),
        "payroll": s(payroll),
        "jackpot": s(jackpot),
        "reserve_share": s(reserve_share),
        "buckets": [s(x) for x in buckets],
        "payroll_dust": s(payroll_dust),
        "tier_submitted_weight": [s(x) for x in submitted_w],
        "tier_passed_weight": [s(x) for x in passed_w],
        "tier_payable": [s(x) for x in tier_payable],
        "to_reserve": s(to_reserve),
        "pays": pays,
        "reserve_before": s(reserve_before),
        "operating_cost_paid": s(op_paid),
        "reserve_after": s(reserve_after),
        "runway_tasks": runway,
        "reserve_low": reserve_low,
    }


# --------------------------------------------------------------------------
# Vector construction
# --------------------------------------------------------------------------


def hx(b: bytes) -> str:
    return b.hex()


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


RFC4231 = [
    # (name, key, data, expected HMAC-SHA256) from RFC 4231 test cases 1-3
    ("rfc4231-case1", bytes([0x0B] * 20), b"Hi There",
     "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
    ("rfc4231-case2", b"Jefe", b"what do ya want for nothing?",
     "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
    ("rfc4231-case3", bytes([0xAA] * 20), bytes([0xDD] * 50),
     "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"),
]


def hmac_vectors():
    out = []
    for name, key, data, expected in RFC4231:
        got = hmac_sha256(key, data).hex()
        assert got == expected, f"{name}: stdlib HMAC disagrees with RFC 4231"
        out.append({"name": name, "key_hex": hx(key), "msg_hex": hx(data), "hmac_hex": expected})
    return out


def crypto_vectors():
    secrets = [
        ("zero-secret", bytes(32)),
        ("ff-secret", bytes([0xFF] * 32)),
        ("counting-secret", bytes(range(32))),
    ] + [(f"derived-secret-{i}", sha256(f"reorg-vector-secret-{i}".encode())) for i in range(1, 4)]
    wallets = [
        "alice.testnet",
        "c001.reorg.testnet",
        "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
        "bob.near",
        "a-very-long-account-name-used-to-check-utf8-message-lengths.near",
    ]
    out = []
    i = 0
    for sname, secret in secrets:
        for w in (wallets[i % len(wallets)], wallets[(i + 3) % len(wallets)]):
            code = derive_code(secret, w)
            ah = answer_hash(code, w)
            out.append({
                "name": f"{sname}/{w}",
                "day_secret_hex": hx(secret),
                "day_secret_b64": b64(secret),
                "commit_hash_hex": hx(sha256(secret)),
                "commit_hash_b64": b64(sha256(secret)),
                "wallet": w,
                "hmac_hex": hx(hmac_sha256(secret, w.encode("utf-8"))),
                "code": code,
                "answer_hash_hex": hx(ah),
                "answer_hash_b64": b64(ah),
            })
            i += 1
    return out


def wallet_binding_vectors():
    """Same code, different wallets -> different answer hashes."""
    code = "BADOKIGU"
    return [
        {"answer": code, "wallet": w, "answer_hash_hex": hx(answer_hash(code, w))}
        for w in ("alice.testnet", "bob.testnet")
    ]


def normalization_vectors():
    cases = [
        ("BADOKIGU", "already canonical"),
        ("badokigu", "lowercase"),
        ("  BaDoKiGu \n", "mixed case with ASCII whitespace"),
        ("\t zuvoPeFi\r\n", "tab, CR, LF"),
        ("BAD0K1GU", "digit 0 -> O, 1 -> I"),
        ("b0d1k1gu", "digits and lowercase"),
        ("bado kigu", "internal space is kept (will not match)"),
        (" BADO", "non-ASCII whitespace is not trimmed"),
        ("ßado", "non-ASCII letters are not case-mapped"),
        ("", "empty"),
    ]
    return [{"input": inp, "output": normalize(inp), "note": note} for inp, note in cases]


def tier_vectors(thresholds):
    S = 1_000_000_000 * ONE_TOKEN
    cases = [
        (S, S, "whole supply"),
        (S * 3 // 100, S, "exactly 3%"),
        (S * 3 // 100 - 1, S, "3% minus one unit"),
        (S // 100, S, "exactly 1%"),
        (S // 100 - 1, S, "1% minus one unit"),
        (S * 25 // 10_000, S, "exactly 0.25%"),
        (S * 25 // 10_000 - 1, S, "0.25% minus one unit"),
        (S * 5 // 10_000, S, "exactly 0.05%"),
        (S * 5 // 10_000 - 1, S, "0.05% minus one unit (visitor)"),
        (0, S, "zero"),
        # 3% of (S+1) is fractional, so S*3/100 is one unit short.
        (S * 3 // 100, S + 1, "supply S+1: 3% boundary rounds up"),
        (S * 3 // 100 + 1, S + 1, "supply S+1: first Director balance"),
    ]
    out = []
    for bal, supply, note in cases:
        k = tier_of(bal, supply, thresholds)
        out.append({
            "balance": str(bal),
            "total_supply": str(supply),
            "tier": k,
            "tier_name": "visitor" if k is None else TIER_NAMES[k],
            "note": note,
        })
    return out


def multiplier_vectors(cfg):
    return [
        {"streak_before": s,
         "multiplier_bps": multiplier_bps(s, cfg["streak_step_bps"], cfg["streak_max_steps"])}
        for s in range(0, 9)
    ]


STATE_KEYS = ("status", "laid_off", "layoff_tasks_left", "misses_in_row")


def layoff_vectors(cfg):
    A, L = cfg["layoff_after"], cfg["layoff_len"]
    out = []
    for gap in [0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 19, 20, 22, 23]:
        st = employee_state(100 + gap, 0, 100, 5, A, L)
        out.append({"layoff_after": A, "layoff_len": L, "gap": gap, **{k: st[k] for k in STATE_KEYS}})
    # Degenerate config: layoff_len = 0 means never laid off.
    for gap in [0, 2, 3, 7]:
        st = employee_state(gap, 0, None, 0, 3, 0)
        out.append({"layoff_after": 3, "layoff_len": 0, "gap": gap, **{k: st[k] for k in STATE_KEYS}})
    return out


def status_vectors(cfg):
    A, L = cfg["layoff_after"], cfg["layoff_len"]
    cases = [
        # (note, last_finalized, joined_after, last_pass_day, stored_streak)
        ("joined during task 5, task 5 not yet finalized", 4, 4, None, 0),
        ("joined during task 5, missed it", 5, 4, None, 0),
        ("joined during task 5, missed 5, 6, 7", 7, 4, None, 0),
        ("passed the last finalized task: streak counts", 9, 2, 9, 4),
        ("passed task 9, task 10 finalized without them: streak lost", 10, 2, 9, 4),
        ("passer of task 10 while task 10 is still finalizing", 9, 2, 10, 5),
        ("streak above multiplier cap", 30, 0, 30, 12),
        ("joined at genesis, never passed, 3 tasks finalized", 3, 0, None, 0),
        ("laid off, last task of the layoff", 12, 0, 3, 1),
        ("layoff over, no new miss yet", 13, 0, 3, 1),
        ("second layoff", 16, 0, 3, 1),
    ]
    out = []
    for note, lf, ja, lpd, streak in cases:
        st = employee_state(lf, ja, lpd, streak, A, L)
        out.append({
            "note": note,
            "last_finalized": lf,
            "joined_after": ja,
            "last_pass_day": lpd,
            "stored_streak": streak,
            **st,
        })
    return out


def streak_update_vectors(cfg):
    cases = [
        (10, 9, 4, "consecutive pass"),
        (10, 7, 4, "after a miss the streak restarts at 1"),
        (10, None, 0, "first ever pass"),
        (10, 9, 13, "milestone 14 reached"),
        (10, 9, 1, "rehire-style pass right after a pass"),
    ]
    out = []
    for t, lpd, s, n in cases:
        new = streak_after_pass(t, lpd, s)
        out.append({"task_id": t, "last_pass_day": lpd, "stored_streak": s, "new_streak": new,
                    "milestone": new in cfg["streak_milestones"], "note": n})
    return out


def antidump_vectors(cfg):
    snap = 1_000_000 * ONE_TOKEN
    cases = [
        (snap, "unchanged"),
        (snap * 9 // 10, "exactly 90%"),
        (snap * 9 // 10 - 1, "90% minus one unit: forfeit"),
        (snap * 2, "bought more"),
        (0, "sold everything: forfeit"),
    ]
    return [
        {"snapshot_balance": str(snap), "current_balance": str(c),
         "antidump_bps": cfg["antidump_bps"],
         "claim_allowed": claim_allowed(c, snap, cfg["antidump_bps"]), "note": n}
        for c, n in cases
    ]


def recycle_vectors():
    opens = 1_700_000_000_000_000_000
    cases = [
        (None, "no receive recorded (defensive; the token sets it on mint)"),
        (opens - 1, "received 1 ns before the task opened"),
        (opens, "received exactly at opens_at: rejected"),
        (opens + 5_000_000_000, "received mid-window: rejected"),
    ]
    return [
        {"opens_at": str(opens), "last_received_at": None if t is None else str(t),
         "submission_allowed": submission_allowed_after_receive(t, opens), "note": n}
        for t, n in cases
    ]


def sub(account, tier, balance, streak_before, passed, reapply, cfg):
    m = multiplier_bps(streak_before, cfg["streak_step_bps"], cfg["streak_max_steps"])
    return {
        "account_id": account,
        "tier": tier,
        "balance": balance,
        "streak_before": streak_before,
        "multiplier_bps": m,
        "weight": balance * m,
        "passed": passed,
        "reapply": reapply,
    }


PAY_CONFIG_KEYS = ("payroll_bps", "reserve_bps", "jackpot_bps", "tier_bucket_bps",
                   "operating_cost", "reserve_low")


def pay_vectors(cfg):
    def case(name, note, income, submissions, reserve_before=0, overrides=None):
        c = dict(cfg)
        c.update(overrides or {})
        result = allocate(income, c, submissions, reserve_before)
        return {
            "name": name,
            "note": note,
            "config": {k: c[k] for k in PAY_CONFIG_KEYS},
            "submissions": [{**s, "balance": str(s["balance"]), "weight": str(s["weight"])}
                            for s in submissions],
            "expected": result,
        }

    no_opcost = {"operating_cost": "0", "reserve_low": "0"}

    def interns(second_passes):
        return [
            sub("intern-a.testnet", 3, 100_000 * ONE_TOKEN, 0, True, False, cfg),
            sub("intern-b.testnet", 3, 50_000 * ONE_TOKEN, 0, second_passes, False, cfg),
            sub("intern-c.testnet", 3, 50_000 * ONE_TOKEN, 0, True, False, cfg),
        ]

    return [
        case("spec-5.3-all-pass",
             "Spec §5.3: 20 NEAR income, Intern bucket 1.8 NEAR, three interns 100k/50k/50k "
             "at streak 0 all pass -> 0.9/0.45/0.45 NEAR. (They are Interns if total supply "
             "is 1e8 tokens.)",
             20 * ONE_NEAR, interns(True), overrides=no_opcost),
        case("spec-5.3-second-fails",
             "Spec §5.3 under D1: the second intern submits and fails; their 0.45 NEAR goes "
             "to the reserve and the others' pay is unchanged.",
             20 * ONE_NEAR, interns(False), overrides=no_opcost),
        case("rounding-mixed",
             "Odd income, mixed streaks, a reapply submission (no weight, no pay), a tier "
             "with submitters but no passers, an empty tier, operating cost and reserve_low.",
             10 * ONE_NEAR + 7,
             [
                 sub("d1.testnet", 0, 40_000_001 * ONE_TOKEN + 3, 2, True, False, cfg),
                 sub("d2.testnet", 0, 33_333_333 * ONE_TOKEN, 7, True, False, cfg),
                 sub("d3.testnet", 0, 30_000_000 * ONE_TOKEN, 0, False, False, cfg),
                 sub("m1.testnet", 1, 11_000_000 * ONE_TOKEN, 1, False, False, cfg),
                 sub("i1.testnet", 3, 600_000 * ONE_TOKEN, 0, True, True, cfg),
                 sub("i2.testnet", 3, 700_000 * ONE_TOKEN + 1, 3, True, False, cfg),
             ],
             reserve_before=ONE_NEAR // 3),
        case("zero-income",
             "No income: every pay is 0 and the operating cost is capped by the reserve.",
             0,
             [sub("d1.testnet", 0, 40_000_000 * ONE_TOKEN, 0, True, False, cfg)],
             reserve_before=ONE_NEAR // 20),
        case("u256-overflow",
             "1M NEAR income and a 90%-of-supply holder at max streak: bucket x weight "
             "exceeds 2^128, so implementations need 256-bit intermediates.",
             1_000_000 * ONE_NEAR,
             [
                 sub("whale.testnet", 0, 900_000_000 * ONE_TOKEN, 9, True, False, cfg),
                 sub("d2.testnet", 0, 100_000_000 * ONE_TOKEN - 1, 0, True, False, cfg),
             ],
             reserve_before=5 * ONE_NEAR),
    ]


def build():
    cfg = json.loads(CONFIG_PATH.read_text())
    pv = pay_vectors(cfg)

    # Sanity: the spec §5.3 worked example must hold exactly.
    def pays(i):
        return {p["account_id"]: int(p["pay"]) for p in pv[i]["expected"]["pays"]}

    assert pays(0) == {"intern-a.testnet": 9 * ONE_NEAR // 10,
                       "intern-b.testnet": 45 * ONE_NEAR // 100,
                       "intern-c.testnet": 45 * ONE_NEAR // 100}
    assert pays(1) == {"intern-a.testnet": 9 * ONE_NEAR // 10,
                       "intern-b.testnet": 0,
                       "intern-c.testnet": 45 * ONE_NEAR // 100}
    big = int(pv[4]["expected"]["buckets"][0]) * int(pv[4]["submissions"][0]["weight"])
    assert big >= 2**128, "u256-overflow vector no longer overflows u128"

    return {
        "version": 1,
        "generated_by": "protocol/gen_vectors.py",
        "spec": "docs/PROTOCOL.md",
        "constants": {
            "bps_denominator": BPS,
            "code_consonants": CONSONANTS,
            "code_vowels": VOWELS,
            "code_length": 8,
            "day_secret_bytes": 32,
            "ascii_whitespace": [ord(c) for c in ASCII_WS],
        },
        "config": cfg,
        "hmac_sha256": hmac_vectors(),
        "crypto": crypto_vectors(),
        "wallet_binding": wallet_binding_vectors(),
        "normalization": normalization_vectors(),
        "tier": {"thresholds_bps": cfg["tier_thresholds_bps"],
                 "cases": tier_vectors(cfg["tier_thresholds_bps"])},
        "multiplier": multiplier_vectors(cfg),
        "layoff": layoff_vectors(cfg),
        "status": status_vectors(cfg),
        "streak_update": streak_update_vectors(cfg),
        "antidump": antidump_vectors(cfg),
        "recycle": recycle_vectors(),
        "pay": pv,
    }


def main():
    text = json.dumps(build(), indent=2, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        current = VECTORS_PATH.read_text(encoding="utf-8") if VECTORS_PATH.exists() else ""
        if current != text:
            print("protocol/vectors.json is stale: run python3 protocol/gen_vectors.py",
                  file=sys.stderr)
            sys.exit(1)
        print("protocol/vectors.json is up to date")
        return
    VECTORS_PATH.write_text(text, encoding="utf-8")
    print(f"wrote {VECTORS_PATH}")


if __name__ == "__main__":
    main()
