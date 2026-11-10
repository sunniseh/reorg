//! Contract configuration (PROTOCOL.md §10). Mirrors `packages/core/src/config.ts`:
//! same keys, same JSON encoding, same validation.

use crate::wire::dec;
use crate::{BPS, PPM};
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub tier_thresholds_ppm: [u32; 4],
    pub tier_bucket_bps: [u16; 4],
    pub payroll_bps: u16,
    pub reserve_bps: u16,
    pub jackpot_bps: u16,
    pub streak_step_bps: u16,
    pub streak_max_steps: u8,
    pub streak_milestones: Vec<u32>,
    pub layoff_after: u32,
    pub layoff_len: u32,
    pub antidump_bps: u16,
    pub bankruptcy_empty_tasks: u32,
    #[serde(with = "dec")]
    pub operating_cost: u128,
    #[serde(with = "dec")]
    pub reserve_low: u128,
    #[serde(with = "dec")]
    pub min_window_ns: u64,
    pub max_passers_per_call: u32,
    /// Opaque wallet ids that are never employees (deployer, contract, treasury/LP, crowd root).
    pub excluded_accounts: Vec<String>,
}

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

impl Default for Config {
    /// Same values as `protocol/config.default.json` (checked by a test).
    fn default() -> Self {
        Self {
            tier_thresholds_ppm: [30_000, 10_000, 2_500, 10],
            tier_bucket_bps: [3500, 3000, 2000, 1500],
            payroll_bps: 6000,
            reserve_bps: 3000,
            jackpot_bps: 1000,
            streak_step_bps: 1000,
            streak_max_steps: 5,
            streak_milestones: vec![3, 7, 14],
            layoff_after: 3,
            layoff_len: 7,
            antidump_bps: 9000,
            bankruptcy_empty_tasks: 3,
            operating_cost: ONE_NEAR / 10,
            reserve_low: ONE_NEAR,
            min_window_ns: 3_600_000_000_000,
            max_passers_per_call: 50,
            excluded_accounts: Vec::new(),
        }
    }
}

impl Config {
    /// Validation shared with the TS `ConfigSchema`. Returns the first violated rule.
    pub fn validate(&self) -> Result<(), &'static str> {
        let bps = BPS as u32;
        let scalars = [self.payroll_bps, self.reserve_bps, self.jackpot_bps, self.streak_step_bps, self.antidump_bps];
        let mut all_bps = self.tier_bucket_bps.iter().chain(&scalars);
        if all_bps.any(|&v| v as u32 > bps) {
            return Err("config: every bps value must be <= 10000");
        }
        let t = &self.tier_thresholds_ppm;
        if t.iter().any(|&v| v as u128 > PPM) {
            return Err("config: tier_thresholds_ppm must be <= 1000000");
        }
        if t.contains(&0) || t.windows(2).any(|w| w[0] <= w[1]) {
            return Err("config: tier_thresholds_ppm must be > 0 and strictly descending");
        }
        if self.tier_bucket_bps.iter().map(|&x| x as u32).sum::<u32>() != bps {
            return Err("config: tier_bucket_bps must sum to 10000");
        }
        if self.payroll_bps as u32 + self.reserve_bps as u32 + self.jackpot_bps as u32 != bps {
            return Err("config: payroll_bps + reserve_bps + jackpot_bps must equal 10000");
        }
        let m = &self.streak_milestones;
        if m.contains(&0) || m.windows(2).any(|w| w[0] >= w[1]) {
            return Err("config: streak_milestones must be > 0 and strictly ascending");
        }
        if self.layoff_after == 0 {
            return Err("config: layoff_after must be >= 1");
        }
        if self.max_passers_per_call == 0 {
            return Err("config: max_passers_per_call must be >= 1");
        }
        if self.min_window_ns == 0 {
            return Err("config: min_window_ns must be > 0");
        }
        if self.excluded_accounts.iter().any(String::is_empty) {
            return Err("config: excluded_accounts entries must be non-empty");
        }
        Ok(())
    }

    pub fn is_excluded(&self, wallet: &str) -> bool {
        self.excluded_accounts.iter().any(|a| a == wallet)
    }

    /// Adds or removes wallets from `excluded_accounts` (deduplicated, order kept).
    pub fn set_excluded(&mut self, wallets: &[String], excluded: bool) {
        for w in wallets {
            let present = self.is_excluded(w);
            if excluded && !present {
                self.excluded_accounts.push(w.clone());
            } else if !excluded && present {
                self.excluded_accounts.retain(|a| a != w);
            }
        }
    }
}
