//! `Bun.INI` — `parse()` host function.
//!
//! The parser is the one `bun install` reads `.npmrc` with (`bun_ini`), so
//! the two agree on the format: npm/ini's dialect, where `[a.b]` nests,
//! `key[] = v` collects an array, bare `true`/`false`/`null` convert and a
//! quoted value is read as JSON. Here it runs without an environment, so a
//! `${VAR}` stays as written instead of being expanded like in `.npmrc`.

use bun_ini::Parser;
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsError, JsResult};

pub(crate) fn create(global: &JSGlobalObject) -> JSValue {
    bun_jsc::create_host_function_object(global, &[("parse", __jsc_host_parse, 1)])
}

#[bun_jsc::host_fn]
pub(crate) fn parse(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    super::with_text_format_source(
        global,
        frame,
        b"input.ini",
        super::BlobOrBufferInput::Bytes,
        super::NullishInput::Throw,
        |arena, _log, source| {
            // Every line of an INI file means something (npm/ini has no
            // syntax errors), so the only way this fails is running out of
            // memory.
            let mut parser = Parser::init(source, None);
            parser.parse(arena).map_err(|_| JsError::OutOfMemory)?;
            super::expr_to_js(parser.out, global)
        },
    )
}
