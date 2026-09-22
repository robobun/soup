//! `expect.addSnapshotSerializer()`: pretty-format plugins that decide how a value is written
//! into a snapshot.
//!
//! While a snapshot is formatted, [`Formatter::format`] hands every value, at any depth, to
//! [`Formatter::print_with_serializer`] first. It asks each serializer's `test(value)`, newest
//! first, and the first one that accepts prints the value: through
//! `serialize(value, config, indentation, depth, refs, printer)`, or through the older
//! `print(value, print, indent, options, colors)`. `printer` and `print` come back here
//! ([`print_nested`]) for the values the serializer leaves to the formatter.

use bun_core::{StackCheck, String as BunString, strings};
use bun_jsc::bun_string_jsc;
use bun_jsc::{CallFrame, JSFunction, JSGlobalObject, JSValue, JsResult, Strong, StringJsc as _};

use super::jest::Jest;
use super::pretty_format::{Formatter, JestPrettyFormat, WrappedWriter};

/// Newest first, the order they are asked in. Like the matchers of `expect.extend()`, they last
/// as long as the global they were added in: the run, or one file under `--isolate`.
#[derive(Default)]
pub(crate) struct SnapshotSerializers(Vec<Strong>);

impl SnapshotSerializers {
    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }
}

/// `None` outside of `bun test`. `f` must not run script: the registry is borrowed meanwhile.
fn with_registry<R>(f: impl FnOnce(&mut SnapshotSerializers) -> R) -> Option<R> {
    let runner = Jest::runner_ptr()?;
    // The snapshot matchers format while they hold the `&mut TestRunner` they count the snapshot
    // on, and a serializer's script may add another serializer from in there. So only this field
    // is borrowed, through the raw pointer.
    // SAFETY: JS thread only, `RUNNER` outlives the run, and nothing else borrows this field.
    let serializers = unsafe { &mut *core::ptr::addr_of_mut!((*runner.as_ptr()).bun_test_root.snapshot_serializers) };
    Some(f(serializers))
}

/// The serializers a snapshot taken now goes through. A copy, because a serializer runs
/// script, and script can add another one. The registry roots the values.
pub(crate) fn active() -> Vec<JSValue> {
    with_registry(|serializers| serializers.0.iter().map(Strong::get).collect()).unwrap_or_default()
}

fn callable(global: &JSGlobalObject, object: JSValue, name: &'static str) -> JsResult<Option<JSValue>> {
    Ok(object.get(global, name)?.filter(|function| function.is_callable()))
}

pub(crate) fn add(global: &JSGlobalObject, call_frame: &CallFrame) -> JsResult<JSValue> {
    let serializer = call_frame.argument(0);
    if !serializer.is_object()
        || callable(global, serializer, "test")?.is_none()
        || (callable(global, serializer, "serialize")?.is_none() && callable(global, serializer, "print")?.is_none())
    {
        return Err(crate::throw_pretty_static!(
            global,
            "<d>expect.<r>addSnapshotSerializer<d>(<r>serializer<d>)<r>\n\nExpected an object with a <b>test<r> function and a <b>serialize<r> or <b>print<r> function\n",
        ));
    }

    let strong = Strong::create(serializer, global);
    with_registry(|serializers| serializers.0.insert(0, strong));
    Ok(JSValue::UNDEFINED)
}

fn static_string(global: &JSGlobalObject, text: &'static str) -> JsResult<JSValue> {
    BunString::static_(text).to_js(global)
}

/// pretty-format's `Config`, with the values jest-snapshot formats with.
fn create_config(global: &JSGlobalObject, serializers: &[JSValue]) -> JsResult<JSValue> {
    let colors = JSValue::create_empty_object(global, 5);
    for name in [&b"comment"[..], b"content", b"prop", b"tag", b"value"] {
        let color = JSValue::create_empty_object(global, 2);
        color.put(global, b"close", static_string(global, "")?);
        color.put(global, b"open", static_string(global, "")?);
        colors.put(global, name, color);
    }

    let plugins = JSValue::create_empty_array(global, serializers.len())?;
    for (i, serializer) in serializers.iter().enumerate() {
        plugins.put_index(global, i as u32, *serializer)?;
    }

    let config = JSValue::create_empty_object(global, 14);
    config.put(global, b"callToJSON", JSValue::TRUE);
    config.put(global, b"colors", colors);
    config.put(global, b"compareKeys", JSValue::UNDEFINED);
    config.put(global, b"escapeRegex", JSValue::TRUE);
    config.put(global, b"escapeString", JSValue::FALSE);
    config.put(global, b"indent", static_string(global, "  ")?);
    config.put(global, b"maxDepth", JSValue::js_number(f64::INFINITY));
    config.put(global, b"maxWidth", JSValue::js_number(f64::INFINITY));
    config.put(global, b"min", JSValue::FALSE);
    config.put(global, b"plugins", plugins);
    config.put(global, b"printBasicPrototype", JSValue::FALSE);
    config.put(global, b"printFunctionName", JSValue::FALSE);
    config.put(global, b"spacingInner", static_string(global, "\n")?);
    config.put(global, b"spacingOuter", static_string(global, "\n")?);
    Ok(config)
}

fn indentation_bytes(indent: u32) -> Vec<u8> {
    vec![b' '; indent as usize * 2]
}

impl Formatter<'_> {
    /// `true` when a serializer printed `value`. Kept out of `format()`, whose frame recurses.
    #[inline(never)]
    pub(crate) fn print_with_serializer<W: bun_io::Write>(
        &mut self,
        writer: &mut W,
        value: JSValue,
    ) -> JsResult<bool> {
        let global = self.global_this;
        for i in 0..self.serializers.len() {
            let serializer = self.serializers[i];
            let Some(test) = callable(global, serializer, "test")? else {
                continue;
            };
            if !test.call(global, serializer, &[value])?.to_boolean() {
                continue;
            }

            let printed = self.call_serializer(serializer, value)?;
            if !printed.is_string() {
                return Err(global.throw_type_error(format_args!(
                    "Snapshot serializer must return a string, but it returned {}",
                    printed.js_type_string(global),
                )));
            }
            let printed = printed.to_utf8(global)?;
            let printed: &[u8] = &printed;

            // What jest-snapshot's `addExtraLineBreaks` does to the whole snapshot.
            let extra_line_breaks = self.is_snapshot_root() && strings::contains_char(printed, b'\n');
            self.add_for_new_line(printed.len());
            let mut writer = WrappedWriter::new(writer);
            if extra_line_breaks {
                writer.write_all(b"\n");
            }
            writer.write_all(printed);
            if extra_line_breaks {
                writer.write_all(b"\n");
            }
            if writer.failed {
                self.failed = true;
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn call_serializer(&mut self, serializer: JSValue, value: JSValue) -> JsResult<JSValue> {
        let global = self.global_this;
        if self.serializer_config.is_empty() {
            self.serializer_config = create_config(global, &self.serializers)?;
        }
        let config = self.serializer_config;
        let level = JSValue::js_number(f64::from(self.indent));
        // The values this one is nested in. They come back through `printer()` / `print()`, which
        // is how a cycle that runs through a serializer still ends in `[Circular]`.
        let refs = JSValue::create_empty_array(global, self.map.len())?;
        for (i, visited) in self.map.keys().enumerate() {
            refs.put_index(global, i as u32, *visited)?;
        }

        if let Some(serialize) = callable(global, serializer, "serialize")? {
            let indentation = bun_string_jsc::create_utf8_for_js(global, &indentation_bytes(self.indent))?;
            let printer = JSFunction::create(global, "printer", __jsc_host_printer, 5, Default::default());
            return serialize.call(global, serializer, &[value, config, indentation, level, refs, printer]);
        }

        let Some(print) = callable(global, serializer, "print")? else {
            return Err(global.throw_type_error(format_args!(
                "Snapshot serializer has neither a serialize() nor a print() function"
            )));
        };
        let print_child = JSFunction::create(global, "print", __jsc_host_print_child, 1, Default::default())
            .bind(global, JSValue::UNDEFINED, &BunString::static_("print"), 1.0, &[level, config, refs])?;
        let indent = JSFunction::create(global, "indent", __jsc_host_indent_lines, 1, Default::default())
            .bind(global, JSValue::UNDEFINED, &BunString::static_("indent"), 1.0, &[level])?;
        let options = JSValue::create_empty_object(global, 3);
        options.put(global, b"edgeSpacing", static_string(global, "\n")?);
        options.put(global, b"min", JSValue::FALSE);
        options.put(global, b"spacing", static_string(global, "\n")?);
        let colors = config.get(global, "colors")?.unwrap_or(JSValue::UNDEFINED);
        print.call(global, serializer, &[value, print_child, indent, options, colors])
    }
}

/// Formats a value a serializer handed back, `indent` levels deep. `config` and `refs` are
/// what the serializer passed along.
fn print_nested(
    global: &JSGlobalObject,
    value: JSValue,
    indent: u32,
    config: JSValue,
    refs: JSValue,
) -> JsResult<JSValue> {
    if !StackCheck::init().is_safe_to_recurse() {
        return Err(global.throw_stack_overflow());
    }
    // `refs` is script's to change while the values are in the visited map. This copy is not.
    let mut visited: Vec<JSValue> = Vec::new();
    let mut keep_alive = JSValue::UNDEFINED;
    if refs.js_type().is_array() {
        let len = refs.get_length(global)?.min(u64::from(u32::MAX)) as u32;
        keep_alive = JSValue::create_empty_array(global, len as usize)?;
        for i in 0..len {
            let visited_value = refs.get_index(global, i)?;
            keep_alive.put_index(global, i, visited_value)?;
            visited.push(visited_value);
        }
    }
    let mut out: Vec<u8> = Vec::new();
    let result = JestPrettyFormat::format_for_serializer(
        global,
        value,
        &mut out,
        indent,
        if config.is_object() { config } else { JSValue::ZERO },
        &visited,
    );
    keep_alive.ensure_still_alive();
    result?;
    bun_string_jsc::create_utf8_for_js(global, &out)
}

fn indent_level(value: JSValue) -> u32 {
    if value.is_number() { value.to_int32().clamp(0, 1 << 16) as u32 } else { 0 }
}

/// `printer(value, config, indentation, depth, refs)`, the last argument of `serialize()`.
#[bun_jsc::host_fn]
fn printer(global: &JSGlobalObject, call_frame: &CallFrame) -> JsResult<JSValue> {
    let [value, config, indentation, _depth, refs] = call_frame.arguments_as_array::<5>();
    let indent = if indentation.is_string() { (indentation.get_length(global)? / 2).min(1 << 16) as u32 } else { 0 };
    print_nested(global, value, indent, config, refs)
}

/// `print(value)` of the older interface, bound to the indent level, `config` and `refs` of
/// the value the serializer is printing.
#[bun_jsc::host_fn]
fn print_child(global: &JSGlobalObject, call_frame: &CallFrame) -> JsResult<JSValue> {
    let [level, config, refs, value] = call_frame.arguments_as_array::<4>();
    print_nested(global, value, indent_level(level), config, refs)
}

/// `indent(text)` of the older interface, bound like [`print_child`]: every line of `text`,
/// one level further in.
#[bun_jsc::host_fn]
fn indent_lines(global: &JSGlobalObject, call_frame: &CallFrame) -> JsResult<JSValue> {
    let [level, text] = call_frame.arguments_as_array::<2>();
    let text = text.to_utf8(global)?;
    let indentation = indentation_bytes(indent_level(level) + 1);

    let mut out: Vec<u8> = Vec::with_capacity(text.len() + indentation.len());
    for (i, line) in strings::split(&text, b"\n").enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(&indentation);
        out.extend_from_slice(line);
    }
    bun_string_jsc::create_utf8_for_js(global, &out)
}
