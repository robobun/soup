use bun_core::{String as BunString, StringView, strings};
use bun_jsc::{JSGlobalObject, JsResult, bun_string_jsc};
use bun_s3_signing::Metadata;

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
    pub(crate) fn init(
        size: u64,
        etag: &[u8],
        content_type: &[u8],
        last_modified: &[u8],
        headers: &[bun_picohttp::Header],
        global: &JSGlobalObject,
    ) -> JsResult<Self> {
        let last_modified =
            bun_string_jsc::parse_date(&StringView::from_bytes(last_modified), global)?;

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

        Ok(S3Stat {
            size,
            etag: BunString::clone_utf8(etag),
            content_type: BunString::clone_utf8(content_type),
            last_modified,
            metadata,
        })
    }
}

impl S3Stat {
    pub(crate) fn get_etag(&self) -> BunString {
        self.etag.clone()
    }

    pub(crate) fn get_last_modified(&self) -> f64 {
        self.last_modified
    }

    pub(crate) fn get_metadata(
        &self,
    ) -> impl IntoIterator<Item = (impl AsRef<[u8]>, impl AsRef<[u8]>)> {
        self.metadata.iter().map(|(key, value)| (key, value))
    }

    pub(crate) fn get_size(&self) -> u64 {
        self.size
    }

    pub(crate) fn get_type(&self) -> BunString {
        self.content_type.clone()
    }
}
