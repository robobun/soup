use bun_core::{String as BunString, strings};
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult, StringJsc as _, bun_string_jsc};
use bun_s3_signing::Metadata;

bun_output::declare_scope!(S3Stat, visible);

#[bun_jsc::JsClass]
pub(crate) struct S3Stat {
    pub(crate) size: u64,
    pub(crate) etag: BunString,
    pub(crate) content_type: BunString,
    pub(crate) last_modified: f64,
    /// The `x-amz-meta-*` headers of the response: the names in lowercase
    /// without the prefix, and the values.
    pub(crate) metadata: Vec<(Box<[u8]>, Box<[u8]>)>,
}

impl S3Stat {
    pub(crate) fn constructor(global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<Box<Self>> {
        Err(global.throw_illegal_constructor())
    }

    pub(crate) fn init(
        size: u64,
        etag: &[u8],
        content_type: &[u8],
        last_modified: &[u8],
        headers: &[bun_picohttp::Header],
        global: &JSGlobalObject,
    ) -> JsResult<Box<Self>> {
        let last_modified =
            bun_string_jsc::parse_date(&BunString::from_bytes(last_modified), global)?;

        let metadata = headers
            .iter()
            .filter(|header| {
                header.name().len() > Metadata::PREFIX.len()
                    && strings::has_prefix_case_insensitive(header.name(), Metadata::PREFIX)
            })
            .map(|header| {
                let key = header.name()[Metadata::PREFIX.len()..].to_ascii_lowercase();
                (key.into_boxed_slice(), Box::from(header.value()))
            })
            .collect();

        Ok(Box::new(S3Stat {
            size,
            etag: BunString::clone_utf8(etag),
            content_type: BunString::clone_utf8(content_type),
            last_modified,
            metadata,
        }))
    }

    #[bun_jsc::host_fn(getter)]
    pub(crate) fn get_size(&self, _global: &JSGlobalObject) -> JSValue {
        JSValue::js_number(self.size as f64)
    }

    #[bun_jsc::host_fn(getter)]
    pub(crate) fn get_etag(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        self.etag.to_js(global)
    }

    #[bun_jsc::host_fn(getter)]
    pub(crate) fn get_content_type(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        self.content_type.to_js(global)
    }

    #[bun_jsc::host_fn(getter)]
    pub(crate) fn get_last_modified(&self, global: &JSGlobalObject) -> JSValue {
        JSValue::from_date_number(global, self.last_modified)
    }

    #[bun_jsc::host_fn(getter)]
    pub(crate) fn get_metadata(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        let metadata = JSValue::create_empty_object(global, self.metadata.len());
        for (key, value) in &self.metadata {
            metadata.put_may_be_index(
                global,
                &BunString::clone_utf8(key),
                bun_string_jsc::create_utf8_for_js(global, value)?,
            )?;
        }
        Ok(metadata)
    }
}
