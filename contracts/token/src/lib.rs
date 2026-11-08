//! $REORG fungible token (roadmap C-01).
//!
//! Standard NEP-141 (core + `ft_transfer_call`), NEP-145 (storage management) and NEP-148
//! (metadata), plus the extension views the REORG contract and the tower need:
//! - `last_received_at` per account, set on every inbound credit: transfer, refund, mint (D15);
//! - an iterable holder set: in when the balance becomes > 0, out at 0 (D16);
//! - `ft_holder_info`, `ft_holders`, `ft_holders_count`.
//!
//! Each account is a single record `{balance, last_received_at, holder_slot}`, so a transfer
//! is one read and one write per side; the holder set is a vector with O(1) swap-remove.
//! Fixed supply, minted once to the owner at `new`.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LazyOption, LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, log, near, require, serde_json, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};

const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(30);
/// Longest JSON a receiver may return from `ft_on_transfer` (u128::MAX as a string).
const MAX_RESULT_LEN: usize = 42;
/// Page size cap for `ft_holders`.
const MAX_PAGE: u32 = 200;

#[derive(BorshStorageKey)]
#[near]
enum Prefix {
    Accounts,
    Holders,
    Metadata,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
struct Account {
    balance: u128,
    /// Block timestamp (ns) of the last inbound credit. 0 = never credited.
    last_received_at: u64,
    /// Index + 1 in `holders`; 0 = not a holder (balance is 0).
    holder_slot: u32,
}

#[near(serializers = [json])]
pub struct HolderInfo {
    pub balance: U128,
    pub last_received_at: U64,
}

#[near(serializers = [json])]
pub struct HolderEntry {
    pub account_id: AccountId,
    pub balance: U128,
    pub last_received_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    accounts: LookupMap<AccountId, Account>,
    holders: Vector<AccountId>,
    total_supply: u128,
    /// Storage bytes one registered account costs (record + holder-set entry).
    account_storage_usage: u64,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Token {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        require!(total_supply.0 > 0, "total supply must be positive");
        let mut this = Self {
            accounts: LookupMap::new(Prefix::Accounts),
            holders: Vector::new(Prefix::Holders),
            total_supply: 0,
            account_storage_usage: 0,
            metadata: LazyOption::new(Prefix::Metadata, Some(metadata)),
        };
        this.measure_account_storage_usage();
        this.accounts.insert(owner_id.clone(), Account::default());
        this.credit(&owner_id, total_supply.0);
        this.total_supply = total_supply.0;
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("initial supply") }.emit();
        this
    }

    // ------------------------------------------------------------ extension views (D15, D16)

    /// Balance and last inbound credit time. Unknown accounts return zeros.
    pub fn ft_holder_info(&self, account_id: AccountId) -> HolderInfo {
        let a = self.accounts.get(&account_id).copied().unwrap_or_default();
        HolderInfo { balance: U128(a.balance), last_received_at: U64(a.last_received_at) }
    }

    /// Holders with a positive balance, in holder-set order (stable except for swap-removes).
    pub fn ft_holders(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<HolderEntry> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
        let end = from.saturating_add(limit).min(self.holders.len());
        (from..end)
            .filter_map(|i| {
                let id = self.holders.get(i)?;
                let a = self.accounts.get(id)?;
                Some(HolderEntry {
                    account_id: id.clone(),
                    balance: U128(a.balance),
                    last_received_at: U64(a.last_received_at),
                })
            })
            .collect()
    }

    pub fn ft_holders_count(&self) -> u32 {
        self.holders.len()
    }
}

// ---------------------------------------------------------------- internals

impl Token {
    fn measure_account_storage_usage(&mut self) {
        let before = env::storage_usage();
        let tmp: AccountId = "a".repeat(64).parse().unwrap();
        self.accounts.insert(tmp.clone(), Account { balance: u128::MAX, last_received_at: u64::MAX, holder_slot: u32::MAX });
        self.holders.push(tmp.clone());
        self.accounts.flush();
        self.holders.flush();
        self.account_storage_usage = env::storage_usage() - before;
        self.accounts.remove(&tmp);
        self.holders.pop();
        self.accounts.flush();
        self.holders.flush();
    }

    fn account(&self, id: &AccountId) -> Account {
        *self
            .accounts
            .get(id)
            .unwrap_or_else(|| env::panic_str(&format!("The account {id} is not registered")))
    }

    /// Inbound credit: balance up, `last_received_at = now`, join the holder set.
    fn credit(&mut self, id: &AccountId, amount: u128) {
        let mut a = self.account(id);
        a.balance = a.balance.checked_add(amount).unwrap_or_else(|| env::panic_str("Balance overflow"));
        a.last_received_at = env::block_timestamp();
        if a.holder_slot == 0 && a.balance > 0 {
            self.holders.push(id.clone());
            a.holder_slot = self.holders.len();
        }
        self.accounts.insert(id.clone(), a);
    }

    /// Outbound debit: balance down, leave the holder set at 0.
    fn debit(&mut self, id: &AccountId, amount: u128) {
        let mut a = self.account(id);
        a.balance = a
            .balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("The account doesn't have enough balance"));
        if a.balance == 0 {
            self.remove_holder(&mut a);
        }
        self.accounts.insert(id.clone(), a);
    }

    fn remove_holder(&mut self, a: &mut Account) {
        if a.holder_slot == 0 {
            return;
        }
        let idx = a.holder_slot - 1;
        let last = self.holders.len() - 1;
        if idx != last {
            let moved = self.holders[last].clone();
            if let Some(m) = self.accounts.get_mut(&moved) {
                m.holder_slot = idx + 1;
            }
        }
        self.holders.swap_remove(idx);
        a.holder_slot = 0;
    }

    fn transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128, memo: Option<String>) {
        require!(sender != receiver, "Sender and receiver should be different");
        require!(amount > 0, "The amount should be a positive number");
        self.debit(sender, amount);
        self.credit(receiver, amount);
        FtTransfer { old_owner_id: sender, new_owner_id: receiver, amount: U128(amount), memo: memo.as_deref() }.emit();
    }

    fn storage_min(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.account_storage_usage as u128)
    }
}

// ---------------------------------------------------------------- NEP-141

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        require!(env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL, "More gas is required");
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, memo);
        ext_ft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.accounts.get(&account_id).map_or(0, |a| a.balance))
    }
}

#[near]
impl FungibleTokenResolver for Token {
    /// Refunds the unused part of an `ft_transfer_call`. A refund is an inbound credit for the
    /// sender, so it updates `last_received_at` too (conservative for D15).
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let amount = amount.0;
        let unused = env::promise_result_checked(0, MAX_RESULT_LEN)
            .ok()
            .and_then(|v| serde_json::from_slice::<U128>(&v).ok())
            .map_or(amount, |u| u.0)
            .min(amount);
        if unused == 0 {
            return U128(amount);
        }
        let receiver_balance = self.accounts.get(&receiver_id).map_or(0, |a| a.balance);
        let refund = receiver_balance.min(unused);
        if refund == 0 {
            return U128(amount);
        }
        self.debit(&receiver_id, refund);
        if self.accounts.contains_key(&sender_id) {
            self.credit(&sender_id, refund);
            FtTransfer { old_owner_id: &receiver_id, new_owner_id: &sender_id, amount: U128(refund), memo: Some("refund") }
                .emit();
            U128(amount - refund)
        } else {
            // The sender unregistered while the call was in flight: burn.
            self.total_supply -= refund;
            log!("The account of the sender was deleted");
            FtBurn { owner_id: &receiver_id, amount: U128(refund), memo: Some("refund") }.emit();
            U128(amount)
        }
    }
}

// ---------------------------------------------------------------- NEP-145

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only; // min == max: every deposit is registration-only.
        let amount = env::attached_deposit();
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.accounts.contains_key(&account_id) {
            log!("The account is already registered, refunding the deposit");
            if !amount.is_zero() {
                near_sdk::Promise::new(env::predecessor_account_id()).transfer(amount).detach();
            }
        } else {
            let min = self.storage_min();
            require!(amount >= min, "The attached deposit is less than the minimum storage balance");
            self.accounts.insert(account_id, Account::default());
            let refund = amount.saturating_sub(min);
            if !refund.is_zero() {
                near_sdk::Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        StorageBalance { total: self.storage_min(), available: NearToken::from_yoctonear(0) }
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        require!(self.accounts.contains_key(&id), format!("The account {id} is not registered"));
        if amount.is_some_and(|a| !a.is_zero()) {
            env::panic_str("The amount is greater than the available storage balance");
        }
        StorageBalance { total: self.storage_min(), available: NearToken::from_yoctonear(0) }
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let Some(mut a) = self.accounts.get(&id).copied() else {
            log!("The account {} is not registered", id);
            return false;
        };
        require!(
            a.balance == 0 || force.unwrap_or(false),
            "Can't unregister the account with the positive balance without force"
        );
        self.remove_holder(&mut a);
        self.accounts.remove(&id);
        if a.balance > 0 {
            self.total_supply -= a.balance;
            FtBurn { owner_id: &id, amount: U128(a.balance), memo: Some("storage_unregister") }.emit();
        }
        near_sdk::Promise::new(id).transfer(self.storage_min().saturating_add(NearToken::from_yoctonear(1))).detach();
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let min = self.storage_min();
        StorageBalanceBounds { min, max: Some(min) }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts
            .contains_key(&account_id)
            .then(|| StorageBalance { total: self.storage_min(), available: NearToken::from_yoctonear(0) })
    }
}

// ---------------------------------------------------------------- NEP-148

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone().expect("metadata is set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "REORG".into(),
            symbol: "REORG".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    fn ctx(predecessor: AccountId, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .build());
    }

    fn setup() -> Token {
        ctx(accounts(0), 0, 100);
        let mut t = Token::new(accounts(0), U128(SUPPLY), meta());
        let min = t.storage_balance_bounds().min.as_yoctonear();
        for i in 1..4 {
            ctx(accounts(i), min, 100);
            t.storage_deposit(None, None);
        }
        t
    }

    fn holders(t: &Token) -> Vec<(String, u128)> {
        let mut v: Vec<_> = t.ft_holders(None, None).into_iter().map(|h| (h.account_id.to_string(), h.balance.0)).collect();
        v.sort();
        v
    }

    #[test]
    fn mint_sets_owner_holder_and_timestamp() {
        let t = setup();
        assert_eq!(t.ft_total_supply().0, SUPPLY);
        assert_eq!(t.ft_holders_count(), 1);
        let info = t.ft_holder_info(accounts(0));
        assert_eq!((info.balance.0, info.last_received_at.0), (SUPPLY, 100));
        // Registered with zero balance: not a holder, never received.
        let info = t.ft_holder_info(accounts(1));
        assert_eq!((info.balance.0, info.last_received_at.0), (0, 0));
        // Unknown accounts read as zeros (the REORG contract treats them as visitors).
        assert_eq!(t.ft_holder_info("nobody.near".parse().unwrap()).balance.0, 0);
        assert!(t.account_storage_usage > 0);
    }

    #[test]
    fn registry_follows_balances() {
        let mut t = setup();
        ctx(accounts(0), 1, 200);
        t.ft_transfer(accounts(1), U128(1000), None);
        t.ft_transfer(accounts(2), U128(2000), None);
        assert_eq!(t.ft_holders_count(), 3);
        assert_eq!(t.ft_holder_info(accounts(1)).last_received_at.0, 200);
        assert_eq!(t.ft_holder_info(accounts(0)).last_received_at.0, 100, "sending is not receiving");

        // accounts(1) empties its balance → leaves the set; the swap keeps slots consistent.
        ctx(accounts(1), 1, 300);
        t.ft_transfer(accounts(2), U128(1000), None);
        assert_eq!(t.ft_holders_count(), 2);
        assert_eq!(t.ft_holder_info(accounts(2)).last_received_at.0, 300);
        ctx(accounts(0), 1, 400);
        t.ft_transfer(accounts(3), U128(5), None);
        ctx(accounts(2), 1, 500);
        t.ft_transfer(accounts(3), U128(3000), None);
        assert_eq!(
            holders(&t),
            vec![(accounts(0).to_string(), SUPPLY - 3005), (accounts(3).to_string(), 3005)]
        );
        // Re-entering the set works after leaving it.
        ctx(accounts(3), 1, 600);
        t.ft_transfer(accounts(1), U128(1), None);
        assert_eq!(t.ft_holders_count(), 3);
        // Every slot points back at its own account.
        for (i, id) in t.holders.iter().enumerate() {
            assert_eq!(t.accounts[id].holder_slot as usize, i + 1);
        }
        let page = t.ft_holders(Some(1), Some(1));
        assert_eq!(page.len(), 1);
        assert_eq!(t.ft_holders(Some(10), Some(5)).len(), 0);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_needs_one_yocto() {
        let mut t = setup();
        ctx(accounts(0), 0, 200);
        t.ft_transfer(accounts(1), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn transfer_to_unregistered_fails() {
        let mut t = setup();
        ctx(accounts(0), 1, 200);
        t.ft_transfer("nobody.near".parse().unwrap(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "doesn't have enough balance")]
    fn overdraft_fails() {
        let mut t = setup();
        ctx(accounts(1), 1, 200);
        t.ft_transfer(accounts(2), U128(1), None);
    }

    #[test]
    fn storage_unregister_force_burns_and_leaves_set() {
        let mut t = setup();
        ctx(accounts(0), 1, 200);
        t.ft_transfer(accounts(1), U128(77), None);
        ctx(accounts(1), 1, 300);
        assert!(t.storage_unregister(Some(true)));
        assert_eq!(t.ft_total_supply().0, SUPPLY - 77);
        assert_eq!(t.ft_holders_count(), 1);
        assert!(t.storage_balance_of(accounts(1)).is_none());
    }
}
