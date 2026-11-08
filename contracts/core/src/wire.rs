//! JSON wire encoding (PROTOCOL.md §11): u128/u64 as canonical decimal strings,
//! 32-byte values as standard base64 with padding. Use with `#[serde(with = "...")]`.

use core::fmt::Display;
use core::str::FromStr;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `0` or a digit string without a leading zero, as in the TS `u128` regex.
pub fn is_canonical_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.iter().all(u8::is_ascii_digit) && (b.len() == 1 || b[0] != b'0')
}

fn parse_dec<'de, T: FromStr, D: Deserializer<'de>>(s: &str) -> Result<T, D::Error> {
    if !is_canonical_decimal(s) {
        return Err(D::Error::custom("expected a canonical decimal string"));
    }
    s.parse().map_err(|_| D::Error::custom("decimal string out of range"))
}

/// Serializes a `Display` value as a JSON string.
struct AsStr<'a, T>(&'a T);
impl<T: Display> Serialize for AsStr<'_, T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self.0)
    }
}

/// `u128` / `u64` as a decimal string.
pub mod dec {
    use super::*;
    pub fn serialize<T: Display, S: Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }
    pub fn deserialize<'de, T: FromStr, D: Deserializer<'de>>(d: D) -> Result<T, D::Error> {
        let s = String::deserialize(d)?;
        parse_dec::<T, D>(&s)
    }
}

/// `Option<u64>` as a decimal string or `null`.
pub mod dec_opt {
    use super::*;
    pub fn serialize<T: Display, S: Serializer>(v: &Option<T>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.collect_str(x),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, T: FromStr, D: Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(s) => parse_dec::<T, D>(&s).map(Some),
            None => Ok(None),
        }
    }
}

/// `[u128; 4]` as four decimal strings.
pub mod dec4 {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[u128; 4], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(v.iter().map(AsStr))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u128; 4], D::Error> {
        let v = <[String; 4]>::deserialize(d)?;
        let mut out = [0u128; 4];
        for (o, s) in out.iter_mut().zip(v.iter()) {
            *o = parse_dec::<u128, D>(s)?;
        }
        Ok(out)
    }
}

/// `[u8; 32]` as standard base64 with padding (44 chars).
pub mod b64 {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    pub fn encode(v: &[u8; 32]) -> String {
        STANDARD.encode(v)
    }
    pub fn decode(s: &str) -> Option<[u8; 32]> {
        if s.len() != 44 {
            return None;
        }
        STANDARD.decode(s).ok()?.try_into().ok()
    }
    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        decode(&s).ok_or_else(|| D::Error::custom("expected 32 bytes as base64 with padding"))
    }
}

/// `Option<[u8; 32]>` as base64 or `null`.
pub mod b64_opt {
    use super::*;
    pub fn serialize<S: Serializer>(v: &Option<[u8; 32]>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.serialize_str(&super::b64::encode(x)),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<[u8; 32]>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(s) => super::b64::decode(&s)
                .map(Some)
                .ok_or_else(|| D::Error::custom("expected 32 bytes as base64 with padding")),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_decimal() {
        for ok in ["0", "7", "10", "340282366920938463463374607431768211455"] {
            assert!(is_canonical_decimal(ok), "{ok}");
        }
        for bad in ["", "00", "01", "+1", "-1", "1.0", " 1", "1e3"] {
            assert!(!is_canonical_decimal(bad), "{bad}");
        }
    }

    #[test]
    fn b64_roundtrip_and_length() {
        let v = [7u8; 32];
        let s = b64::encode(&v);
        assert_eq!(s.len(), 44);
        assert_eq!(b64::decode(&s), Some(v));
        assert_eq!(b64::decode("AAAA"), None);
    }
}
