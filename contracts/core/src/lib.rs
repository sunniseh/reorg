//! REORG rules, independent of any chain (docs/PROTOCOL.md is normative).
//!
//! Everything that decides an outcome lives here: commit-reveal and the answer hash
//! ([`crypto`]), tiers, layoffs, streaks and pay formulas ([`rules`], [`math`]), and the state
//! transitions for open / submit / finalize / claim / prove / deposit ([`engine`]). A chain
//! adapter supplies SHA-256, storage, balance reads and transfers, and publishes [`events`].
//! Wallet identity is an opaque string.

pub mod config;
pub mod crypto;
pub mod engine;
pub mod events;
pub mod math;
pub mod model;
pub mod rules;
pub mod views;
pub mod wire;

pub use config::Config;
pub use engine::Error;
pub use events::{Event, EventEntry};

/// Basis-point denominator.
pub const BPS: u128 = 10_000;

/// Parts-per-million denominator (tier thresholds, §6.1: finer than bps so the lowest tier can sit
/// below 0.01% of supply).
pub const PPM: u128 = 1_000_000;

/// Task id. Every "day" field holds a task id, never a calendar date (§2).
pub type TaskId = u64;
