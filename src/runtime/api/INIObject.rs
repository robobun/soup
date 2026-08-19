//! `Bun.INI` — `parse()`.
//!
//! The parser is the one `bun install` reads `.npmrc` with (`bun_ini`), so
//! the two agree on the format: npm/ini's dialect, where `[a.b]` nests,
//! `key[] = v` collects an array, bare `true`/`false`/`null` convert and a
//! quoted value is read as JSON. Here it runs without an environment, so a
//! `${VAR}` stays as written instead of being expanded like in `.npmrc`.

use bun_ini::Parser;
use bun_jsc::bindgen::JsHeap;
use bun_jsc::{JSValue, JsError, JsResult};

pub(crate) fn parse(heap: &JsHeap<'_>, input: &[u8]) -> JsResult<JSValue> {
    // SAFETY: parsing runs no JavaScript. Nor does making the result: its keys are strings and its properties are
    // defined and not set. What throws returns without reading `input` again.
    let global = unsafe { heap.global() };
    super::with_text_format_source(global, input, b"input.ini", |arena, _log, source| {
        // Every line of an INI file means something (npm/ini has no syntax errors), so the only way this fails is
        // running out of memory.
        let mut parser = Parser::init(source, None);
        parser.parse(arena).map_err(|_| JsError::OutOfMemory)?;
        super::expr_to_js(parser.out, global)
    })
}
