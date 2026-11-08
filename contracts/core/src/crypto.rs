//! Commit-reveal, code derivation, normalization and the answer hash (PROTOCOL.md §3-§5).
//!
//! SHA-256 is injected through [`Sha256`] so each host can use its cheapest implementation
//! (a host function on-chain, [`SoftSha256`] elsewhere). HMAC is built on top of it.

/// A SHA-256 implementation supplied by the host.
pub trait Sha256 {
    fn sha256(&self, data: &[u8]) -> [u8; 32];
}

/// Pure-Rust SHA-256 (feature `soft-sha256`).
#[cfg(any(test, feature = "soft-sha256"))]
#[derive(Clone, Copy, Debug, Default)]
pub struct SoftSha256;

#[cfg(any(test, feature = "soft-sha256"))]
impl Sha256 for SoftSha256 {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}

pub const DAY_SECRET_LEN: usize = 32;
pub const CODE_LEN: usize = 8;
pub const CONSONANTS: &[u8; 14] = b"BDFGKLMNPRSTVZ";
pub const VOWELS: &[u8; 5] = b"AEIOU";

const BLOCK: usize = 64;

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256<H: Sha256 + ?Sized>(h: &H, key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&h.sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(BLOCK + msg.len());
    inner.extend(k.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(msg);
    let inner = h.sha256(&inner);

    let mut outer = [0u8; BLOCK + 32];
    for (o, b) in outer.iter_mut().zip(k.iter()) {
        *o = b ^ 0x5c;
    }
    outer[BLOCK..].copy_from_slice(&inner);
    h.sha256(&outer)
}

/// §3: `len(day_secret) == 32` and `sha256(day_secret) == commit_hash`.
pub fn commit_matches<H: Sha256 + ?Sized>(h: &H, day_secret: &[u8], commit_hash: &[u8; 32]) -> bool {
    day_secret.len() == DAY_SECRET_LEN && h.sha256(day_secret) == *commit_hash
}

/// §4: the 8-letter code for `wallet` under `day_secret`.
pub fn derive_code<H: Sha256 + ?Sized>(h: &H, day_secret: &[u8; 32], wallet: &str) -> [u8; CODE_LEN] {
    let mac = hmac_sha256(h, day_secret, wallet.as_bytes());
    let mut code = [0u8; CODE_LEN];
    for i in 0..CODE_LEN / 2 {
        code[2 * i] = CONSONANTS[(mac[2 * i] % 14) as usize];
        code[2 * i + 1] = VOWELS[(mac[2 * i + 1] % 5) as usize];
    }
    code
}

/// §5: `sha256(norm(answer) ‖ 0x00 ‖ utf8(wallet))`. `normalized_answer` must already be normalized.
pub fn answer_hash<H: Sha256 + ?Sized>(h: &H, normalized_answer: &[u8], wallet: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(normalized_answer.len() + 1 + wallet.len());
    buf.extend_from_slice(normalized_answer);
    buf.push(0);
    buf.extend_from_slice(wallet.as_bytes());
    h.sha256(&buf)
}

/// The answer hash a correct submission by `wallet` must carry (codes are already normalized).
pub fn expected_answer_hash<H: Sha256 + ?Sized>(h: &H, day_secret: &[u8; 32], wallet: &str) -> [u8; 32] {
    answer_hash(h, &derive_code(h, day_secret, wallet), wallet)
}

/// §5 normalization: trim ASCII whitespace, ASCII uppercase, `0 → O`, `1 → I`.
pub fn normalize(answer: &str) -> String {
    answer
        .trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'))
        .chars()
        .map(|c| match c {
            'a'..='z' => c.to_ascii_uppercase(),
            '0' => 'O',
            '1' => 'I',
            _ => c,
        })
        .collect()
}
