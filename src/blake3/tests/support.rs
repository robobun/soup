//! BLAKE3 a second time, the plain way of its paper: a block at a time, and a parent as soon as two subtrees are equal. It checks the crate and stands in for the kernel.

use core::cell::RefCell;

const IV: [u32; 8] = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const PERMUTATION: [usize; 16] = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const CHUNK_START: u32 = 1;
const CHUNK_END: u32 = 2;
const PARENT: u32 = 4;
const ROOT: u32 = 8;

fn g(state: &mut [u32; 16], [a, b, c, d]: [usize; 4], mx: u32, my: u32) {
    state[a] = state[a].wrapping_add(state[b]).wrapping_add(mx);
    state[d] = (state[d] ^ state[a]).rotate_right(16);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_right(12);
    state[a] = state[a].wrapping_add(state[b]).wrapping_add(my);
    state[d] = (state[d] ^ state[a]).rotate_right(8);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_right(7);
}

/// `block` is zero after `block_len`.
fn compress(
    cv: &[u32; 8],
    block: &[u8; 64],
    counter: u64,
    block_len: u32,
    flags: u32,
) -> [u32; 16] {
    let mut message = [0; 16];
    for (word, bytes) in message.iter_mut().zip(block.as_chunks().0) {
        *word = u32::from_le_bytes(*bytes);
    }
    let mut state = [0; 16];
    state[..8].copy_from_slice(cv);
    state[8..12].copy_from_slice(&IV[..4]);
    state[12..].copy_from_slice(&[counter as u32, (counter >> 32) as u32, block_len, flags]);
    for round in 0..7 {
        const COLUMNS_THEN_DIAGONALS: [[usize; 4]; 8] = [
            [0, 4, 8, 12],
            [1, 5, 9, 13],
            [2, 6, 10, 14],
            [3, 7, 11, 15],
            [0, 5, 10, 15],
            [1, 6, 11, 12],
            [2, 7, 8, 13],
            [3, 4, 9, 14],
        ];
        for (at, quarter) in COLUMNS_THEN_DIAGONALS.into_iter().enumerate() {
            g(&mut state, quarter, message[2 * at], message[2 * at + 1]);
        }
        if round < 6 {
            message = PERMUTATION.map(|from| message[from]);
        }
    }
    let (low, high) = state.split_at_mut(8);
    for ((low, high), cv) in low.iter_mut().zip(high).zip(cv) {
        *low ^= *high;
        *high ^= cv;
    }
    state
}

fn chaining_value(words: [u32; 16]) -> [u32; 8] {
    core::array::from_fn(|i| words[i])
}

fn bytes_of(cv: &[u32; 8]) -> [u8; 32] {
    let mut bytes = [0; 32];
    for (bytes, word) in bytes.as_chunks_mut().0.iter_mut().zip(cv) {
        *bytes = word.to_le_bytes();
    }
    bytes
}

/// The chaining value of an input of whole blocks that is not the root.
fn node(
    input: &[u8],
    key: &[u32; 8],
    counter: u64,
    flags: u32,
    flags_start: u32,
    flags_end: u32,
) -> [u32; 8] {
    let blocks = input.len() / 64;
    let mut cv = *key;
    for (at, block) in input.as_chunks().0.iter().enumerate() {
        let start = if at == 0 { flags_start } else { 0 };
        let end = if at == blocks - 1 { flags_end } else { 0 };
        cv = chaining_value(compress(&cv, block, counter, 64, flags | start | end));
    }
    cv
}

/// The last block of a node, and what its compression takes beside the block.
struct Last {
    cv: [u32; 8],
    block: [u8; 64],
    block_len: u32,
    flags: u32,
}

fn last_of_chunk(chunk: &[u8], counter: u64) -> Last {
    let whole_before = chunk.len().saturating_sub(1) / 64;
    let (before, last) = chunk.split_at(64 * whole_before);
    let mut cv = IV;
    for (at, block) in before.as_chunks().0.iter().enumerate() {
        let start = if at == 0 { CHUNK_START } else { 0 };
        cv = chaining_value(compress(&cv, block, counter, 64, start));
    }
    let mut block = [0; 64];
    block[..last.len()].copy_from_slice(last);
    let start = if whole_before == 0 { CHUNK_START } else { 0 };
    Last {
        cv,
        block,
        block_len: last.len() as u32,
        flags: start | CHUNK_END,
    }
}

fn parent(left: &[u32; 8], right: &[u32; 8]) -> Last {
    let mut block = [0; 64];
    block[..32].copy_from_slice(&bytes_of(left));
    block[32..].copy_from_slice(&bytes_of(right));
    Last {
        cv: IV,
        block,
        block_len: 64,
        flags: PARENT,
    }
}

/// The first `length` bytes of the output for `input`.
pub(crate) fn reference(input: &[u8], length: usize) -> Vec<u8> {
    // Every chunk but the last is not the root. `stack` has a chaining value for each one bit of how many are done.
    let mut stack: Vec<[u32; 8]> = Vec::new();
    let last_at = input.len().saturating_sub(1) / 1024;
    for (counter, chunk) in input.chunks(1024).enumerate().take(last_at) {
        let last = last_of_chunk(chunk, counter as u64);
        let mut cv = chaining_value(compress(
            &last.cv,
            &last.block,
            counter as u64,
            last.block_len,
            last.flags,
        ));
        let mut done = counter + 1;
        while done % 2 == 0 {
            cv = {
                let last = parent(&stack.pop().expect("a subtree of the same size"), &cv);
                chaining_value(compress(&last.cv, &last.block, 0, 64, last.flags))
            };
            done /= 2;
        }
        stack.push(cv);
    }
    let mut last = last_of_chunk(&input[1024 * last_at..], last_at as u64);
    let mut counter = last_at as u64;
    while let Some(left) = stack.pop() {
        let right = chaining_value(compress(
            &last.cv,
            &last.block,
            counter,
            last.block_len,
            last.flags,
        ));
        last = parent(&left, &right);
        counter = 0;
    }
    let mut out = Vec::with_capacity(length + 64);
    for block in 0.. {
        if out.len() >= length {
            break;
        }
        for word in compress(
            &last.cv,
            &last.block,
            block,
            last.block_len,
            last.flags | ROOT,
        ) {
            out.extend_from_slice(&word.to_le_bytes());
        }
    }
    out.truncate(length);
    out
}

thread_local! {
    static CALLS: RefCell<Vec<[usize; 2]>> = const { RefCell::new(Vec::new()) };
}

/// How many inputs, of how many blocks, each call of the kernel got since the last time this was asked.
pub(crate) fn kernel_calls() -> Vec<[usize; 2]> {
    CALLS.take()
}

// This stands in for the Highway kernel, which tests in test/js cover.
#[unsafe(no_mangle)]
unsafe extern "C" fn highway_blake3_hash_many(
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
) {
    // SAFETY: the caller passes two slices, as pointers and what gives their lengths.
    let (input, out) = unsafe {
        (
            core::slice::from_raw_parts(input, count * blocks * 64),
            core::slice::from_raw_parts_mut(out, count * 32),
        )
    };
    CALLS.with_borrow_mut(|calls| calls.push([count, blocks]));
    let inputs = input.chunks_exact(blocks * 64);
    for (at, (input, out)) in inputs.zip(out.as_chunks_mut().0).enumerate() {
        let counter = counter + if increment_counter { at as u64 } else { 0 };
        *out = bytes_of(&node(input, key, counter, flags, flags_start, flags_end));
    }
}
