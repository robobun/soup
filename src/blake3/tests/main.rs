mod support;

use bun_blake3::{Hasher, OUT_LEN};
use support::{kernel_calls, reference};

/// test_vectors/test_vectors.json of BLAKE3-team/BLAKE3, as it is there.
const OFFICIAL: &[u8] = include_bytes!("../../../test/js/bun/util/blake3-test-vectors.json");

/// What is left of `bytes` after the first `key` in it.
fn after<'a>(bytes: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let at = (0..bytes.len()).find(|&at| bytes[at..].starts_with(key))?;
    Some(&bytes[at + key.len()..])
}

/// The input length and the `hash` output of each case of the file.
fn official() -> Vec<(usize, Vec<u8>)> {
    let nibble = |digit: u8| (digit as char).to_digit(16).expect("a hex digit") as u8;
    let mut cases = Vec::new();
    let mut rest = OFFICIAL;
    while let Some(number) = after(rest, b"\"input_len\": ") {
        let digits = number.iter().take_while(|byte| byte.is_ascii_digit());
        let length = digits.fold(0, |length, digit| 10 * length + usize::from(digit - b'0'));
        let hex = after(number, b"\"hash\": \"").expect("a hash for each length");
        let digits = hex
            .iter()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .count();
        let (pairs, _) = hex[..digits].as_chunks();
        let hash = pairs
            .iter()
            .map(|&[high, low]| nibble(high) << 4 | nibble(low));
        cases.push((length, hash.collect()));
        rest = &hex[digits..];
    }
    cases
}

/// The input of the official vectors.
fn input(length: usize) -> Vec<u8> {
    (0..length).map(|at| (at % 251) as u8).collect()
}

fn output(hasher: &Hasher, length: usize) -> Vec<u8> {
    let mut out = vec![0; length];
    hasher.finalize_xof(&mut out);
    out
}

fn hash(input: &[u8], length: usize) -> Vec<u8> {
    let mut hasher = Hasher::default();
    hasher.update(input);
    output(&hasher, length)
}

/// Lengths around each place where the tree gets another level, and where a run of the kernel ends.
fn lengths() -> Vec<usize> {
    let mut lengths = vec![0, 1, 63, 64, 65, 127, 128, 129, 1023];
    for chunks in [
        1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 255, 256,
        257, 300, 511, 512, 513, 777,
    ] {
        lengths.extend([
            1024 * chunks,
            1024 * chunks + 1,
            1024 * chunks + 64,
            1024 * chunks + 1023,
        ]);
    }
    lengths
}

#[test]
fn official_vectors() {
    let cases = official();
    assert_eq!(cases.len(), 35);
    for (length, expected) in &cases {
        assert_eq!(expected.len(), 131);
        let input = input(*length);
        assert_eq!(&hash(&input, 131), expected, "{length} bytes");
        // A shorter output is the start of a longer one.
        for short in [0, 1, 31, OUT_LEN, 33, 63, 64, 65, 130] {
            assert_eq!(
                hash(&input, short),
                expected[..short],
                "{short} bytes out of {length}"
            );
        }
        assert_eq!(
            &reference(&input, 131),
            expected,
            "the test's own BLAKE3, {length} bytes"
        );
    }
}

#[test]
fn one_update_of_each_length() {
    for length in lengths() {
        let input = input(length);
        assert_eq!(hash(&input, 131), reference(&input, 131), "{length} bytes");
    }
}

#[test]
fn two_updates_split_anywhere() {
    for length in [
        0, 1, 64, 65, 1024, 1025, 2048, 2049, 4096, 5000, 8192, 16384, 17408, 31744, 66_000,
    ] {
        let input = input(length);
        let expected = reference(&input, 64);
        let mut splits: Vec<usize> = (0..=length.min(130)).collect();
        for boundary in (1024..=length).step_by(1024) {
            splits.extend([boundary - 65, boundary - 64, boundary - 1, boundary]);
            splits.extend(
                [boundary + 1, boundary + 64]
                    .into_iter()
                    .filter(|&split| split <= length),
            );
        }
        splits.push(length);
        for split in splits {
            let mut hasher = Hasher::default();
            hasher.update(&input[..split]);
            hasher.update(&input[split..]);
            assert_eq!(
                output(&hasher, 64),
                expected,
                "{length} bytes, split at {split}"
            );
        }
    }
}

#[test]
fn updates_of_one_size() {
    let input = input(1024 * 300 + 7);
    let expected = reference(&input, 64);
    for size in [
        1, 3, 63, 64, 65, 1000, 1023, 1024, 1025, 2048, 3000, 4096, 8192, 10_000, 65_536, 100_000,
        262_144,
    ] {
        let mut hasher = Hasher::default();
        for part in input.chunks(size) {
            hasher.update(part);
        }
        assert_eq!(output(&hasher, 64), expected, "updates of {size} bytes");
    }
}

#[test]
fn updates_of_many_sizes() {
    // A fixed sequence of numbers that looks random.
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut next = |below: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % below as u64) as usize
    };
    for _ in 0..300 {
        let input = input(next(80_000));
        let mut hasher = Hasher::default();
        let mut rest = input.as_slice();
        while !rest.is_empty() {
            // Mostly whole chunks, so that runs of the kernel begin at many counts.
            let size = match next(4) {
                0 => next(200),
                1 => 1024 * next(5),
                2 => 1024 * next(40),
                _ => next(20_000),
            };
            let (part, after) = rest.split_at(size.min(rest.len()));
            hasher.update(part);
            rest = after;
        }
        assert_eq!(
            output(&hasher, 40),
            reference(&input, 40),
            "{} bytes",
            input.len()
        );
    }
}

#[test]
fn kernel_gets_each_run_of_two_chunks_or_more() {
    let calls = |chunks: usize| {
        kernel_calls();
        let input = input(1024 * chunks);
        assert_eq!(hash(&input, OUT_LEN), reference(&input, OUT_LEN));
        kernel_calls()
    };
    // One chunk may be the root, and so is never hashed ahead.
    assert_eq!(calls(1), [[0; 2]; 0]);
    assert_eq!(calls(2), [[2, 16]]);
    assert_eq!(calls(3), [[2, 16]]);
    assert_eq!(calls(4), [[4, 16], [2, 1]]);
    assert_eq!(calls(8), [[8, 16], [4, 1], [2, 1]]);
    assert_eq!(calls(16), [[16, 16], [8, 1], [4, 1], [2, 1]]);
    assert_eq!(calls(17), [[16, 16], [8, 1], [4, 1], [2, 1]]);
    let run_of_32 = [[32, 16], [16, 1], [8, 1], [4, 1], [2, 1]];
    let run_of_64 = [&[[64, 16], [32, 1]][..], &run_of_32[1..]].concat();
    assert_eq!(
        calls(100),
        [&run_of_64[..], &run_of_32, &[[4, 16], [2, 1]]].concat()
    );
    // No run is longer than 256 chunks.
    let run_of_256 = [
        &[[256, 16], [128, 1], [64, 1], [32, 1]][..],
        &run_of_32[1..],
    ]
    .concat();
    let rest = [[16, 16], [8, 1], [4, 1], [2, 1], [8, 16], [4, 1], [2, 1]];
    assert_eq!(
        calls(600),
        [&run_of_256[..], &run_of_256, &run_of_64, &rest].concat()
    );
}

#[test]
fn run_begins_only_where_a_subtree_of_its_size_does() {
    let input = input(1024 * 11);
    let mut hasher = Hasher::default();
    kernel_calls();
    hasher.update(&input[..1024 * 3]);
    assert_eq!(kernel_calls(), [[2, 16]]);
    // The third chunk waited. The fourth is alone, then come four, and two of the last three.
    hasher.update(&input[1024 * 3..]);
    assert_eq!(kernel_calls(), [[4, 16], [2, 1], [2, 16]]);
    assert_eq!(output(&hasher, OUT_LEN), reference(&input, OUT_LEN));
}

#[test]
fn clone_and_output_leave_the_hasher_as_it_is() {
    let input = input(70_000);
    let (head, tail) = input.split_at(33_333);
    let mut hasher = Hasher::default();
    hasher.update(head);
    let mut copy = hasher.clone();
    assert_eq!(output(&hasher, OUT_LEN), reference(head, OUT_LEN));
    assert_eq!(output(&hasher, 200), reference(head, 200));
    hasher.update(tail);
    assert_eq!(output(&hasher, 77), reference(&input, 77));
    copy.update(b"something else");
    assert_eq!(
        output(&copy, OUT_LEN),
        reference(&[head, b"something else"].concat(), OUT_LEN)
    );
}
