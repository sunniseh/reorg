//! `protocol/vectors.json` (PROTOCOL.md §9), loaded directly. Never copy values out of it.

use reorg_core::crypto::*;
use reorg_core::engine;
use reorg_core::model::*;
use reorg_core::rules::*;
use reorg_core::wire::b64;
use reorg_core::{Config, Event};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../protocol/vectors.json")).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn big(v: &Value) -> u128 {
    v.as_str().expect("decimal string").parse().unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

const H: SoftSha256 = SoftSha256;

#[test]
fn config_default_matches_protocol() {
    let v = vectors();
    let cfg: Config = serde_json::from_value(v["config"].clone()).unwrap();
    assert_eq!(cfg, Config::default());
    cfg.validate().unwrap();
    let file: Config = serde_json::from_str(include_str!("../../../protocol/config.default.json")).unwrap();
    assert_eq!(file, cfg);
    // JSON round trip keeps the exact wire encoding.
    let back = serde_json::to_value(&cfg).unwrap();
    assert_eq!(back, v["config"]);
}

#[test]
fn constants_match() {
    let c = &vectors()["constants"];
    assert_eq!(num(&c["bps_denominator"]) as u128, reorg_core::BPS);
    assert_eq!(c["code_consonants"].as_str().unwrap().as_bytes(), CONSONANTS);
    assert_eq!(c["code_vowels"].as_str().unwrap().as_bytes(), VOWELS);
    assert_eq!(num(&c["code_length"]) as usize, CODE_LEN);
    assert_eq!(num(&c["day_secret_bytes"]) as usize, DAY_SECRET_LEN);
}

#[test]
fn hmac_rfc4231() {
    for case in vectors()["hmac_sha256"].as_array().unwrap() {
        let mac = hmac_sha256(&H, &unhex(case["key_hex"].as_str().unwrap()), &unhex(case["msg_hex"].as_str().unwrap()));
        assert_eq!(hex(&mac), case["hmac_hex"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn crypto_vectors() {
    let v = vectors();
    let cases = v["crypto"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let secret: [u8; 32] = unhex(c["day_secret_hex"].as_str().unwrap()).try_into().unwrap();
        let wallet = c["wallet"].as_str().unwrap();
        assert_eq!(b64::encode(&secret), c["day_secret_b64"].as_str().unwrap(), "{name}");

        let commit = H.sha256(&secret);
        assert_eq!(hex(&commit), c["commit_hash_hex"].as_str().unwrap(), "{name}");
        assert_eq!(b64::encode(&commit), c["commit_hash_b64"].as_str().unwrap(), "{name}");
        assert!(commit_matches(&H, &secret, &commit));
        assert!(!commit_matches(&H, &secret[..31], &commit));

        assert_eq!(hex(&hmac_sha256(&H, &secret, wallet.as_bytes())), c["hmac_hex"].as_str().unwrap(), "{name}");
        let code = derive_code(&H, &secret, wallet);
        assert_eq!(std::str::from_utf8(&code).unwrap(), c["code"].as_str().unwrap(), "{name}");

        let ah = expected_answer_hash(&H, &secret, wallet);
        assert_eq!(hex(&ah), c["answer_hash_hex"].as_str().unwrap(), "{name}");
        assert_eq!(b64::encode(&ah), c["answer_hash_b64"].as_str().unwrap(), "{name}");
        // A submitter typing the code in lowercase with spaces still matches after norm().
        let typed = format!("  {} ", std::str::from_utf8(&code).unwrap().to_lowercase());
        assert_eq!(answer_hash(&H, normalize(&typed).as_bytes(), wallet), ah);
    }
}

#[test]
fn wallet_binding() {
    let v = vectors();
    let cases = v["wallet_binding"].as_array().unwrap();
    for c in cases {
        let h = answer_hash(&H, c["answer"].as_str().unwrap().as_bytes(), c["wallet"].as_str().unwrap());
        assert_eq!(hex(&h), c["answer_hash_hex"].as_str().unwrap());
    }
    assert_ne!(cases[0]["answer_hash_hex"], cases[1]["answer_hash_hex"]);
}

#[test]
fn normalization() {
    for c in vectors()["normalization"].as_array().unwrap() {
        assert_eq!(normalize(c["input"].as_str().unwrap()), c["output"].as_str().unwrap(), "{}", c["note"]);
    }
}

#[test]
fn tiers() {
    let v = vectors();
    let thresholds: [u32; 4] = serde_json::from_value(v["tier"]["thresholds_ppm"].clone()).unwrap();
    for c in v["tier"]["cases"].as_array().unwrap() {
        let got = tier_of(big(&c["balance"]), big(&c["total_supply"]), &thresholds);
        let want = c["tier"].as_u64().map(|t| t as Tier);
        assert_eq!(got, want, "{}", c["note"]);
    }
    assert_eq!(tier_of(1, 0, &thresholds), None, "zero supply is never a tier");
}

#[test]
fn multiplier() {
    let cfg = Config::default();
    for c in vectors()["multiplier"].as_array().unwrap() {
        assert_eq!(multiplier_bps(num(&c["streak_before"]) as u32, &cfg) as u64, num(&c["multiplier_bps"]));
    }
}

fn status_str(s: EmployeeStatus) -> &'static str {
    match s {
        EmployeeStatus::Active => "active",
        EmployeeStatus::Struggling => "struggling",
        EmployeeStatus::LaidOff => "laid_off",
    }
}

fn check_state(st: &EmployeeState, c: &Value, note: &str) {
    assert_eq!(status_str(st.status), c["status"].as_str().unwrap(), "{note}");
    assert_eq!(st.laid_off, c["laid_off"].as_bool().unwrap(), "{note}");
    assert_eq!(st.layoff_tasks_left, num(&c["layoff_tasks_left"]), "{note}");
    assert_eq!(st.misses_in_row, num(&c["misses_in_row"]), "{note}");
}

#[test]
fn layoff_table() {
    for c in vectors()["layoff"].as_array().unwrap() {
        let (a, l, gap) = (num(&c["layoff_after"]) as u32, num(&c["layoff_len"]) as u32, num(&c["gap"]));
        // Same construction as gen_vectors.py: a pass at task 100, or a never-passed joiner.
        let (emp, last_finalized) = if l == 7 {
            (Employee { last_pass_day: Some(100), streak: 5, ..Employee::new(0) }, 100 + gap)
        } else {
            (Employee::new(0), gap)
        };
        let st = employee_state(&emp, last_finalized, a, l);
        assert_eq!(st.gap, gap);
        check_state(&st, c, &format!("A={a} L={l} gap={gap}"));
    }
}

#[test]
fn status_derivation() {
    let cfg = Config::default();
    for c in vectors()["status"].as_array().unwrap() {
        let note = c["note"].as_str().unwrap();
        let emp = Employee {
            last_pass_day: c["last_pass_day"].as_u64(),
            streak: num(&c["stored_streak"]) as u32,
            ..Employee::new(num(&c["joined_after"]))
        };
        let st = employee_state(&emp, num(&c["last_finalized"]), cfg.layoff_after, cfg.layoff_len);
        check_state(&st, c, note);
        assert_eq!(st.gap, num(&c["gap"]), "{note}");
        assert_eq!(st.effective_streak as u64, num(&c["effective_streak"]), "{note}");
    }
}

#[test]
fn streak_update() {
    let cfg = Config::default();
    for c in vectors()["streak_update"].as_array().unwrap() {
        let new = streak_after_pass(num(&c["task_id"]), c["last_pass_day"].as_u64(), num(&c["stored_streak"]) as u32);
        assert_eq!(new as u64, num(&c["new_streak"]), "{}", c["note"]);
        assert_eq!(cfg.streak_milestones.contains(&new), c["milestone"].as_bool().unwrap());
    }
}

#[test]
fn antidump() {
    for c in vectors()["antidump"].as_array().unwrap() {
        let ok = claim_allowed(big(&c["current_balance"]), big(&c["snapshot_balance"]), num(&c["antidump_bps"]) as u16);
        assert_eq!(ok, c["claim_allowed"].as_bool().unwrap(), "{}", c["note"]);
    }
}

#[test]
fn recycle() {
    for c in vectors()["recycle"].as_array().unwrap() {
        let last = c["last_received_at"].as_str().map(|s| s.parse::<u64>().unwrap()).unwrap_or(0);
        let opens = c["opens_at"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(received_before(last, opens), c["submission_allowed"].as_bool().unwrap(), "{}", c["note"]);
    }
}

/// Runs every pay vector through the real engine path: begin_finalize → verify_passer (in
/// batches of 2) → settle, and compares every allocation field and every pay.
#[test]
fn pay_through_engine() {
    let v = vectors();
    let secret = [9u8; 32];
    for case in v["pay"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut cfg: Config = serde_json::from_value(v["config"].clone()).unwrap();
        let pc = &case["config"];
        cfg.payroll_bps = num(&pc["payroll_bps"]) as u16;
        cfg.reserve_bps = num(&pc["reserve_bps"]) as u16;
        cfg.jackpot_bps = num(&pc["jackpot_bps"]) as u16;
        cfg.tier_bucket_bps = serde_json::from_value(pc["tier_bucket_bps"].clone()).unwrap();
        cfg.operating_cost = big(&pc["operating_cost"]);
        cfg.reserve_low = big(&pc["reserve_low"]);
        cfg.validate().unwrap();

        let exp = &case["expected"];
        let mut treasury = Treasury { reserve: big(&exp["reserve_before"]), income_accrued: big(&exp["income"]), ..Default::default() };
        let mut task = Task {
            id: 1,
            kind: TaskKind::DecodeMemo,
            commit_hash: H.sha256(&secret),
            opens_at: 1,
            closes_at: 100,
            status: TaskStatus::Open,
            day_secret: None,
            submitted: 0,
            passed: 0,
            tier_submitted_weight: [0; 4],
            tier_passed_weight: [0; 4],
            allocation: None,
            finalized_at: None,
        };

        let mut subs = Vec::new();
        for s in case["submissions"].as_array().unwrap() {
            let wallet = s["account_id"].as_str().unwrap().to_string();
            let (tier, weight, reapply, passed) =
                (num(&s["tier"]) as u8, big(&s["weight"]), s["reapply"].as_bool().unwrap(), s["passed"].as_bool().unwrap());
            if !reapply {
                task.tier_submitted_weight[tier as usize] += weight;
            }
            task.submitted += 1;
            let answer = if passed { expected_answer_hash(&H, &secret, &wallet) } else { [0; 32] };
            let sub = Submission {
                answer_hash: answer,
                balance: big(&s["balance"]),
                tier,
                streak_before: num(&s["streak_before"]) as u32,
                multiplier_bps: num(&s["multiplier_bps"]) as u32,
                weight,
                submitted_at: 2,
                reapply,
                passed: false,
                pay: 0,
                claim: ClaimState::Unclaimed,
            };
            subs.push((wallet, sub, Employee::new(0), passed));
        }

        let mut events = Vec::new();
        assert_eq!(engine::begin_finalize(&H, &cfg, &mut task, &mut treasury, &secret, 99), Err(engine::Error::TaskStillOpen));
        engine::begin_finalize(&H, &cfg, &mut task, &mut treasury, &secret, 100).unwrap();
        assert_eq!(treasury.income_accrued, 0, "{name}: income snapshotted on the first call");

        let passers: Vec<usize> = (0..subs.len()).filter(|&i| subs[i].3).collect();
        for batch in passers.chunks(2) {
            engine::begin_finalize(&H, &cfg, &mut task, &mut treasury, &secret, 200).unwrap();
            for &i in batch {
                let (w, s, e, _) = &mut subs[i];
                engine::verify_passer(&H, &cfg, &mut task, w, s, e, &mut events).unwrap();
            }
        }
        // A failed submitter listed as a passer must fail the call.
        if let Some(i) = (0..subs.len()).find(|&i| !subs[i].3) {
            let (w, s, e, _) = &mut subs[i];
            assert_eq!(engine::verify_passer(&H, &cfg, &mut task, w, s, e, &mut events), Err(engine::Error::WrongAnswer));
        }
        let op_paid = engine::settle(&cfg, &mut task, &mut treasury, 300, &mut events).unwrap();

        let a = task.allocation.as_ref().unwrap();
        let s = a.settlement.as_ref().unwrap();
        let d4 = |k: &str| -> [u128; 4] { serde_json::from_value::<[String; 4]>(exp[k].clone()).unwrap().map(|x| x.parse().unwrap()) };
        assert_eq!(a.income, big(&exp["income"]), "{name}");
        assert_eq!(a.payroll, big(&exp["payroll"]), "{name}");
        assert_eq!(a.jackpot, big(&exp["jackpot"]), "{name}");
        assert_eq!(a.reserve_share, big(&exp["reserve_share"]), "{name}");
        assert_eq!(a.buckets, d4("buckets"), "{name}");
        assert_eq!(a.payroll_dust, big(&exp["payroll_dust"]), "{name}");
        assert_eq!(task.tier_submitted_weight, d4("tier_submitted_weight"), "{name}");
        assert_eq!(task.tier_passed_weight, d4("tier_passed_weight"), "{name}");
        assert_eq!(a.tier_payable, d4("tier_payable"), "{name}");
        assert_eq!(s.to_reserve, big(&exp["to_reserve"]), "{name}");
        assert_eq!(op_paid, big(&exp["operating_cost_paid"]), "{name}");
        assert_eq!(s.reserve_after, big(&exp["reserve_after"]), "{name}");
        assert_eq!(treasury.reserve, big(&exp["reserve_after"]), "{name}");
        assert_eq!(s.runway_tasks, exp["runway_tasks"].as_u64(), "{name}");
        assert_eq!(a.total_payable() + s.to_reserve, a.income, "{name}: income fully accounted");
        assert_eq!(treasury.outstanding, a.total_payable(), "{name}");

        for (p, (w, sub, _, _)) in exp["pays"].as_array().unwrap().iter().zip(&subs) {
            assert_eq!(p["account_id"].as_str().unwrap(), w);
            assert_eq!(sub.pay, big(&p["pay"]), "{name}: pay of {w}");
        }
        let low = events.iter().any(|e| matches!(e, Event::ReserveLow { .. }));
        assert_eq!(low, exp["reserve_low"].as_bool().unwrap(), "{name}");
        assert_eq!(task.status, TaskStatus::Finalized);
    }
}
