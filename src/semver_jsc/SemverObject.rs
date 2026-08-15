//! `Bun.semver` — `{ satisfies, order, parse }` host-function table.

use core::cmp::Ordering;

use bun_core::strings;
use bun_jsc::bun_string_jsc::create_utf8_for_js;
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult, StringJsc};
use bun_semver::{SlicedString, Version, query};

pub fn create(global: &JSGlobalObject) -> JSValue {
    bun_jsc::create_host_function_object(
        global,
        &[
            ("satisfies", __jsc_host_satisfies, 2),
            ("order", __jsc_host_order, 2),
            ("parse", __jsc_host_parse, 1),
        ],
    )
}

/// `Bun.semver.parse("v1.2.3-beta.1+build.5")` →
/// `{ major: 1, minor: 2, patch: 3, prerelease: ["beta", 1], build: ["build", "5"], version: "1.2.3-beta.1" }`.
///
/// Returns `null` for anything that is not a complete `major.minor.patch` version: ranges,
/// partial versions like `1.2`, wildcards, and trailing garbage. Accepts the same leading
/// whitespace / `v` / `=` prefixes as `order` and `satisfies`.
#[bun_jsc::host_fn]
fn parse(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let arguments = frame.arguments();
    let Some(&argument) = arguments.first() else {
        return Ok(JSValue::NULL);
    };
    if argument.is_undefined_or_null() {
        return Ok(JSValue::NULL);
    }

    let input_view = argument.to_js_string_view(global)?;
    let input = input_view.to_utf8();
    let input = input.slice();

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

#[bun_jsc::host_fn]
fn order(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let arguments = frame.arguments();
    if arguments.len() < 2 {
        return Err(global.throw(format_args!("Expected two arguments")));
    }

    let left_view = arguments[0].to_js_string_view(global)?;
    let right_view = arguments[1].to_js_string_view(global)?;

    let left = left_view.to_utf8();
    let right = right_view.to_utf8();

    if !strings::is_all_ascii(left.slice()) {
        return Ok(JSValue::js_number_from_int32(0));
    }
    if !strings::is_all_ascii(right.slice()) {
        return Ok(JSValue::js_number_from_int32(0));
    }

    let left_result = Version::parse(SlicedString::init(left.slice(), left.slice()));
    let right_result = Version::parse(SlicedString::init(right.slice(), right.slice()));

    if !left_result.valid {
        return Err(global.throw(format_args!(
            "Invalid SemVer: {}\n",
            bstr::BStr::new(left.slice()),
        )));
    }

    if !right_result.valid {
        return Err(global.throw(format_args!(
            "Invalid SemVer: {}\n",
            bstr::BStr::new(right.slice()),
        )));
    }

    let left_version = left_result.version.max();
    let right_version = right_result.version.max();

    Ok(
        match left_version.order_without_build(right_version, left.slice(), right.slice()) {
            Ordering::Equal => JSValue::js_number_from_int32(0),
            Ordering::Greater => JSValue::js_number_from_int32(1),
            Ordering::Less => JSValue::js_number_from_int32(-1),
        },
    )
}

#[bun_jsc::host_fn]
fn satisfies(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let arguments = frame.arguments();
    if arguments.len() < 2 {
        return Err(global.throw(format_args!("Expected two arguments")));
    }

    let left_view = arguments[0].to_js_string_view(global)?;
    let right_view = arguments[1].to_js_string_view(global)?;

    let left = left_view.to_utf8();
    let right = right_view.to_utf8();

    if !strings::is_all_ascii(left.slice()) {
        return Ok(JSValue::FALSE);
    }
    if !strings::is_all_ascii(right.slice()) {
        return Ok(JSValue::FALSE);
    }

    let left_result = Version::parse(SlicedString::init(left.slice(), left.slice()));
    if left_result.wildcard != query::token::Wildcard::None {
        return Ok(JSValue::FALSE);
    }

    let left_version = left_result.version.min();

    // `Query::parse` can only fail with OOM.
    let right_group = match query::parse(
        right.slice(),
        SlicedString::init(right.slice(), right.slice()),
    ) {
        Ok(g) => g,
        Err(_) => return Err(global.throw_out_of_memory()),
    };

    if let Some(right_version) = right_group.get_exact_version() {
        return Ok(JSValue::js_boolean(left_version.eql(right_version)));
    }

    Ok(JSValue::js_boolean(right_group.satisfies(
        left_version,
        right.slice(),
        left.slice(),
    )))
}
