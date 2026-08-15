//! `Bun.semver`: `SemverObject.bind.ts`.

use core::cmp::Ordering;

use bun_core::strings;
use bun_jsc::bindgen::{self, JsHeap, JsScope};
use bun_jsc::bun_string_jsc::create_utf8_for_js;
use bun_jsc::{JSGlobalObject, JSValue, JsResult, StringJsc};
use bun_semver::{SlicedString, Version, query};

/// `Bun.semver.parse("v1.2.3-beta.1+build.5")` →
/// `{ major: 1, minor: 2, patch: 3, prerelease: ["beta", 1], build: ["build", "5"], version: "1.2.3-beta.1" }`.
///
/// Returns `null` for anything that is not a complete `major.minor.patch` version: ranges,
/// partial versions like `1.2`, wildcards, and trailing garbage. Accepts the same leading
/// whitespace / `v` / `=` prefixes as `order` and `satisfies`.
pub(crate) fn parse<'a>(cx: &mut JsScope<'a>, version: Option<&'a [u8]>) -> JsResult<JSValue> {
    let global = cx.global();
    let Some(input) = version else {
        return Ok(JSValue::NULL);
    };

    if !strings::is_all_ascii(input) {
        return Ok(JSValue::NULL);
    }

    let result = Version::parse(SlicedString::init(input, input));
    if !result.valid || result.wildcard != query::token::Wildcard::None {
        return Ok(JSValue::NULL);
    }
    let (Some(major), Some(minor), Some(patch)) = (
        result.version.major,
        result.version.minor,
        result.version.patch,
    ) else {
        return Ok(JSValue::NULL);
    };
    if !strings::is_all_whitespace(&input[result.len as usize..]) {
        return Ok(JSValue::NULL);
    }

    let tag = result.version.tag;
    let pre = tag.pre.slice(input);
    let build = tag.build.slice(input);

    let object = JSValue::create_empty_object(global, 6);
    object.put(global, b"major", JSValue::js_number_from_uint64(major));
    object.put(global, b"minor", JSValue::js_number_from_uint64(minor));
    object.put(global, b"patch", JSValue::js_number_from_uint64(patch));
    object.put(
        global,
        b"prerelease",
        identifiers_to_js(global, pre, prerelease_identifier_to_js)?,
    );
    object.put(
        global,
        b"build",
        identifiers_to_js(global, build, create_utf8_for_js)?,
    );

    // Like node-semver's `SemVer#version`, build metadata is left out: it does not take part in
    // precedence, so `1.2.3+a` and `1.2.3+b` are the same version.
    let version = if pre.is_empty() {
        bun_core::String::create_format(format_args!("{major}.{minor}.{patch}"))
    } else {
        bun_core::String::create_format(format_args!(
            "{major}.{minor}.{patch}-{}",
            bstr::BStr::new(pre)
        ))
    };
    object.put(global, b"version", version.into_js(global)?);

    Ok(object)
}

/// Splits a prerelease or build tag on `.` into a JS array, or `[]` when the tag is absent.
fn identifiers_to_js(
    global: &JSGlobalObject,
    tag: &[u8],
    identifier_to_js: fn(&JSGlobalObject, &[u8]) -> JsResult<JSValue>,
) -> JsResult<JSValue> {
    if tag.is_empty() {
        return JSValue::create_empty_array(global, 0);
    }

    let array = JSValue::create_empty_array(global, strings::count_char(tag, b'.') + 1)?;
    for (i, identifier) in strings::split(tag, b".").enumerate() {
        array.put_index(global, i as u32, identifier_to_js(global, identifier)?)?;
    }
    Ok(array)
}

/// Numeric prerelease identifiers compare as integers (`1.0.0-beta.2 < 1.0.0-beta.10`), so they
/// are exposed as numbers, matching node-semver. Identifiers beyond `Number.MAX_SAFE_INTEGER`
/// stay strings rather than losing precision.
fn prerelease_identifier_to_js(global: &JSGlobalObject, identifier: &[u8]) -> JsResult<JSValue> {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

    if !identifier.is_empty() && identifier.iter().all(u8::is_ascii_digit) {
        match bun_core::parse_unsigned::<u64>(identifier, 10) {
            Ok(number) if number <= MAX_SAFE_INTEGER => {
                return Ok(JSValue::js_number_from_uint64(number));
            }
            _ => {}
        }
    }
    create_utf8_for_js(global, identifier)
}

pub(crate) fn order<'a>(
    heap: &JsHeap<'a>,
    left: &'a [u8],
    right: &'a [u8],
) -> bindgen::Result<'a, i32> {
    if !strings::is_all_ascii(left) || !strings::is_all_ascii(right) {
        return Ok(0);
    }

    let left_result = Version::parse(SlicedString::init(left, left));
    let right_result = Version::parse(SlicedString::init(right, right));

    for (result, input) in [(&left_result, left), (&right_result, right)] {
        if !result.valid {
            return Err(heap.error(format_args!("Invalid SemVer: {}\n", bstr::BStr::new(input))));
        }
    }

    let left_version = left_result.version.max();
    let right_version = right_result.version.max();

    Ok(
        match left_version.order_without_build(right_version, left, right) {
            Ordering::Equal => 0,
            Ordering::Greater => 1,
            Ordering::Less => -1,
        },
    )
}

pub(crate) fn satisfies<'a>(version: &'a [u8], range: &'a [u8]) -> bindgen::Result<'a, bool> {
    if !strings::is_all_ascii(version) || !strings::is_all_ascii(range) {
        return Ok(false);
    }

    let Some(parsed_version) = Version::parse_exact(SlicedString::init(version, version)) else {
        return Ok(false);
    };

    let group = query::parse(range, SlicedString::init(range, range))?;

    if let Some(exact_version) = group.get_exact_version() {
        return Ok(parsed_version.eql(exact_version));
    }

    Ok(group.satisfies(parsed_version, range, version))
}

/// `bun:internal-for-testing`: `Group::intersects` on two range strings.
pub(crate) fn intersects<'a>(left: &'a [u8], right: &'a [u8]) -> bindgen::Result<'a, bool> {
    let left_group = query::parse(left, SlicedString::init(left, left))?;
    let right_group = query::parse(right, SlicedString::init(right, right))?;
    Ok(left_group.intersects(left, &right_group, right))
}
