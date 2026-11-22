//! `presignPost()`: reads the `conditions` and the `fields` of its options, and makes its result.

use bun_collections::StringSet;
use bun_core::{String as BunString, strings};
use bun_jsc::bun_string_jsc;
use bun_jsc::{
    JSGlobalObject, JSPropertyIterator, JSType, JSValue, JsResult, PropertyIteratorOptions,
};
use bun_s3_signing::post_policy::{Condition, Operator, PresignedPost, is_reserved_field};

enum OwnedCondition {
    Field {
        name: Vec<u8>,
        value: Vec<u8>,
    },
    Match {
        operator: Operator,
        name: Vec<u8>,
        value: Vec<u8>,
    },
    ContentLengthRange {
        min: u64,
        max: u64,
    },
}

/// The `conditions` and the `fields` of the options, in UTF-8.
#[derive(Default)]
pub(crate) struct PostPolicy {
    conditions: Vec<OwnedCondition>,
    fields: Vec<(Vec<u8>, Vec<u8>)>,
}

const CONDITION_FORMS: &str = "[\"eq\", \"$field\", value], [\"starts-with\", \"$field\", prefix], [\"content-length-range\", min, max] or { field: value }";

/// `Number.MAX_SAFE_INTEGER`
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// An object with properties to list. A `Map` or a `Headers` has none.
fn plain_object(value: JSValue) -> Option<*mut bun_jsc::JSObject> {
    value.get_object().filter(|_| {
        matches!(
            value.js_type(),
            JSType::Object | JSType::FinalObject | JSType::ProxyObject
        )
    })
}

/// The text as a form sends it, with CR LF for each line break: no form meets a condition for another spelling.
pub(crate) fn with_form_line_breaks(text: &[u8]) -> Vec<u8> {
    if strings::index_of_any(text, b"\r\n").is_none() {
        return text.to_vec();
    }
    let mut out = Vec::with_capacity(text.len() + 8);
    for (index, &byte) in text.iter().enumerate() {
        let is_lone = match byte {
            b'\r' => text.get(index + 1) != Some(&b'\n'),
            b'\n' => index == 0 || text[index - 1] != b'\r',
            _ => false,
        };
        if is_lone {
            out.extend_from_slice(b"\r\n");
        } else {
            out.push(byte);
        }
    }
    out
}

/// A limit of `content-length-range`.
fn size_limit(value: JSValue) -> Option<u64> {
    let number = value.is_number().then(|| value.as_number())?;
    let is_size = number >= 0.0 && number <= MAX_SAFE_INTEGER && number.fract() == 0.0;
    is_size.then_some(number as u64)
}

fn condition_from_js(
    global: &JSGlobalObject,
    index: usize,
    condition: JSValue,
) -> JsResult<OwnedCondition> {
    let invalid = || {
        global.throw_invalid_arguments(format_args!(
            "conditions[{index}] must be {CONDITION_FORMS}"
        ))
    };

    if condition.is_array() {
        let mut items = condition.array_iterator(global)?;
        if items.len != 3 {
            return Err(invalid());
        }
        let [Some(operator), Some(first), Some(second)] =
            [items.next()?, items.next()?, items.next()?]
        else {
            return Err(invalid());
        };
        if !operator.is_string() {
            return Err(invalid());
        }
        let operator = match operator.to_utf8(global)?.slice() {
            b"eq" => Operator::Eq,
            b"starts-with" => Operator::StartsWith,
            b"content-length-range" => {
                return match (size_limit(first), size_limit(second)) {
                    (Some(min), Some(max)) if min <= max => {
                        Ok(OwnedCondition::ContentLengthRange { min, max })
                    }
                    _ => Err(global.throw_invalid_arguments(format_args!(
                        "conditions[{index}]: the sizes of \"content-length-range\" must be integers from 0 to Number.MAX_SAFE_INTEGER, the smaller one first"
                    ))),
                };
            }
            _ => return Err(invalid()),
        };
        if !first.is_string() || !second.is_string() {
            return Err(invalid());
        }
        let variable = first.to_utf8(global)?;
        let name = variable.slice().strip_prefix(b"$");
        let Some(name) = name.filter(|name| !name.is_empty()) else {
            return Err(global.throw_invalid_arguments(format_args!(
                "conditions[{index}] must name its field with a \"$\" in front, as in \"$key\""
            )));
        };
        return Ok(OwnedCondition::Match {
            operator,
            name: name.to_vec(),
            value: with_form_line_breaks(second.to_utf8(global)?.slice()),
        });
    }

    let Some(object) = plain_object(condition) else {
        return Err(invalid());
    };
    let entries = JSPropertyIterator::init(
        global,
        object,
        PropertyIteratorOptions {
            skip_empty_name: false,
            include_value: true,
        },
    )?;
    if entries.len != 1 {
        return Err(invalid());
    }
    let Some((name, value)) = entries.next()? else {
        return Err(invalid());
    };
    if name.is_empty() || !value.is_string() {
        return Err(invalid());
    }
    Ok(OwnedCondition::Field {
        name: name.to_utf8().slice().to_vec(),
        value: with_form_line_breaks(value.to_utf8(global)?.slice()),
    })
}

fn fields_from_js(global: &JSGlobalObject, fields: JSValue) -> JsResult<Vec<(Vec<u8>, Vec<u8>)>> {
    if fields.is_null() {
        return Ok(Vec::new());
    }
    let Some(object) = plain_object(fields) else {
        return Err(global.throw_invalid_argument_type_value(b"fields", b"object", fields));
    };
    let entries = JSPropertyIterator::init(
        global,
        object,
        PropertyIteratorOptions {
            skip_empty_name: false,
            include_value: true,
        },
    )?;
    let mut out: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(entries.len);
    let mut names = StringSet::new();
    while let Some((key, value)) = entries.next()? {
        if !value.is_string() {
            return Err(global.throw_invalid_argument_type_value(
                format!("fields.{key}"),
                b"string",
                value,
            ));
        }
        let name = key.to_utf8().slice().to_vec();
        if name.is_empty() {
            return Err(
                global.throw_invalid_arguments(format_args!("fields must not have an empty name"))
            );
        }
        if name.eq_ignore_ascii_case(b"file") {
            return Err(global.throw_invalid_arguments(format_args!(
                "fields must not have \"{key}\": the file is the last field of the form, after the fields that presignPost() returns"
            )));
        }
        if is_reserved_field(&name) {
            return Err(global.throw_invalid_arguments(format_args!(
                "fields must not have \"{key}\": presignPost() writes that field"
            )));
        }
        let lowercase = name.to_ascii_lowercase();
        if names.contains(&lowercase) {
            return Err(global.throw_invalid_arguments(format_args!(
                "fields has more than one \"{key}\" field (the names of fields are case-insensitive)"
            )));
        }
        bun_core::handle_oom(names.insert(&lowercase));
        out.push((name, with_form_line_breaks(value.to_utf8(global)?.slice())));
    }
    Ok(out)
}

impl PostPolicy {
    pub(crate) fn from_js(global: &JSGlobalObject, options: JSValue) -> JsResult<PostPolicy> {
        let mut policy = PostPolicy::default();
        if let Some(conditions) = options.get(global, "conditions")? {
            if !conditions.is_null() {
                if !conditions.is_array() {
                    return Err(global.throw_invalid_argument_type_value(
                        b"conditions",
                        b"array",
                        conditions,
                    ));
                }
                let mut items = conditions.array_iterator(global)?;
                let mut index = 0;
                while let Some(item) = items.next()? {
                    policy
                        .conditions
                        .push(condition_from_js(global, index, item)?);
                    index += 1;
                }
            }
        }
        if let Some(fields) = options.get(global, "fields")? {
            policy.fields = fields_from_js(global, fields)?;
        }
        Ok(policy)
    }

    pub(crate) fn conditions(&self) -> Vec<Condition<'_>> {
        let conditions = self.conditions.iter().map(|condition| match condition {
            OwnedCondition::Field { name, value } => Condition::Field { name, value },
            OwnedCondition::Match {
                operator,
                name,
                value,
            } => Condition::Match {
                operator: *operator,
                name,
                value,
            },
            OwnedCondition::ContentLengthRange { min, max } => Condition::ContentLengthRange {
                min: *min,
                max: *max,
            },
        });
        conditions.collect()
    }

    pub(crate) fn fields(&self) -> Vec<(&[u8], &[u8])> {
        let fields = self.fields.iter();
        fields
            .map(|(name, value)| (&name[..], &value[..]))
            .collect()
    }
}

/// `{ url, fields }`
pub(crate) fn presigned_post_to_js(
    global: &JSGlobalObject,
    post: &PresignedPost,
) -> JsResult<JSValue> {
    let fields = JSValue::create_empty_object(global, post.fields.len());
    for (name, value) in &post.fields {
        let value = bun_string_jsc::create_utf8_for_js(global, value)?;
        // A field of the caller can have any name, a number too.
        fields.put_may_be_index(global, &BunString::clone_utf8(name), value)?;
    }
    let result = JSValue::create_empty_object(global, 2);
    result.put(
        global,
        b"url",
        bun_string_jsc::create_utf8_for_js(global, &post.url)?,
    );
    result.put(global, b"fields", fields);
    Ok(result)
}
