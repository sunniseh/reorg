//! Roadmap C-17: the real token + contract on near-sdk sandbox.

mod common;

use anyhow::Result;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

fn pay_of(sub: &Value) -> u128 {
    big(&sub["pay"])
}

/// Happy path, spec §5.3 worked example, every submit rejection, finalize failures,
/// claims, double claim, anti-dump forfeit, views and the books invariant.
#[tokio::test]
async fn happy_path_rules_and_spec_example() -> Result<()> {
    let env = Env::new(json!({})).await?;
    // Interns of a 1e9 supply with the spec's 2:1:1 ratio.
    let a = env.player("a", 1_000_000).await?;
    let b = env.player("b", 500_000).await?;
    let c = env.player("c", 500_000).await?;
    let visitor = env.player("v", 100).await?;
    let recycler = env.player("r", 0).await?;
    env.deposit_income(20 * NEAR).await?;
    let t = env.open().await?;

    assert_eq!(env.submit_outcome(&a, &t, true).await?, json!({ "accepted": true, "reason": null }));
    assert_eq!(env.submit_outcome(&b, &t, false).await?["accepted"], true);
    assert_eq!(env.submit_outcome(&c, &t, true).await?["accepted"], true);

    // Rejections at submit time (panic) and in the balance callback (outcome).
    assert!(failure(env.submit(&a, &t, true).await?).contains("already submitted"));
    assert!(failure(env.submit(&env.deployer, &t, true).await?).contains("account is excluded"));
    let out = env.submit_outcome(&visitor, &t, true).await?;
    assert_eq!(out["reason"], "balance below the minimum tier (visitor)");
    // D15 recycle attack: a wallet that received tokens after the task opened.
    env.send_tokens(&env.deployer, &recycler, 1_000_000 * TOKEN).await?;
    let out = env.submit_outcome(&recycler, &t, true).await?;
    assert_eq!(out["reason"], "tokens received after the task opened (anti-recycling)");
    assert!(failure(env.finalize(&t, &[], true).await?).contains("task window has not closed yet"));

    env.close(&t).await?;
    assert_eq!(env.view("get_task", json!({ "task_id": t.id })).await?["status"], "closed");
    assert!(failure(env.submit(&c, &t, true).await?).contains("window is closed"));

    // Wrong secret; a wrong passer fails the whole call and changes nothing.
    assert!(failure(env.finalize_raw(t.id, &[0u8; 32], vec![], true).await?).contains("does not match the commit"));
    assert!(failure(env.finalize(&t, &[&a, &b], true).await?).contains("answer hash does not match"));
    assert_eq!(env.view("get_task", json!({ "task_id": t.id })).await?["status"], "closed");
    assert!(failure(env.finalize(&t, &[&a, &a], true).await?).contains("passer already verified"));

    // The boss recomputes passers from the stored hashes, like the boss service.
    let passers = env.passers(&t).await?;
    assert_eq!(passers, vec![a.id().to_string(), c.id().to_string()]);
    env.finalize_raw(t.id, &t.secret, passers, true).await?.into_result()?;
    assert!(failure(env.finalize(&t, &[], true).await?).contains("already finalized"));

    let task = env.view("get_task", json!({ "task_id": t.id })).await?;
    assert_eq!((task["status"].as_str(), task["submitted"].as_u64(), task["passed"].as_u64()), (Some("finalized"), Some(3), Some(2)));
    assert_eq!(task["allocation"]["settlement"]["runway_tasks"], Value::Null);
    let sub = |w: &near_workspaces::Account| env.view("get_submission", json!({ "task_id": t.id, "account_id": w.id() }));
    assert_eq!(pay_of(&sub(&a).await?), 9 * NEAR / 10);
    assert_eq!(pay_of(&sub(&b).await?), 0);
    assert_eq!(pay_of(&sub(&c).await?), 45 * NEAR / 100);
    let tre = env.view("get_treasury", json!({})).await?;
    assert_eq!(big(&tre["reserve"]), 20 * NEAR - 135 * NEAR / 100);
    assert_eq!(big(&tre["outstanding"]), 135 * NEAR / 100);
    env.assert_books_covered().await?;

    // Claims.
    let before = a.view_account().await?.balance.as_yoctonear();
    let res = env.claim(&a, t.id).await?;
    let burnt: u128 = res.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum();
    let gas = res.total_gas_burnt;
    let out: Value = res.into_result()?.json()?;
    assert_eq!(out, json!({ "status": "paid", "amount": (9 * NEAR / 10).to_string() }));
    env.worker.fast_forward(5).await?; // let the prepaid-gas refund land
    let gained = a.view_account().await?.balance.as_yoctonear() - before;
    assert!(gained + burnt >= 9 * NEAR / 10 - NEAR / 1000, "salary arrived: gained {gained}, burnt {burnt}, gas {gas}");
    assert!(failure(env.claim(&a, t.id).await?).contains("already claimed"));
    assert!(failure(env.claim(&b, t.id).await?).contains("not a paid passer"));
    // c sells 11% → below 90% of the snapshot → forfeit.
    env.send_tokens(&c, &visitor, 55_000 * TOKEN).await?;
    let out: Value = env.claim(&c, t.id).await?.into_result()?.json()?;
    assert_eq!(out["status"], "forfeited");
    let tre = env.view("get_treasury", json!({})).await?;
    assert_eq!(big(&tre["reserve"]), 20 * NEAR - 9 * NEAR / 10);
    assert_eq!(big(&tre["outstanding"]), 0);
    assert_eq!(big(&tre["total_paid"]), 9 * NEAR / 10);
    assert_eq!(big(&tre["total_forfeited"]), 45 * NEAR / 100);
    env.assert_books_covered().await?;

    // Views.
    let ea = env.view("get_employee", json!({ "account_id": a.id() })).await?;
    assert_eq!(ea["status"], "active");
    assert_eq!(ea["effective_streak"], 1);
    assert_eq!(big(&ea["total_earned"]), 9 * NEAR / 10);
    assert_eq!(ea["recent"], json!([{ "task_id": 1, "result": "pass" }]));
    let eb = env.view("get_employee", json!({ "account_id": b.id() })).await?;
    assert_eq!(eb["status"], "struggling");
    assert_eq!(eb["recent"], json!([{ "task_id": 1, "result": "fail" }]));
    assert_eq!(env.view("list_employees", json!({})).await?.as_array().unwrap().len(), 3);
    assert_eq!(env.view("get_employee", json!({ "account_id": visitor.id() })).await?, Value::Null);

    // Event feed: every kind seen in order, gapless seqs.
    let events = env.events().await?;
    let names: Vec<&str> = events.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "income_deposited", "task_opened", "submission_received", "submission_received", "submission_received",
            "payroll_allocated", "task_finalized", "salary_paid", "salary_forfeited",
        ]
    );
    assert!(events.iter().enumerate().all(|(i, e)| e["seq"] == i as u64 + 1));
    assert_eq!(events[6]["data"]["day_secret"], b64(&t.secret));
    Ok(())
}

/// Two submits from the same wallet in flight together: exactly one is recorded.
#[tokio::test]
async fn double_submit_in_flight() -> Result<()> {
    let env = Env::new(json!({})).await?;
    let a = env.player("a", 1_000_000).await?;
    let t = env.open().await?;
    let (r1, r2) = tokio::join!(env.submit(&a, &t, true), env.submit(&a, &t, true));
    let accepted = [r1?, r2?]
        .into_iter()
        .filter(|r| r.is_success() && r.clone().json::<Value>().map(|v| v["accepted"] == true).unwrap_or(false))
        .count();
    assert_eq!(accepted, 1);
    assert_eq!(env.view("list_submissions", json!({ "task_id": t.id })).await?.as_array().unwrap().len(), 1);
    Ok(())
}

/// D4/D5 layoff → reapply → rehired, D17 prove_pass after censorship, prove window.
#[tokio::test]
async fn layoff_rehire_and_prove_pass() -> Result<()> {
    let env = Env::new(json!({ "layoff_after": 1, "layoff_len": 2 })).await?;
    let f = env.player("f", 1_000_000).await?;
    let x = env.player("x", 1_000_000).await?;
    let status = |w: &near_workspaces::Account| env.view("get_employee", json!({ "account_id": w.id() }));

    // Task 1: both pass.
    env.deposit_income(NEAR).await?;
    let t1 = env.open().await?;
    env.submit_outcome(&f, &t1, true).await?;
    env.submit_outcome(&x, &t1, true).await?;
    env.close(&t1).await?;
    env.finalize(&t1, &[&f, &x], true).await?.into_result()?;

    // Task 2: f misses → laid off (A = 1).
    let t2 = env.open().await?;
    env.submit_outcome(&x, &t2, true).await?;
    env.close(&t2).await?;
    env.finalize(&t2, &[&x], true).await?.into_result()?;
    let sf = status(&f).await?;
    assert_eq!((sf["status"].as_str(), sf["layoff_tasks_left"].as_u64()), (Some("laid_off"), Some(2)));

    // Task 3: f reapplies and passes → rehired, unpaid. x passes too.
    env.deposit_income(NEAR).await?;
    let t3 = env.open().await?;
    env.submit_outcome(&f, &t3, true).await?;
    env.submit_outcome(&x, &t3, true).await?;
    let s3 = env.view("get_submission", json!({ "task_id": t3.id, "account_id": f.id() })).await?;
    assert_eq!(s3["reapply"], true);
    env.close(&t3).await?;
    env.finalize(&t3, &[&f], false).await?.into_result()?; // batches: f, then x + settle
    env.finalize(&t3, &[&x], true).await?.into_result()?;
    let sf = status(&f).await?;
    assert_eq!((sf["status"].as_str(), sf["badges"].as_u64()), (Some("active"), Some(1)));
    assert!(failure(env.claim(&f, t3.id).await?).contains("not a paid passer"));
    // x took the whole Intern bucket (f's reapply carries no weight).
    let task3 = env.view("get_task", json!({ "task_id": t3.id })).await?;
    let x3 = env.view("get_submission", json!({ "task_id": t3.id, "account_id": x.id() })).await?;
    assert_eq!(big(&x3["pay"]), big(&task3["allocation"]["buckets"][3]));
    assert!(env.events().await?.iter().any(|e| e["event"] == "rehired" && e["data"]["account_id"] == f.id().as_str()));
    assert!(env.events().await?.iter().any(|e| e["event"] == "streak_milestone" && e["data"]["streak"] == 3));

    // Task 4: the boss censors x; x proves its own pass; f's proof comes too late.
    env.deposit_income(NEAR).await?;
    let t4 = env.open().await?;
    env.submit_outcome(&x, &t4, true).await?;
    env.submit_outcome(&f, &t4, true).await?;
    env.close(&t4).await?;
    env.finalize(&t4, &[], true).await?.into_result()?;
    let reserve_before = big(&env.view("get_treasury", json!({})).await?["reserve"]);
    let pay: Value = x
        .call(env.reorg.id(), "prove_pass")
        .args_json(json!({ "task_id": t4.id }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let pay = big(&pay);
    assert!(pay > 0);
    assert_eq!(big(&env.view("get_treasury", json!({})).await?["reserve"]), reserve_before - pay);
    assert_eq!(big(&env.view("get_claimable", json!({ "task_id": t4.id, "account_id": x.id() })).await?), pay);
    assert_eq!(env.claim(&x, t4.id).await?.into_result()?.json::<Value>()?["status"], "paid");
    env.assert_books_covered().await?;

    let t5 = env.open().await?;
    env.close(&t5).await?;
    env.finalize(&t5, &[], true).await?.into_result()?;
    let late = f.call(env.reorg.id(), "prove_pass").args_json(json!({ "task_id": t4.id })).transact().await?;
    assert!(failure(late).contains("prove_pass window is closed"));
    Ok(())
}

/// D10 operating cost to the boss, reserve_low, runway, admin, total supply refresh.
#[tokio::test]
async fn operating_cost_admin_and_supply() -> Result<()> {
    let env = Env::new(json!({ "operating_cost": (NEAR / 10).to_string(), "reserve_low": (2 * NEAR).to_string() })).await?;
    env.deposit_income(NEAR).await?;
    let boss_before = env.boss.view_account().await?.balance.as_yoctonear();
    let t = env.open().await?;
    env.close(&t).await?;
    env.finalize(&t, &[], true).await?.into_result()?;
    let tre = env.view("get_treasury", json!({})).await?;
    assert_eq!(big(&tre["reserve"]), NEAR - NEAR / 10);
    assert_eq!(big(&tre["total_operating_cost"]), NEAR / 10);
    assert_eq!(tre["runway_tasks"], 9, "0.9 NEAR reserve / 0.1 NEAR per task");
    env.worker.fast_forward(5).await?; // let the prepaid-gas refund land
    let boss_after = env.boss.view_account().await?.balance.as_yoctonear();
    assert!(boss_after + NEAR / 100 > boss_before + NEAR / 10, "operator received the cost (minus gas)");
    let names: Vec<Value> = env.events().await?.into_iter().map(|e| e["event"].clone()).collect();
    assert!(names.contains(&json!("reserve_low")));
    env.assert_books_covered().await?;

    // Admin is owner-only; refresh_total_supply reads the token.
    let r = env.boss.call(env.reorg.id(), "set_boss").args_json(json!({ "boss": env.boss.id() })).transact().await?;
    assert!(failure(r).contains("owner only"));
    let supply: Value = env.root.call(env.reorg.id(), "refresh_total_supply").gas(MAX_GAS).transact().await?.into_result()?.json()?;
    assert_eq!(big(&supply), SUPPLY);
    let info = env.view("get_info", json!({})).await?;
    assert_eq!((info["last_finalized"].as_u64(), info["current_task_id"].as_u64()), (Some(1), Some(1)));

    // Token extension views (D16): the deployer and nobody else holds tokens yet.
    let holders: Value = env.token.view("ft_holders").args_json(json!({})).await?.json()?;
    assert_eq!(holders.as_array().unwrap().len(), 1);
    let _ = NearToken::from_near(0);
    Ok(())
}
