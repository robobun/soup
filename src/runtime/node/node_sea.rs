//! `node:sea` for an executable made by `bun build --compile`. Its assets are the files embedded in the executable,
//! under the names `Bun.embeddedFiles` gives them.

use bun_core::strings;
use bun_jsc::bindgen::JsHeap;
use bun_jsc::{ArrayBuffer, JSType, JSValue, JsResult};
use bun_standalone_graph::StandaloneModuleGraph::BASE_PUBLIC_PATH_WITH_DEFAULT_SUFFIX;
use bun_standalone_graph::{File, Graph};

use crate::webcore::blob::{Blob, BlobExt as _};

pub(crate) fn is_sea() -> bool {
    Graph::get_ref().is_some()
}

/// The file that `Bun.embeddedFiles` lists as `key`. The source code of the application is not an asset.
fn find_asset(key: &[u8]) -> Option<&'static File> {
    let graph = Graph::get_ref()?;
    let mut path = Vec::with_capacity(BASE_PUBLIC_PATH_WITH_DEFAULT_SUFFIX.len() + key.len());
    path.extend_from_slice(BASE_PUBLIC_PATH_WITH_DEFAULT_SUFFIX.as_bytes());
    path.extend_from_slice(key);
    graph
        .files
        .get(&path)
        .filter(|file| file.appears_in_embedded_files_array())
}

pub(crate) fn get_asset(heap: &JsHeap<'_>, key: &[u8]) -> JsResult<JSValue> {
    let Some(file) = find_asset(key) else {
        return Ok(JSValue::UNDEFINED);
    };
    // SAFETY: copying the bytes into a new `ArrayBuffer` runs no JavaScript.
    let global = unsafe { heap.global() };
    ArrayBuffer::create::<{ JSType::ArrayBuffer }>(global, file.utf8_contents())
}

pub(crate) fn get_asset_as_blob(heap: &JsHeap<'_>, key: &[u8]) -> JsResult<JSValue> {
    let Some(file) = find_asset(key) else {
        return Ok(JSValue::UNDEFINED);
    };
    // SAFETY: making a `Blob` and its wrapper runs no JavaScript.
    let global = unsafe { heap.global() };
    let blob = Blob::new(crate::api::standalone_graph_jsc::file_blob(file, global));
    // SAFETY: `blob` is heap-allocated and lives until JS owns it via to_js.
    Ok(unsafe { (*blob).to_js(global) })
}

/// In the order of `Bun.embeddedFiles`.
pub(crate) fn get_asset_keys() -> Vec<&'static [u8]> {
    let Some(graph) = Graph::get_ref() else {
        return Vec::new();
    };
    let mut keys: Vec<&'static [u8]> = graph
        .files
        .values()
        .iter()
        .filter(|file| file.appears_in_embedded_files_array())
        .map(|file| file.display_name())
        .collect();
    keys.sort_unstable_by(|a, b| strings::order(a, b));
    keys
}
