//! Roadmap C-18: gas with 100 sandbox accounts. Prints a table for ROADMAP §8.4 and asserts
//! that `finalize_task` at `max_passers_per_call` (50) stays well under the 300 Tgas cap.
//! Run with `cargo test -p reorg-integration-tests --test gas -- --nocapture` to see it.

mod common;

use anyhow::Result;
use common::*;
use futures::future::try_join_all;
use near_workspaces::Account;
use serde_json::{json, Value};

const PLAYERS: usize = 100;
const CHUNK: usize = 20;

/// 10 Directors, 20 Managers, 30 Associates, 40 Interns (whole tokens, 1e9 supply).
fn tokens_for(i: usize) -> u128 {
    match i {
        0..=9 => 31_000_000,
        10..=29 => 11_000_000,
        30..=59 => 3_000_000,
        _ => 600_000,
    }
}

fn tgas(g: u64) -> f64 {
    g as f64 / 1e12
}

fn row(name: &str, gas: &[u64]) {
    let min = gas.iter().min().copied().unwrap_or(0);
    let max = gas.iter().max().copied().unwrap_or(0);
    let avg = gas.iter().sum::<u64>() / gas.len().max(1) as u64;
    // Burnt-gas cost at the minimum gas price (1e8 yocto/gas = 0.0001 NEAR per Tgas).
    println!(
        "| {name:<34} | {:>3} | {:>7.2} | {:>7.2} | {:>7.2} | {:>8.5} |",
        gas.len(),
        tgas(min),
        tgas(avg),
        tgas(max),
        tgas(avg) * 0.0001
    );
}

#[tokio::test]
async fn gas_with_100_accounts() -> Result<()> {
    let env = Env::new(json!({ "operating_cost": (NEAR / 10).to_string() })).await?;

    let mut players: Vec<Account> = Vec::with_capacity(PLAYERS);
    for chunk in (0..PLAYERS).collect::<Vec<_>>().chunks(CHUNK) {
        let names: Vec<String> = chunk.iter().map(|i| format!("c{:03}", i + 1)).collect();
        let created = try_join_all(names.iter().map(|n| sub(&env.root, n, 5))).await?;
        try_join_all(created.iter().map(|a| env.register(a))).await?;
        players.extend(created);
    }
    // Same signer (deployer) for every transfer: send sequentially to keep nonces simple.
    for (i, p) in players.iter().enumerate() {
        env.send_tokens(&env.deployer, p, tokens_for(i) * TOKEN).await?;
    }
    env.deposit_income(50 * NEAR).await?;
    let t = env.open().await?;

    let mut submit_gas = Vec::new();
    for chunk in players.chunks(CHUNK) {
        let results = try_join_all(chunk.iter().map(|p| env.submit(p, &t, true))).await?;
        for r in results {
            submit_gas.push(r.total_gas_burnt.as_gas());
            assert_eq!(r.into_result()?.json::<Value>()?["accepted"], true);
        }
    }
    env.close(&t).await?;

    let passers = env.passers(&t).await?;
    assert_eq!(passers.len(), PLAYERS);
    let mut finalize = Vec::new();
    for (batch, last) in [(&passers[0..25], false), (&passers[25..50], false), (&passers[50..100], true)] {
        let r = env.finalize_raw(t.id, &t.secret, batch.to_vec(), last).await?;
        finalize.push((batch.len(), last, r.total_gas_burnt.as_gas()));
        r.into_result()?;
    }

    let mut claim_gas = Vec::new();
    for chunk in players[..40].chunks(CHUNK) {
        let results = try_join_all(chunk.iter().map(|p| env.claim(p, t.id))).await?;
        for r in results {
            claim_gas.push(r.total_gas_burnt.as_gas());
            assert_eq!(r.into_result()?.json::<Value>()?["status"], "paid");
        }
    }
    env.assert_books_covered().await?;

    println!("\nC-18 gas (near-sandbox, {PLAYERS} accounts, all four tiers)");
    println!("| operation                          |   n | min Tgas| avg Tgas| max Tgas| avg NEAR |");
    println!("|------------------------------------|-----|---------|---------|---------|----------|");
    row("submit + ft_holder_info + on_balance", &submit_gas);
    for (n, last, g) in &finalize {
        row(&format!("finalize_task {n} passers{}", if *last { " + settle" } else { "" }), &[*g]);
    }
    row("claim_salary (read + transfer + cb)", &claim_gas);
    let storage = env.reorg.view_account().await?.storage_usage;
    println!("contract storage after 100 submissions: {storage} bytes");

    let (_, _, g50) = finalize[2];
    assert!(tgas(g50) < 200.0, "finalize at 50 passers must leave headroom under 300 Tgas, got {:.1}", tgas(g50));
    Ok(())
}
