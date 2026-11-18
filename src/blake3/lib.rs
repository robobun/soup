//! BLAKE3, its hash mode. Derived from the reference implementation of the BLAKE3 team (LICENSE.md).
#![forbid(unsafe_code)]
#![warn(unused_must_use)]

use bun_highway::blake3::{Inputs, hash_many};

/// The length of the hash. The output goes on after it for as long as the caller asks.
pub const OUT_LEN: usize = 32;
const BLOCK_LEN: usize = 64;
const CHUNK_LEN: usize = 1024;
/// As many chunks as the kernel hashes before their tree is folded. A power of two.
const MAX_RUN: usize = 256;

const CHUNK_START: u32 = 1 << 0;
const CHUNK_END: u32 = 1 << 1;
const PARENT: u32 = 1 << 2;
const ROOT: u32 = 1 << 3;

const IV: ChainingValue = [
    0x6A09_E667,
    0xBB67_AE85,
    0x3C6E_F372,
    0xA54F_F53A,
    0x510E_527F,
    0x9B05_688C,
    0x1F83_D9AB,
    0x5BE0_CD19,
];

/// The message words that each round takes, in order.
const SCHEDULE: [[usize; 16]; 7] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
    [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
    [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
    [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
    [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
    [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
];

type ChainingValue = [u32; 8];

#[inline(always)]
fn g(state: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize, mx: u32, my: u32) {
    state[a] = state[a].wrapping_add(state[b]).wrapping_add(mx);
    state[d] = (state[d] ^ state[a]).rotate_right(16);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_right(12);
    state[a] = state[a].wrapping_add(state[b]).wrapping_add(my);
    state[d] = (state[d] ^ state[a]).rotate_right(8);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_right(7);
}

// Inlined with a constant row of the schedule, so that no index is read or checked when it runs.
#[inline(always)]
fn round(state: &mut [u32; 16], block: &[u32; 16], schedule: &[usize; 16]) {
    g(state, 0, 4, 8, 12, block[schedule[0]], block[schedule[1]]);
    g(state, 1, 5, 9, 13, block[schedule[2]], block[schedule[3]]);
    g(state, 2, 6, 10, 14, block[schedule[4]], block[schedule[5]]);
    g(state, 3, 7, 11, 15, block[schedule[6]], block[schedule[7]]);
    g(state, 0, 5, 10, 15, block[schedule[8]], block[schedule[9]]);
    g(
        state,
        1,
        6,
        11,
        12,
        block[schedule[10]],
        block[schedule[11]],
    );
    g(state, 2, 7, 8, 13, block[schedule[12]], block[schedule[13]]);
    g(state, 3, 4, 9, 14, block[schedule[14]], block[schedule[15]]);
}

fn compress(
    cv: &ChainingValue,
    block: &[u32; 16],
    counter: u64,
    block_len: u32,
    flags: u32,
) -> [u32; 16] {
    let mut state = [
        cv[0],
        cv[1],
        cv[2],
        cv[3],
        cv[4],
        cv[5],
        cv[6],
        cv[7],
        IV[0],
        IV[1],
        IV[2],
        IV[3],
        counter as u32,
        (counter >> 32) as u32,
        block_len,
        flags,
    ];
    round(&mut state, block, &SCHEDULE[0]);
    round(&mut state, block, &SCHEDULE[1]);
    round(&mut state, block, &SCHEDULE[2]);
    round(&mut state, block, &SCHEDULE[3]);
    round(&mut state, block, &SCHEDULE[4]);
    round(&mut state, block, &SCHEDULE[5]);
    round(&mut state, block, &SCHEDULE[6]);
    let (low, high) = state.split_at_mut(8);
    for ((low, high), cv) in low.iter_mut().zip(high).zip(cv) {
        *low ^= *high;
        *high ^= cv;
    }
    state
}

fn first_half(words: [u32; 16]) -> ChainingValue {
    let [a, b, c, d, e, f, g, h, ..] = words;
    [a, b, c, d, e, f, g, h]
}

fn words_of<const BYTES: usize, const WORDS: usize>(bytes: &[u8; BYTES]) -> [u32; WORDS] {
    const { assert!(BYTES == 4 * WORDS) };
    let mut words = [0; WORDS];
    for (word, bytes) in words.iter_mut().zip(bytes.as_chunks().0) {
        *word = u32::from_le_bytes(*bytes);
    }
    words
}

/// What one more call of [`compress`] turns into a chaining value, or into the output if it is the root.
struct Output {
    input_cv: ChainingValue,
    block: [u32; 16],
    counter: u64,
    block_len: u32,
    flags: u32,
}

impl Output {
    fn chaining_value(&self) -> ChainingValue {
        first_half(compress(
            &self.input_cv,
            &self.block,
            self.counter,
            self.block_len,
            self.flags,
        ))
    }

    fn root_bytes(&self, out: &mut [u8]) {
        for (counter, out_block) in (0..).zip(out.chunks_mut(BLOCK_LEN)) {
            let words = compress(
                &self.input_cv,
                &self.block,
                counter,
                self.block_len,
                self.flags | ROOT,
            );
            for (word, bytes) in words.iter().zip(out_block.chunks_mut(4)) {
                bytes.copy_from_slice(&word.to_le_bytes()[..bytes.len()]);
            }
        }
    }
}

fn parent_output(left: &ChainingValue, right: &ChainingValue) -> Output {
    let mut block = [0; 16];
    block[..8].copy_from_slice(left);
    block[8..].copy_from_slice(right);
    Output {
        input_cv: IV,
        block,
        counter: 0,
        block_len: BLOCK_LEN as u32,
        flags: PARENT,
    }
}

#[derive(Clone)]
struct ChunkState {
    cv: ChainingValue,
    counter: u64,
    /// Zero after `block_len`.
    block: [u8; BLOCK_LEN],
    block_len: u8,
    blocks_compressed: u8,
}

impl ChunkState {
    fn new(counter: u64) -> Self {
        Self {
            cv: IV,
            counter,
            block: [0; BLOCK_LEN],
            block_len: 0,
            blocks_compressed: 0,
        }
    }

    fn len(&self) -> usize {
        BLOCK_LEN * usize::from(self.blocks_compressed) + usize::from(self.block_len)
    }

    fn start_flag(&self) -> u32 {
        if self.blocks_compressed == 0 {
            CHUNK_START
        } else {
            0
        }
    }

    /// A block that is not the last of its chunk.
    fn compress_block(&mut self, block: &[u8; BLOCK_LEN]) {
        self.cv = first_half(compress(
            &self.cv,
            &words_of(block),
            self.counter,
            BLOCK_LEN as u32,
            self.start_flag(),
        ));
        self.blocks_compressed += 1;
    }

    /// `input` fits what is left of the chunk.
    fn update(&mut self, mut input: &[u8]) {
        while !input.is_empty() {
            if usize::from(self.block_len) == BLOCK_LEN {
                let block = core::mem::replace(&mut self.block, [0; BLOCK_LEN]);
                self.compress_block(&block);
                self.block_len = 0;
            }
            if self.block_len == 0 {
                // The last block of the input waits in `self.block`: it may be the last of the chunk.
                while let Some((block, rest)) = input.split_first_chunk()
                    && !rest.is_empty()
                {
                    self.compress_block(block);
                    input = rest;
                }
            }
            let filled = usize::from(self.block_len);
            let (head, rest) = input.split_at(input.len().min(BLOCK_LEN - filled));
            self.block[filled..filled + head.len()].copy_from_slice(head);
            self.block_len += head.len() as u8;
            input = rest;
        }
    }

    fn output(&self) -> Output {
        Output {
            input_cv: self.cv,
            block: words_of(&self.block),
            counter: self.counter,
            block_len: u32::from(self.block_len),
            flags: self.start_flag() | CHUNK_END,
        }
    }
}

/// The chaining values of the two halves of the subtree over `input`: a power of two of whole chunks, `FRONT / OUT_LEN` at most, from chunk `counter`.
#[inline(never)]
fn halves<const FRONT: usize, const BACK: usize>(input: &[u8], counter: u64) -> [ChainingValue; 2] {
    const { assert!(FRONT == 2 * BACK && BACK >= 2 * OUT_LEN) };
    let mut front = [0; FRONT];
    let mut back = [0; BACK];
    let mut count = input.len() / CHUNK_LEN;
    let chunks = Inputs {
        blocks: CHUNK_LEN / BLOCK_LEN,
        key: &IV,
        counter,
        increment_counter: true,
        flags: 0,
        flags_start: CHUNK_START,
        flags_end: CHUNK_END,
    };
    hash_many(input, &chunks, &mut front[..count * OUT_LEN]);
    let parents = Inputs {
        blocks: 1,
        key: &IV,
        counter: 0,
        increment_counter: false,
        flags: PARENT,
        flags_start: 0,
        flags_end: 0,
    };
    let (mut level, mut above) = (&mut front[..], &mut back[..]);
    while count > 2 {
        hash_many(
            &level[..count * OUT_LEN],
            &parents,
            &mut above[..count / 2 * OUT_LEN],
        );
        core::mem::swap(&mut level, &mut above);
        count /= 2;
    }
    let (pair, _) = level.as_chunks::<OUT_LEN>();
    [words_of(&pair[0]), words_of(&pair[1])]
}

#[derive(Clone)]
pub struct Hasher {
    chunk: ChunkState,
    /// One chaining value for each subtree before `chunk`. The last two stay apart while their parent may be the root.
    stack: Vec<ChainingValue>,
}

// The stack is not inline: most hashers see one chunk or less, and a stack for 2^64 bytes is 1,728 bytes.
const _: () = assert!(size_of::<Hasher>() <= 136);

impl Default for Hasher {
    fn default() -> Self {
        Self {
            chunk: ChunkState::new(0),
            stack: Vec::new(),
        }
    }
}

impl Hasher {
    /// Leaves one chaining value for each subtree of the first `chunks` chunks.
    fn merge(&mut self, chunks: u64) {
        let keep = chunks.count_ones() as usize;
        while self.stack.len() > keep
            && let Some(right) = self.stack.pop()
            && let Some(left) = self.stack.last_mut()
        {
            *left = parent_output(left, &right).chaining_value();
        }
    }

    /// `cv` is of a subtree that begins after `chunks` chunks. What is below it is merged, and it is not: it may be half of the root.
    fn push(&mut self, cv: ChainingValue, chunks: u64) {
        self.merge(chunks);
        self.stack.push(cv);
    }

    pub fn update(&mut self, mut input: &[u8]) {
        if self.chunk.len() > 0 {
            let (head, rest) = input.split_at(input.len().min(CHUNK_LEN - self.chunk.len()));
            self.chunk.update(head);
            if rest.is_empty() {
                return;
            }
            let counter = self.chunk.counter;
            self.push(self.chunk.output().chaining_value(), counter);
            self.chunk = ChunkState::new(counter + 1);
            input = rest;
        }
        // What is left at the end, a chunk or less, goes to `self.chunk`: alone it is the root.
        while input.len() > CHUNK_LEN {
            let counter = self.chunk.counter;
            let mut run = (1usize << (input.len() / CHUNK_LEN).ilog2()).min(MAX_RUN);
            // A run is one subtree only if the chunks before it are whole subtrees of its size.
            while (run as u64 - 1) & counter != 0 {
                run /= 2;
            }
            let (chunks, rest) = input.split_at(run * CHUNK_LEN);
            if run == 1 {
                let mut chunk = ChunkState::new(counter);
                chunk.update(chunks);
                self.push(chunk.output().chaining_value(), counter);
            } else {
                // The scratch space is zeroed, so a short run gets a small one.
                let [left, right] = match run {
                    ..=8 => halves::<{ 8 * OUT_LEN }, { 4 * OUT_LEN }>(chunks, counter),
                    9..=64 => halves::<{ 64 * OUT_LEN }, { 32 * OUT_LEN }>(chunks, counter),
                    _ => {
                        halves::<{ MAX_RUN * OUT_LEN }, { MAX_RUN / 2 * OUT_LEN }>(chunks, counter)
                    }
                };
                self.push(left, counter);
                self.push(right, counter + run as u64 / 2);
            }
            self.chunk = ChunkState::new(counter + run as u64);
            input = rest;
        }
        if !input.is_empty() {
            self.chunk.update(input);
            // Now nothing on the stack is the root.
            self.merge(self.chunk.counter);
        }
    }

    /// Fills `out` with the output from its start, of which the first [`OUT_LEN`] bytes are the hash. Leaves the hasher as it is.
    pub fn finalize_xof(&self, out: &mut [u8]) {
        let (below, mut output) = match self.stack.as_slice() {
            // The input ended with a run, whose halves are the last two.
            [below @ .., left, right] if self.chunk.len() == 0 => {
                (below, parent_output(left, right))
            }
            all => (all, self.chunk.output()),
        };
        for left in below.iter().rev() {
            output = parent_output(left, &output.chaining_value());
        }
        output.root_bytes(out);
    }
}
