//! `Bun.semver`: `SemverObject.bind.ts`.

use core::cmp::Ordering;

use bun_core::strings;
use bun_jsc::bindgen::{self, JsHeap, JsLocal, JsScope};
use bun_jsc::bun_string_jsc::{create_utf8_for_js, owned_utf8_into_js};
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult, StringJsc};
use bun_semver::inc::{IdentifierBase, Release};
use bun_semver::{SlicedString, Version, query};

/// The version `parse()` accepts: a complete `major.minor.patch` with the same leading
/// whitespace / `v` / `=` prefix as `order` and `satisfies`, followed by nothing but
/// whitespace. The returned version's tags are offsets into `input`.
fn parse_full_version(input: &[u8]) -> Option<Version> {
    if !strings::is_all_ascii(input) {
        return None;
    }
    let result = Version::parse(SlicedString::init(input, input));
    if !result.valid || result.wildcard != query::token::Wildcard::None {
        return None;
    }
    if result.version.major.is_none()
        || result.version.minor.is_none()
        || result.version.patch.is_none()
    {
        return None;
    }
    if !strings::is_all_whitespace(&input[result.len as usize..]) {
        return None;
    }
    Some(result.version.min())
}

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

    let Some(version) = parse_full_version(input) else {
        return Ok(JSValue::NULL);
    };
    let (major, minor, patch) = (version.major, version.minor, version.patch);

    let tag = version.tag;
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

    Ok(range_satisfies(&group, range, parsed_version, version))
}

/// `bun:internal-for-testing`: `Group::intersects` on two range strings.
#[bun_jsc::host_fn]
pub fn intersects_for_testing(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let left = frame.argument(0).to_utf8(global)?;
    let right = frame.argument(1).to_utf8(global)?;
    let (Ok(left_group), Ok(right_group)) = (
        query::parse(&left, SlicedString::init(&left, &left)),
        query::parse(&right, SlicedString::init(&right, &right)),
    ) else {
        return Err(global.throw_out_of_memory());
    };
    let intersects = left_group.intersects(&left, &right_group, &right);
    Ok(JSValue::js_boolean(intersects))
}

/// What `satisfies()` answers: an exact range (`1.2.3`) compares for equality, anything else
/// goes through the comparators, with the prerelease rules `bun install` uses.
fn range_satisfies(
    group: &query::Group,
    range: &[u8],
    version: Version,
    version_buf: &[u8],
) -> bool {
    if let Some(exact) = group.get_exact_version() {
        return version.eql(exact);
    }
    group.satisfies(version, range, version_buf)
}

/// `Bun.semver.inc("1.2.3", "minor")` → `"1.3.0"`,
/// `Bun.semver.inc("1.2.3", "prerelease", "beta")` → `"1.2.4-beta.0"`.
///
/// node-semver's `inc()`: `release` is one of its eight release types, `identifier` names the
/// prerelease, `identifierBase` (`"0"`, `"1"` or `false`) numbers it. Returns `null` when
/// `version` is not a complete version, when `"release"` is asked of a version that is not a
/// prerelease, or when `identifier` is not a valid prerelease identifier. Build metadata is
/// dropped, as node-semver does.
pub(crate) fn inc<'a>(
    cx: &mut JsScope<'a>,
    version: Option<&'a [u8]>,
    release: JsLocal<'a>,
    identifier: JsLocal<'a>,
    identifier_base: JsLocal<'a>,
) -> JsResult<JSValue> {
    let global = cx.global();

    // The release type and base are validated before the version, so a typo in them is
    // reported even when the version turns out to be invalid.
    let release = release_from_js(global, release.to_js())?;
    let base = identifier_base_from_js(global, identifier_base.to_js())?;

    let Some(input) = version else {
        return Ok(JSValue::NULL);
    };
    let Some(version) = parse_full_version(input) else {
        return Ok(JSValue::NULL);
    };

    let identifier_arg = identifier.to_js();
    let identifier_view = if identifier_arg.is_undefined_or_null() {
        None
    } else if identifier_arg.is_string() {
        Some(identifier_arg.to_js_string_view(global)?)
    } else {
        return Err(global.throw_invalid_arguments(format_args!(
            "Bun.semver.inc: `identifier` must be a string"
        )));
    };
    let identifier_utf8 = identifier_view.as_ref().map(|view| view.to_utf8());
    let identifier = identifier_utf8.as_ref().map(|utf8| utf8.slice());

    match bun_semver::inc::inc(version, input, release, identifier, base) {
        Some(incremented) => owned_utf8_into_js(global, incremented),
        None => Ok(JSValue::NULL),
    }
}

fn release_from_js(global: &JSGlobalObject, value: JSValue) -> JsResult<Release> {
    if value.is_string() {
        let view = value.to_js_string_view(global)?;
        let utf8 = view.to_utf8();
        if let Some(release) = Release::from_bytes(utf8.slice()) {
            return Ok(release);
        }
    }
    Err(global.throw_invalid_arguments(format_args!(
        "Bun.semver.inc: `release` must be one of \"major\", \"minor\", \"patch\", \"premajor\", \
         \"preminor\", \"prepatch\", \"prerelease\" or \"release\""
    )))
}

/// `identifierBase` as node-semver spells it: `"0"` (the default), `"1"`, or `false` for a
/// prerelease with no number (`1.2.3-beta`). The numbers `0` and `1` are taken too.
fn identifier_base_from_js(global: &JSGlobalObject, value: JSValue) -> JsResult<IdentifierBase> {
    if value.is_undefined() {
        return Ok(IdentifierBase::Zero);
    }
    if value == JSValue::FALSE {
        return Ok(IdentifierBase::None);
    }
    if value.is_string() {
        let view = value.to_js_string_view(global)?;
        match view.to_utf8().slice() {
            b"0" => return Ok(IdentifierBase::Zero),
            b"1" => return Ok(IdentifierBase::One),
            _ => {}
        }
    } else if value.is_number() {
        let number = value.as_number();
        if number == 0.0 {
            return Ok(IdentifierBase::Zero);
        }
        if number == 1.0 {
            return Ok(IdentifierBase::One);
        }
    }
    Err(global.throw_invalid_arguments(format_args!(
        "Bun.semver.inc: `identifierBase` must be \"0\", \"1\" or false"
    )))
}

/// `Bun.semver.maxSatisfying(["1.2.3", "1.3.0", "2.0.0"], "^1.0.0")` → `"1.3.0"`.
pub(crate) fn max_satisfying<'a>(
    cx: &mut JsScope<'a>,
    versions: JsLocal<'a>,
    range: &'a [u8],
) -> JsResult<JSValue> {
    best_satisfying(
        cx.global(),
        versions.to_js(),
        range,
        "maxSatisfying",
        Ordering::Greater,
    )
}

/// `Bun.semver.minSatisfying(["1.2.3", "1.3.0", "2.0.0"], "^1.0.0")` → `"1.2.3"`.
pub(crate) fn min_satisfying<'a>(
    cx: &mut JsScope<'a>,
    versions: JsLocal<'a>,
    range: &'a [u8],
) -> JsResult<JSValue> {
    best_satisfying(
        cx.global(),
        versions.to_js(),
        range,
        "minSatisfying",
        Ordering::Less,
    )
}

/// The element of `versions` that satisfies `range` and orders `wanted` against every other
/// element that does, or `null`. Elements that are not complete versions are skipped, as
/// node-semver does; the winner is returned as it was given (`"v1.2.3"` stays `"v1.2.3"`)
/// and on a tie the first one wins.
fn best_satisfying(
    global: &JSGlobalObject,
    versions: JSValue,
    range: &[u8],
    fn_name: &str,
    wanted: Ordering,
) -> JsResult<JSValue> {
    if !versions.is_array() {
        return Err(global.throw_invalid_arguments(format_args!(
            "Bun.semver.{fn_name}: `versions` must be an array of strings"
        )));
    }

    if !strings::is_all_ascii(range) {
        return Ok(JSValue::NULL);
    }
    // `Query::parse` can only fail with OOM.
    let group = match query::parse(range, SlicedString::init(range, range)) {
        Ok(group) => group,
        Err(_) => return Err(global.throw_out_of_memory()),
    };
    // A range with no comparator in it (`"latest"`) is not a range, not a match for everything.
    if group.is_empty() {
        return Ok(JSValue::NULL);
    }

    // The best element so far, with a copy of its text for the tag offsets in `Version`.
    let mut best: Option<(JSValue, Version, Vec<u8>)> = None;
    let mut iter = versions.array_iterator(global)?;
    while let Some(item) = iter.next()? {
        if !item.is_string() {
            continue;
        }
        let view = item.to_js_string_view(global)?;
        let utf8 = view.to_utf8();
        let input = utf8.slice();
        let Some(version) = parse_full_version(input) else {
            continue;
        };
        if !range_satisfies(&group, range, version, input) {
            continue;
        }
        let is_better = match &best {
            None => true,
            Some((_, best_version, best_input)) => {
                version.order_without_build(*best_version, input, best_input) == wanted
            }
        };
        if is_better {
            best = Some((item, version, input.to_vec()));
        }
    }

    Ok(best.map_or(JSValue::NULL, |(item, _, _)| item))
}
