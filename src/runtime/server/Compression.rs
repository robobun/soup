//! Response compression for `Bun.serve({ compress })`.
//!
//! The server picks a content coding from the request's `Accept-Encoding`
//! (RFC 9110 §12.5.3) and the configured preference order, then encodes
//! bodies that are already in memory. `RequestContext` does this per
//! response; `StaticRoute` does it once per coding and keeps the bytes.

use bun_core::strings;
use bun_jsc::ComptimeStringMapExt as _;
use bun_libdeflate_sys::libdeflate;
use bun_uws::AnyRequest;

use crate::server::jsc::{JSGlobalObject, JSValue, JsResult};

pub const ZSTD_LEVEL: i32 = 3;
pub const BROTLI_QUALITY: i32 = 4;
pub const DEFLATE_LEVEL: i32 = 6;

#[repr(u8)]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Encoding {
    Zstd,
    Brotli,
    Gzip,
    Deflate,
}

impl Encoding {
    pub const COUNT: usize = 4;

    /// The `Content-Encoding` token.
    pub fn token(self) -> &'static [u8] {
        match self {
            Encoding::Zstd => b"zstd",
            Encoding::Brotli => b"br",
            Encoding::Gzip => b"gzip",
            Encoding::Deflate => b"deflate",
        }
    }

    /// Content-coding tokens are case-insensitive. `x-gzip` is the old name
    /// of `gzip` (RFC 9110 §8.4.1.3).
    fn from_token(token: &[u8]) -> Option<Encoding> {
        [
            (&b"zstd"[..], Encoding::Zstd),
            (b"br", Encoding::Brotli),
            (b"gzip", Encoding::Gzip),
            (b"x-gzip", Encoding::Gzip),
            (b"deflate", Encoding::Deflate),
        ]
        .into_iter()
        .find(|(name, _)| strings::eql_case_insensitive_ascii(token, name, true))
        .map(|(_, encoding)| encoding)
    }
}

bun_core::comptime_string_map! {
    static ENCODING_OPTION_MAP: Encoding = {
        b"zstd" => Encoding::Zstd,
        b"br" => Encoding::Brotli,
        b"gzip" => Encoding::Gzip,
        b"deflate" => Encoding::Deflate,
    };
}

/// The weight that a request's `Accept-Encoding` gives each [`Encoding`], in
/// thousandths. 0 means that the request refuses the coding.
#[derive(Copy, Clone, Default, Eq, PartialEq, Debug)]
pub struct Accepted([u16; Encoding::COUNT]);

impl Accepted {
    pub fn from_request(req: &AnyRequest) -> Accepted {
        req.header(b"accept-encoding")
            .map_or_else(Accepted::default, Accepted::parse)
    }

    /// A coding with no `q` has weight 1. `*` gives its weight to every coding
    /// that the list does not name. An entry with a `q` that does not parse is
    /// skipped. `identity` needs no entry: an unencoded body is always
    /// acceptable to the server.
    pub fn parse(value: &[u8]) -> Accepted {
        let mut named = [false; Encoding::COUNT];
        let mut weights = [0u16; Encoding::COUNT];
        let mut wildcard = 0u16;
        for item in strings::split(value, b",") {
            let mut parts = strings::split(item, b";");
            let coding = parts.next().unwrap_or(b"").trim_ascii();
            let mut weight = Some(1000);
            for param in parts {
                let param = param.trim_ascii();
                if strings::starts_with_case_insensitive_ascii(param, b"q=") {
                    weight = parse_qvalue(&param[2..]);
                }
            }
            let Some(weight) = weight else { continue };
            if coding == b"*" {
                wildcard = weight;
            } else if let Some(encoding) = Encoding::from_token(coding) {
                named[encoding as usize] = true;
                weights[encoding as usize] = weight;
            }
        }
        for (weight, named) in weights.iter_mut().zip(named) {
            if !named {
                *weight = wildcard;
            }
        }
        Accepted(weights)
    }

    fn weight(self, encoding: Encoding) -> u16 {
        self.0[encoding as usize]
    }
}

/// `qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )`, in thousandths.
fn parse_qvalue(value: &[u8]) -> Option<u16> {
    let value = value.trim_ascii();
    let (whole, fraction) = strings::split_once_char(value, b'.').unwrap_or((value, b""));
    let whole: u16 = match whole {
        b"0" => 0,
        b"1" => 1000,
        _ => return None,
    };
    if fraction.len() > 3 || !fraction.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let thousandths: u16 = fraction
        .iter()
        .zip([100, 10, 1])
        .map(|(digit, scale)| u16::from(digit - b'0') * scale)
        .sum();
    Some((whole + thousandths).min(1000))
}

/// The encoding for a response to `req`. `None` when compression is off, or
/// when the request accepts none of the configured encodings.
pub fn for_request(config: Option<Config>, req: &AnyRequest) -> Option<Encoding> {
    config?.select(Accepted::from_request(req))
}

/// `compress` from the `Bun.serve` options.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub struct Config {
    /// In order of preference. Only the first `len` entries are used.
    encodings: [Encoding; Encoding::COUNT],
    len: u8,
    /// A body smaller than this many bytes is sent as it is.
    pub threshold: u64,
}

impl Config {
    pub const DEFAULT: Config = Config {
        encodings: [
            Encoding::Zstd,
            Encoding::Brotli,
            Encoding::Gzip,
            Encoding::Deflate,
        ],
        len: 3,
        threshold: 1024,
    };

    pub fn encodings(&self) -> &[Encoding] {
        &self.encodings[..self.len as usize]
    }

    /// The configured coding that the request gives the most weight. A tie
    /// goes to the coding that comes first in the configuration. Browsers
    /// send no weights, so they get the first configured coding they accept.
    pub fn select(&self, accepted: Accepted) -> Option<Encoding> {
        let mut best: Option<(Encoding, u16)> = None;
        for &encoding in self.encodings() {
            let weight = accepted.weight(encoding);
            if weight > best.map_or(0, |(_, best)| best) {
                best = Some((encoding, weight));
            }
        }
        best.map(|(encoding, _)| encoding)
    }

    /// Parses `compress?: boolean | { encodings?: string[], threshold?: number }`.
    /// `Ok(None)` means compression is off.
    pub fn from_js(global: &JSGlobalObject, value: JSValue) -> JsResult<Option<Config>> {
        if value.is_undefined_or_null() {
            return Ok(None);
        }
        if value.is_boolean() {
            return Ok(value.as_boolean().then_some(Config::DEFAULT));
        }
        if !value.is_object() || value.js_type().is_array() {
            return Err(global.throw_invalid_argument_type_value(
                b"compress",
                b"boolean or object",
                value,
            ));
        }

        let mut config = Config::DEFAULT;
        if let Some(list) = value.get(global, "encodings")? {
            if !list.is_undefined() {
                if !list.js_type().is_array() {
                    return Err(global.throw_invalid_argument_type_value(
                        b"compress.encodings",
                        b"array",
                        list,
                    ));
                }
                config.len = 0;
                let mut iter = list.array_iterator(global)?;
                while let Some(item) = iter.next()? {
                    let encoding = match ENCODING_OPTION_MAP.from_js(global, item)? {
                        Some(encoding) => encoding,
                        None => {
                            return Err(global.throw_invalid_arguments(format_args!(
                                "compress.encodings must only contain \"zstd\", \"br\", \"gzip\" or \"deflate\""
                            )));
                        }
                    };
                    if !config.encodings().contains(&encoding) {
                        config.encodings[config.len as usize] = encoding;
                        config.len += 1;
                    }
                }
                if config.len == 0 {
                    return Err(global.throw_invalid_arguments(format_args!(
                        "compress.encodings must name at least one encoding"
                    )));
                }
            }
        }

        if let Some(threshold) = value.get(global, "threshold")? {
            config.threshold = global.validate_integer_range::<u64>(
                threshold,
                Config::DEFAULT.threshold,
                bun_jsc::IntegerRange {
                    min: 0,
                    max: i128::from(bun_jsc::MAX_SAFE_INTEGER),
                    field_name: b"compress.threshold",
                    always_allow_zero: false,
                },
            )?;
        }

        Ok(Some(config))
    }
}

/// Text, and the formats that are text underneath. Images, audio, video,
/// archives and web fonts are compressed already.
pub fn is_compressible_type(content_type: &[u8]) -> bool {
    let essence = match strings::index_of_char_usize(content_type, b';') {
        Some(end) => &content_type[..end],
        None => content_type,
    }
    .trim_ascii();
    let Some((kind, subtype)) = strings::split_once_char(essence, b'/') else {
        return false;
    };
    let is = |a: &[u8], b: &[u8]| strings::eql_case_insensitive_ascii(a, b, true);

    if is(kind, b"text") {
        // An event stream is written as it is produced.
        return !is(subtype, b"event-stream");
    }
    let has_suffix = |suffix: &[u8]| {
        subtype.len() > suffix.len() && is(&subtype[subtype.len() - suffix.len()..], suffix)
    };
    if has_suffix(b"+json") || has_suffix(b"+xml") {
        return true;
    }
    let names: &[&[u8]] = if is(kind, b"application") {
        &[
            b"json",
            b"javascript",
            b"ecmascript",
            b"x-javascript",
            b"xml",
            b"wasm",
            b"x-ndjson",
            b"yaml",
            b"x-yaml",
            b"toml",
            b"x-sh",
            b"rtf",
            b"x-www-form-urlencoded",
            b"vnd.ms-fontobject",
            b"x-font-ttf",
            b"x-font-otf",
        ]
    } else if is(kind, b"font") {
        &[b"ttf", b"otf", b"sfnt", b"collection"]
    } else if is(kind, b"image") {
        &[b"bmp", b"x-icon", b"vnd.microsoft.icon"]
    } else {
        &[]
    };
    names.iter().any(|name| is(subtype, name))
}

/// `Cache-Control: no-transform` forbids a change of coding (RFC 9111 §5.2.2.6).
pub fn forbids_transform(cache_control: &[u8]) -> bool {
    strings::split(cache_control, b",").any(|directive| {
        strings::eql_case_insensitive_ascii(directive.trim_ascii(), b"no-transform", true)
    })
}

/// The `Vary` value for a response that depends on `Accept-Encoding`, given
/// the value the response already has. `None` when that value covers it.
pub fn vary_with_accept_encoding(existing: Option<&[u8]>) -> Option<Vec<u8>> {
    let existing = existing.unwrap_or(b"").trim_ascii();
    if existing.is_empty() {
        return Some(b"Accept-Encoding".to_vec());
    }
    let covered = strings::split(existing, b",").any(|field| {
        let field = field.trim_ascii();
        field == b"*" || strings::eql_case_insensitive_ascii(field, b"accept-encoding", true)
    });
    if covered {
        return None;
    }
    Some([existing, b", Accept-Encoding"].concat())
}

/// An encoded body is a different sequence of bytes, so it must not share a
/// strong validator with the original (RFC 9110 §8.8.3). The weak form still
/// matches `If-None-Match`. `None` when the tag is weak already.
pub fn weak_etag(etag: &[u8]) -> Option<Vec<u8>> {
    let etag = etag.trim_ascii();
    if etag.is_empty() || strings::starts_with_case_insensitive_ascii(etag, b"w/") {
        return None;
    }
    Some([b"W/", etag].concat())
}

/// Encodes `input`. `None` when the encoder fails, or when the result is not
/// smaller than `input`, because then the original is the better response.
pub fn encode(encoding: Encoding, input: &[u8]) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    match encoding {
        Encoding::Zstd => {
            let bound = bun_zstd::compress_bound(input.len());
            if bun_zstd::is_error(bound) {
                return None;
            }
            out.try_reserve_exact(bound).ok()?;
            if let bun_zstd::Result::Err(_) =
                bun_zstd::compress_append(&mut out, input, Some(ZSTD_LEVEL))
            {
                return None;
            }
        }
        Encoding::Brotli => {
            use bun_brotli::c;
            let bound = c::BrotliEncoderMaxCompressedSize(input.len());
            if bound == 0 {
                return None;
            }
            out.try_reserve_exact(bound).ok()?;
            bun_brotli::encode_append(
                BROTLI_QUALITY,
                c::BROTLI_DEFAULT_WINDOW,
                c::BrotliEncoderMode::generic,
                input,
                &mut out,
            )?;
        }
        Encoding::Gzip | Encoding::Deflate => {
            libdeflate::load();
            let mut compressor = libdeflate::OwnedCompressor::new(DEFLATE_LEVEL)?;
            // HTTP `deflate` is the zlib format (RFC 9110 §8.4.1.2).
            let format = if encoding == Encoding::Gzip {
                libdeflate::Encoding::Gzip
            } else {
                libdeflate::Encoding::Zlib
            };
            let result = compressor.compress_to_vec(input, &mut out, format).ok()?;
            if result.written == 0 {
                return None;
            }
        }
    }
    if out.len() >= input.len() {
        return None;
    }
    out.shrink_to_fit();
    Some(out)
}
