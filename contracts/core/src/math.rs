//! 256-bit intermediate arithmetic for pay math (PROTOCOL.md §1, §7.3).
//!
//! `bucket × weight` reaches ~1e56 and overflows u128. Instead of pulling in a big-integer
//! crate, `mul_div` does a 128×128→256 multiply and a 256÷128 shift-subtract division.

const LO64: u128 = u64::MAX as u128;

/// Full 256-bit product of two u128 values, returned as `(high, low)`.
#[inline]
pub fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a0, a1) = (a & LO64, a >> 64);
    let (b0, b1) = (b & LO64, b >> 64);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    // Each term < 2^64, so `mid` < 3·2^64 and cannot overflow.
    let mid = (p00 >> 64) + (p01 & LO64) + (p10 & LO64);
    let lo = (p00 & LO64) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `floor(a × b / c)` with a 256-bit intermediate.
/// `None` if `c == 0` or the quotient does not fit in u128.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let (hi, lo) = mul_wide(a, b);
    if hi == 0 {
        return Some(lo / c);
    }
    if hi >= c {
        return None;
    }
    // Long division of (hi:lo) by c, one bit at a time. Invariant: rem < c.
    let mut rem = hi;
    let mut q = 0u128;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        // With the carry the true value is 2^128 + rem ≥ c; wrapping_sub yields the remainder.
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1u128 << i;
        }
    }
    Some(q)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference: schoolbook multiply on 32-bit limbs, then bitwise long division over all
    /// 256 bits. Independent of `mul_wide` and of the early exits in `mul_div`.
    fn reference(a: u128, b: u128, c: u128) -> Option<u128> {
        let limbs = |x: u128| [x as u32, (x >> 32) as u32, (x >> 64) as u32, (x >> 96) as u32];
        let (la, lb) = (limbs(a), limbs(b));
        let mut p = [0u64; 9];
        for i in 0..4 {
            let mut carry = 0u64;
            for j in 0..4 {
                let t = p[i + j] + la[i] as u64 * lb[j] as u64 + carry;
                p[i + j] = t & 0xffff_ffff;
                carry = t >> 32;
            }
            p[i + 4] += carry;
        }
        let mut rem: u128 = 0;
        let mut q_bits = [false; 256];
        for bit in (0..256).rev() {
            let b = (p[bit / 32] >> (bit % 32)) & 1;
            let overflow = rem >> 127 == 1;
            rem = (rem << 1) | b as u128;
            if overflow || rem >= c {
                rem = rem.wrapping_sub(c);
                q_bits[bit] = true;
            }
        }
        if q_bits[128..].iter().any(|&x| x) {
            return None;
        }
        Some(q_bits[..128].iter().enumerate().fold(0u128, |acc, (i, &x)| acc | ((x as u128) << i)))
    }

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn u128_bits(&mut self, bits: u32) -> u128 {
            let v = ((self.next() as u128) << 64) | self.next() as u128;
            if bits >= 128 { v } else { v & ((1u128 << bits) - 1) }
        }
    }

    #[test]
    fn small_values_match_native() {
        assert_eq!(mul_div(10, 20, 3), Some(66));
        assert_eq!(mul_div(0, u128::MAX, 1), Some(0));
        assert_eq!(mul_div(5, 5, 0), None);
        assert_eq!(mul_div(u128::MAX, 1, 1), Some(u128::MAX));
    }

    #[test]
    fn big_values() {
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(mul_div(u128::MAX, 2, 2), Some(u128::MAX));
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
        assert_eq!(mul_div(1 << 100, 1 << 100, 1 << 90), Some(1 << 110));
    }

    #[test]
    fn random_against_reference() {
        let mut r = XorShift(0x9e37_79b9_7f4a_7c15);
        for i in 0..20_000u32 {
            let a = r.u128_bits(1 + i % 128);
            let b = r.u128_bits(1 + (i * 7) % 128);
            let c = r.u128_bits(1 + (i * 13) % 128).max(1);
            assert_eq!(mul_div(a, b, c), reference(a, b, c), "a={a} b={b} c={c}");
        }
    }

    /// Pay-shaped inputs: weight ≤ denominator, so the quotient never exceeds the bucket.
    #[test]
    fn pay_shape_never_exceeds_bucket() {
        let mut r = XorShift(42);
        for _ in 0..20_000 {
            let bucket = r.u128_bits(90);
            let den = r.u128_bits(110).max(1);
            let w = (r.u128_bits(110) % den).max(1);
            let q = mul_div(bucket, w, den).unwrap();
            assert!(q <= bucket);
            assert_eq!(Some(q), reference(bucket, w, den));
        }
    }
}
