//! The kernel of `bun_blake3`, from src/jsc/bindings/highway_blake3.cpp.

unsafe extern "C" {
    fn highway_blake3_hash_many(
        input: *const u8,
        count: usize,
        blocks: usize,
        key: &[u32; 8],
        counter: u64,
        increment_counter: bool,
        flags: u32,
        flags_start: u32,
        flags_end: u32,
        out: *mut u8,
    );
}

const BLOCK_LEN: usize = 64;
const CHAINING_VALUE_LEN: usize = 32;

/// What the inputs of one [`hash_many`] have in common.
pub struct Inputs<'a> {
    /// How many 64-byte blocks each input is.
    pub blocks: usize,
    pub key: &'a [u32; 8],
    /// Of the first input.
    pub counter: u64,
    /// Whether each input has one more than the input before it.
    pub increment_counter: bool,
    pub flags: u32,
    /// Beside `flags`, for the first block of each input.
    pub flags_start: u32,
    /// Beside `flags`, for the last block of each input.
    pub flags_end: u32,
}

/// Writes the 32-byte chaining value of each input to `out`. Panics unless `input` is exactly as many inputs as `out` has room for, one after another.
#[inline]
pub fn hash_many(input: &[u8], inputs: &Inputs<'_>, out: &mut [u8]) {
    let (count, no_more) = (
        out.len() / CHAINING_VALUE_LEN,
        out.len() % CHAINING_VALUE_LEN,
    );
    let input_len = inputs.blocks.checked_mul(count * BLOCK_LEN);
    assert!(inputs.blocks != 0 && no_more == 0 && input_len == Some(input.len()));
    // SAFETY: the kernel reads `count * blocks * 64` bytes of `input`, which is its length, and writes `count * 32` bytes to `out`,
    // which is its length.
    unsafe {
        highway_blake3_hash_many(
            input.as_ptr(),
            count,
            inputs.blocks,
            inputs.key,
            inputs.counter,
            inputs.increment_counter,
            inputs.flags,
            inputs.flags_start,
            inputs.flags_end,
            out.as_mut_ptr(),
        );
    }
}
