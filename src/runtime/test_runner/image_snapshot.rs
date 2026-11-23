//! The pixels, the names and the files of `expect(image).toMatchImageSnapshot()`. The comparison is a port of
//! pixelmatch 5 (LICENSE.md), which jest-image-snapshot compares with, and the files have the names and the places
//! that it gives them. A directory of snapshots that it wrote passes and fails here as it does there.

use std::borrow::Cow;

use bun_core::strings;
use bun_paths::Path;

use crate::image::codecs;

/// 8-bit RGBA, rows from the top.
pub(crate) struct Picture {
    rgba: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    icc_profile: Option<Vec<u8>>,
}

impl Picture {
    pub(crate) fn decode(bytes: &[u8]) -> Result<Picture, codecs::Error> {
        let decoded = codecs::decode(bytes, codecs::DEFAULT_MAX_PIXELS, codecs::DecodeHint::default())?;
        if decoded.width == 0 || decoded.height == 0 {
            return Err(codecs::Error::DecodeFailed);
        }
        Ok(Picture { rgba: decoded.rgba, width: decoded.width, height: decoded.height, icc_profile: decoded.icc_profile })
    }

    /// From the top left of a `width` by `height` canvas. jest-image-snapshot paints what the picture does not cover
    /// black at a quarter of full opacity, so that it differs from what the other picture has there. Its test for
    /// that is `x > width || y > height`, which leaves the first column and the first row beside the picture
    /// transparent, and the number of pixels that differ follows from it.
    fn on_canvas(&self, width: u32, height: u32) -> Cow<'_, [u8]> {
        if (self.width, self.height) == (width, height) {
            return Cow::Borrowed(&self.rgba);
        }
        let (own_width, own_height) = (self.width as usize, self.height as usize);
        let mut canvas = vec![0u8; width as usize * height as usize * 4];
        for (y, row) in canvas.chunks_exact_mut(width as usize * 4).enumerate() {
            if y < own_height {
                row[..own_width * 4].copy_from_slice(&self.rgba[y * own_width * 4..(y + 1) * own_width * 4]);
            }
            let painted_from = if y > own_height { 0 } else { own_width + 1 };
            for pixel in row.as_chunks_mut::<4>().0.iter_mut().skip(painted_from) {
                pixel[3] = 64;
            }
        }
        Cow::Owned(canvas)
    }
}

fn encode_png(rgba: &[u8], width: u32, height: u32, icc_profile: Option<&[u8]>) -> Result<Vec<u8>, codecs::Error> {
    let options = codecs::EncodeOptions { format: codecs::Format::Png, ..Default::default() };
    codecs::encode(rgba, width, height, options, icc_profile)
}

/// The file that is written for `picture`, which is a PNG by its name. `encoded` is kept as it came if it is one.
fn png_of<'a>(encoded: &'a [u8], picture: &Picture) -> Result<Cow<'a, [u8]>, codecs::Error> {
    if codecs::Format::sniff(encoded) == Some(codecs::Format::Png) {
        return Ok(Cow::Borrowed(encoded));
    }
    encode_png(&picture.rgba, picture.width, picture.height, picture.icc_profile.as_deref()).map(Cow::Owned)
}

pub(crate) struct Options {
    /// pixelmatch's `threshold`: how far apart two colors are before they differ, from 0 to 1.
    pub(crate) threshold: f64,
    /// Count the pixels that differ only as anti-aliasing does.
    pub(crate) include_aa: bool,
    pub(crate) failure_threshold: f64,
    /// `failure_threshold` is a share of the pixels from 0 to 1, and not a number of them.
    pub(crate) failure_threshold_is_ratio: bool,
    pub(crate) allow_size_mismatch: bool,
    pub(crate) update_passed_snapshot: bool,
    pub(crate) diff_is_vertical: bool,
    pub(crate) only_diff: bool,
    pub(crate) store_received: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            // jest-image-snapshot's default. pixelmatch's own is 0.1.
            threshold: 0.01,
            include_aa: false,
            failure_threshold: 0.0,
            failure_threshold_is_ratio: false,
            allow_size_mismatch: false,
            update_passed_snapshot: false,
            diff_is_vertical: false,
            only_diff: false,
            store_received: false,
        }
    }
}

pub(crate) struct Files<'a> {
    pub(crate) snapshot: &'a [u8],
    pub(crate) diff: &'a [u8],
    /// Where an image that fails is kept, if `Options::store_received` asks for it.
    pub(crate) received: &'a [u8],
}

pub(crate) struct Difference {
    pub(crate) pixels: usize,
    /// Of the pixels of a canvas that holds both pictures.
    pub(crate) ratio: f64,
    pub(crate) snapshot_size: (u32, u32),
    pub(crate) received_size: (u32, u32),
}

impl Difference {
    pub(crate) fn is_of_size(&self) -> bool {
        self.snapshot_size != self.received_size
    }
}

pub(crate) enum Outcome {
    Passed,
    Written,
    Updated,
    Mismatch(Difference),
    NotAllowedInCI,
    /// The file of the snapshot is not a picture.
    SnapshotUnreadable(codecs::Error),
    Failed(bun_sys::Error),
    EncodeFailed(codecs::Error),
}

fn write(path: &[u8], bytes: &[u8]) -> Result<(), bun_sys::Error> {
    let flags = bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::TRUNC;
    bun_sys::File::make_open(path, flags, 0o644).and_then(|file| file.write_all(bytes)).map_err(|err| err.with_path(path))
}

fn remove(path: &[u8]) {
    let _ = bun_sys::unlink(&Path::from(path));
}

/// Compares `received`, of which `encoded` is the file, with the snapshot, or writes the snapshot.
pub(crate) fn match_or_write(encoded: &[u8], received: &Picture, files: &Files<'_>, options: &Options, update: bool) -> Outcome {
    let write_received = |path: &[u8]| {
        let png = png_of(encoded, received).map_err(Outcome::EncodeFailed)?;
        write(path, &png).map_err(Outcome::Failed)
    };
    let write_snapshot = |written: Outcome| write_received(files.snapshot).map_or_else(|failed| failed, |()| written);

    let saved = match bun_sys::File::read_from(bun_sys::Fd::cwd(), files.snapshot) {
        Ok(saved) => saved,
        Err(err) if err.get_errno() == bun_sys::Errno::ENOENT => {
            if bun_core::ci_info::is_ci() && !update {
                return Outcome::NotAllowedInCI;
            }
            return write_snapshot(Outcome::Written);
        }
        Err(err) => return Outcome::Failed(err.with_path(files.snapshot)),
    };

    // What an earlier run left says nothing about this one.
    remove(files.diff);
    remove(files.received);

    let snapshot = match Picture::decode(&saved) {
        Ok(snapshot) => snapshot,
        Err(_) if update => return write_snapshot(Outcome::Updated),
        Err(err) => return Outcome::SnapshotUnreadable(err),
    };

    let (width, height) = (received.width.max(snapshot.width), received.height.max(snapshot.height));
    let received_pixels = received.on_canvas(width, height);
    let snapshot_pixels = snapshot.on_canvas(width, height);
    let compare = |picture: Option<&mut [u8]>| {
        let size = (width as usize, height as usize);
        pixelmatch(&received_pixels, &snapshot_pixels, picture, size, options.threshold, options.include_aa)
    };
    let differing = compare(None);
    let difference = Difference {
        pixels: differing,
        ratio: differing as f64 / (width as f64 * height as f64),
        snapshot_size: (snapshot.width, snapshot.height),
        received_size: (received.width, received.height),
    };
    let within_threshold = if options.failure_threshold_is_ratio {
        difference.ratio <= options.failure_threshold
    } else {
        differing as f64 <= options.failure_threshold
    };
    let passed = within_threshold && (!difference.is_of_size() || options.allow_size_mismatch);

    if update && (!passed || options.update_passed_snapshot) {
        return write_snapshot(Outcome::Updated);
    }
    if passed {
        return Outcome::Passed;
    }

    // Only an image that fails is drawn: most images are compared and found the same.
    let mut diff_pixels = vec![0u8; received_pixels.len()];
    compare(Some(&mut diff_pixels));
    let parts: &[&[u8]] =
        if options.only_diff { &[&diff_pixels] } else { &[&snapshot_pixels, &diff_pixels, &received_pixels] };
    let (side_by_side, full_width, full_height) = compose(parts, width, height, options.diff_is_vertical);
    let written = encode_png(&side_by_side, full_width, full_height, None)
        .map_err(Outcome::EncodeFailed)
        .and_then(|png| write(files.diff, &png).map_err(Outcome::Failed))
        .and_then(|()| if options.store_received { write_received(files.received) } else { Ok(()) });
    match written {
        Ok(()) => Outcome::Mismatch(difference),
        Err(failed) => failed,
    }
}

/// The pictures one after another, each `width` by `height`.
fn compose(parts: &[&[u8]], width: u32, height: u32, vertical: bool) -> (Vec<u8>, u32, u32) {
    let count = parts.len() as u32;
    if vertical {
        return (parts.concat(), width, height * count);
    }
    let row = width as usize * 4;
    let mut out = Vec::with_capacity(row * height as usize * parts.len());
    for y in 0..height as usize {
        for part in parts {
            out.extend_from_slice(&part[y * row..(y + 1) * row]);
        }
    }
    (out, width * count, height)
}

// ─── pixelmatch ──────────────────────────────────────────────────────────────
//
// The arithmetic is on `f64` in the order pixelmatch has it, so that a color is at the threshold here exactly when it
// is there.

type Rgba = [u8; 4];

#[inline]
fn pixel(image: &[u8], x: usize, y: usize, width: usize) -> Rgba {
    let at = (y * width + x) * 4;
    [image[at], image[at + 1], image[at + 2], image[at + 3]]
}

/// The number of pixels that differ. `picture` gets pixelmatch's picture of them: red where they differ, yellow where
/// they differ as anti-aliasing does, and the first image in pale gray elsewhere.
fn pixelmatch(
    a: &[u8],
    b: &[u8],
    mut picture: Option<&mut [u8]>,
    (width, height): (usize, usize),
    threshold: f64,
    include_aa: bool,
) -> usize {
    const RED: Rgba = [255, 0, 0, 255];
    const YELLOW: Rgba = [255, 255, 0, 255];

    let identical = a == b;
    if identical && picture.is_none() {
        return 0;
    }
    // 35215 is the largest value that `color_delta` gives.
    let max_delta = 35215.0 * threshold * threshold;
    let mut differing = 0;
    for y in 0..height {
        for x in 0..width {
            let (ours, theirs) = (pixel(a, x, y, width), pixel(b, x, y, width));
            let is_same = identical || color_delta(ours, theirs, false).abs() <= max_delta;
            let is_edge = !is_same
                && !include_aa
                && (antialiased(a, x, y, width, height, b) || antialiased(b, x, y, width, height, a));
            differing += usize::from(!is_same && !is_edge);
            if let Some(picture) = &mut picture {
                let drawn = if is_same { gray(ours) } else if is_edge { YELLOW } else { RED };
                let at = (y * width + x) * 4;
                picture[at..at + 4].copy_from_slice(&drawn);
            }
        }
    }
    differing
}

/// Whether the pixel is one that anti-aliasing draws on an edge, by "Anti-aliased Pixel and Intensity Slope Detector"
/// (V. Vysniauskas, 2009).
fn antialiased(image: &[u8], x1: usize, y1: usize, width: usize, height: usize, other: &[u8]) -> bool {
    let (x0, y0) = (x1.saturating_sub(1), y1.saturating_sub(1));
    let (x2, y2) = ((x1 + 1).min(width - 1), (y1 + 1).min(height - 1));
    let center = pixel(image, x1, y1, width);
    let mut equal = usize::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    let (mut darkest, mut brightest) = (0.0, 0.0);
    let (mut darkest_at, mut brightest_at) = ((0, 0), (0, 0));

    for x in x0..=x2 {
        for y in y0..=y2 {
            if (x, y) == (x1, y1) {
                continue;
            }
            let delta = color_delta(center, pixel(image, x, y, width), true);
            if delta == 0.0 {
                equal += 1;
                // An edge does not have three neighbors of the pixel's own color.
                if equal > 2 {
                    return false;
                }
            } else if delta < darkest {
                (darkest, darkest_at) = (delta, (x, y));
            } else if delta > brightest {
                (brightest, brightest_at) = (delta, (x, y));
            }
        }
    }

    if darkest == 0.0 || brightest == 0.0 {
        return false;
    }
    // The darkest or the brightest neighbor is part of a flat area in both images.
    [darkest_at, brightest_at].into_iter().any(|(x, y)| {
        has_many_siblings(image, x, y, width, height) && has_many_siblings(other, x, y, width, height)
    })
}

/// Whether three or more of the pixels around this one have its color.
fn has_many_siblings(image: &[u8], x1: usize, y1: usize, width: usize, height: usize) -> bool {
    let (x0, y0) = (x1.saturating_sub(1), y1.saturating_sub(1));
    let (x2, y2) = ((x1 + 1).min(width - 1), (y1 + 1).min(height - 1));
    let center = pixel(image, x1, y1, width);
    let mut equal = usize::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    for x in x0..=x2 {
        for y in y0..=y2 {
            if (x, y) != (x1, y1) && pixel(image, x, y, width) == center {
                equal += 1;
            }
            if equal > 2 {
                return true;
            }
        }
    }
    false
}

/// How far apart two colors look, by "Measuring perceived color difference using YIQ NTSC transmission color space
/// in mobile applications" (Y. Kotsarenko, F. Ramos). Negative when the second one is the darker.
fn color_delta(first: Rgba, second: Rgba, brightness_only: bool) -> f64 {
    if first == second {
        return 0.0;
    }
    let [r1, g1, b1] = on_white(first);
    let [r2, g2, b2] = on_white(second);
    let (y1, y2) = (rgb_to_y(r1, g1, b1), rgb_to_y(r2, g2, b2));
    let y = y1 - y2;
    if brightness_only {
        return y;
    }
    let i = rgb_to_i(r1, g1, b1) - rgb_to_i(r2, g2, b2);
    let q = rgb_to_q(r1, g1, b1) - rgb_to_q(r2, g2, b2);
    let delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    if y1 > y2 { -delta } else { delta }
}

fn rgb_to_y(r: f64, g: f64, b: f64) -> f64 {
    r * 0.29889531 + g * 0.58662247 + b * 0.11448223
}

fn rgb_to_i(r: f64, g: f64, b: f64) -> f64 {
    r * 0.59597799 - g * 0.27417610 - b * 0.32180189
}

fn rgb_to_q(r: f64, g: f64, b: f64) -> f64 {
    r * 0.21147017 - g * 0.52261711 + b * 0.31114694
}

fn blend_with_white(channel: f64, alpha: f64) -> f64 {
    255.0 + (channel - 255.0) * alpha
}

fn on_white([r, g, b, a]: Rgba) -> [f64; 3] {
    let rgb = [f64::from(r), f64::from(g), f64::from(b)];
    if a == 255 {
        return rgb;
    }
    let alpha = f64::from(a) / 255.0;
    rgb.map(|channel| blend_with_white(channel, alpha))
}

fn gray([r, g, b, a]: Rgba) -> Rgba {
    let brightness = rgb_to_y(f64::from(r), f64::from(g), f64::from(b));
    let value = blend_with_white(brightness, 0.1 * f64::from(a) / 255.0) as u8;
    [value, value, value, 255]
}

// ─── names ───────────────────────────────────────────────────────────────────

/// jest-image-snapshot's `defaultIdentifier`: `kebabCase("<test file>-<test name>-<count>")`. A snapshot that the
/// test does not name is `<defaultIdentifier>-snap.png`.
pub(crate) fn default_identifier(test_file: &[u8], test_name: &[u8], count: usize) -> Vec<u8> {
    let mut text = bun_paths::basename(test_file).to_vec();
    text.push(b'-');
    text.extend_from_slice(test_name);
    text.extend_from_slice(format!("-{count}").as_bytes());
    kebab_case(&text).into_bytes()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Upper,
    Lower,
    Digit,
    /// A letter of a script that has no case, or a symbol. lodash has it stand for either case.
    Other,
    Break,
}

impl Kind {
    fn of(char: char) -> Kind {
        match char {
            'A'..='Z' => Kind::Upper,
            'a'..='z' => Kind::Lower,
            '0'..='9' => Kind::Digit,
            '\0'..='\u{bf}' | '\u{d7}' | '\u{f7}' | '\u{2000}'..='\u{206f}' => Kind::Break,
            '\u{1680}' | '\u{180e}' | '\u{3000}' | '\u{feff}' => Kind::Break,
            _ => Kind::Other,
        }
    }

    fn is_lower_or_other(self) -> bool {
        matches!(self, Kind::Lower | Kind::Other)
    }

    fn is_upper_or_other(self) -> bool {
        matches!(self, Kind::Upper | Kind::Other)
    }
}

/// `String.fromCharCode(0xc0)` to `String.fromCharCode(0xff)` after lodash's `deburr()`.
const LATIN_1: [&str; 64] = [
    "A", "A", "A", "A", "A", "A", "Ae", "C", "E", "E", "E", "E", "I", "I", "I", "I",
    "D", "N", "O", "O", "O", "O", "O", "\u{d7}", "O", "U", "U", "U", "U", "Y", "Th", "ss",
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
    "d", "n", "o", "o", "o", "o", "o", "\u{f7}", "o", "u", "u", "u", "u", "y", "th", "y",
];

/// The same for 0x100 to 0x17f. lodash takes the apostrophe of 0x149 out afterwards.
const LATIN_EXTENDED_A: [&str; 128] = [
    "A", "a", "A", "a", "A", "a", "C", "c", "C", "c", "C", "c", "C", "c", "D", "d",
    "D", "d", "E", "e", "E", "e", "E", "e", "E", "e", "E", "e", "G", "g", "G", "g",
    "G", "g", "G", "g", "H", "h", "H", "h", "I", "i", "I", "i", "I", "i", "I", "i",
    "I", "i", "IJ", "ij", "J", "j", "K", "k", "k", "L", "l", "L", "l", "L", "l", "L",
    "l", "L", "l", "N", "n", "N", "n", "N", "n", "n", "N", "n", "O", "o", "O", "o",
    "O", "o", "Oe", "oe", "R", "r", "R", "r", "R", "r", "S", "s", "S", "s", "S", "s",
    "S", "s", "T", "t", "T", "t", "T", "t", "U", "u", "U", "u", "U", "u", "U", "u",
    "U", "u", "U", "u", "W", "w", "Y", "y", "Y", "Z", "z", "Z", "z", "Z", "z", "s",
];

/// lodash's `kebabCase()`, but for emoji: it makes a word of each, and here one is a letter like any other.
pub(crate) fn kebab_case(text: &[u8]) -> String {
    let mut chars: Vec<char> = Vec::with_capacity(text.len());
    let codepoints = strings::CodepointIterator::init(text);
    let mut cursor = strings::Cursor::default();
    while codepoints.next(&mut cursor) {
        let char = u32::try_from(cursor.c).ok().and_then(char::from_u32).unwrap_or(char::REPLACEMENT_CHARACTER);
        match char {
            '\u{c0}'..='\u{ff}' => chars.extend(LATIN_1[char as usize - 0xc0].chars()),
            '\u{100}'..='\u{17f}' => chars.extend(LATIN_EXTENDED_A[char as usize - 0x100].chars()),
            // Combining marks, and the apostrophe of a contraction.
            '\u{300}'..='\u{36f}' | '\u{fe20}'..='\u{fe2f}' | '\u{20d0}'..='\u{20ff}' | '\'' | '\u{2019}' => {}
            _ => chars.push(char),
        }
    }
    let kinds: Vec<Kind> = chars.iter().copied().map(Kind::of).collect();
    // The kind of the character at `at`, and `Break` at the end.
    let kind = |at: usize| kinds.get(at).copied().unwrap_or(Kind::Break);
    let run = |from: usize, is: fn(Kind) -> bool| from + kinds[from..].iter().take_while(|kind| is(**kind)).count();

    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let end = match kind(at) {
            Kind::Break => {
                at += 1;
                continue;
            }
            Kind::Digit => {
                let digits = run(at, |kind| kind == Kind::Digit);
                ordinal_end(&chars, digits).unwrap_or(digits)
            }
            first => {
                let after_capital = at + usize::from(first == Kind::Upper);
                let lowers = run(after_capital, |kind| kind == Kind::Lower);
                let capitals = run(at, Kind::is_upper_or_other);
                // `Word`, before a break or a capital.
                if lowers > after_capital && matches!(kind(lowers), Kind::Break | Kind::Upper) {
                    lowers
                // `HTML` of `HTMLElement`, and `HTML` before a break.
                } else if let Some(end) = (at + 1..=capitals).rev().find(|&end| {
                    if end == capitals { kind(end) == Kind::Break } else { kind(end) == Kind::Upper && kind(end + 1).is_lower_or_other() }
                }) {
                    end
                // `Word` before a digit.
                } else if kind(after_capital).is_lower_or_other() {
                    run(after_capital, Kind::is_lower_or_other)
                } else {
                    run(at, |kind| kind == Kind::Upper)
                }
            }
        };
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&chars[at..end].iter().collect::<String>().to_lowercase());
        at = end;
    }
    out
}

/// `21st`, `2ND` and `4th` are words. `digits` is where the digits end. `11th` is none to lodash, and neither is one
/// that runs on into letters of its own case or into digits.
fn ordinal_end(chars: &[char], digits: usize) -> Option<usize> {
    let suffix = [*chars.get(digits)?, *chars.get(digits + 1)?];
    let upper = suffix.iter().all(char::is_ascii_uppercase);
    let expected = match chars[digits - 1] {
        '1' => "st",
        '2' => "nd",
        '3' => "rd",
        _ => "th",
    };
    let one_case = upper || suffix.iter().all(char::is_ascii_lowercase);
    if !one_case || !suffix.iter().map(char::to_ascii_lowercase).eq(expected.chars()) {
        return None;
    }
    let runs_on = match chars.get(digits + 2) {
        Some(next) if upper => next.is_ascii_uppercase() || next.is_ascii_digit(),
        Some(next) => next.is_ascii_lowercase() || next.is_ascii_digit(),
        None => false,
    };
    (!runs_on).then_some(digits + 2)
}
