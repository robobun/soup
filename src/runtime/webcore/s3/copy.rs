//! `S3Client.copy()` and `S3File.copyTo()`: one CopyObject request, signed and sent as the destination.

use core::ffi::c_void;

use bun_core::{StringView, strings};
use bun_http_types::wtf::write_http_date;
use bun_jsc::{ErrorCode, JSGlobalObject, JSValue, JsResult, bun_string_jsc};
use bun_ptr::RefPtr;
use bun_s3_signing::copy::{bucket_mismatch, is_bucket_unknown, is_same_service};
use bun_s3_signing::error::{ErrorCodeAndMessage, S3Error, get_sign_error_code_and_message};
use bun_s3_signing::{
    ACL, CopyHeaders, CopyHeadersError, Metadata, MetadataDirective, MultiPartUploadOptions,
    S3Credentials, StorageClass,
};

use crate::node::types::PathOrFdExt as _;
use crate::node::{PathLike, PathOrFileDescriptor};
use crate::webcore::blob::store::{S3, Store, StoreExt as _};
use crate::webcore::blob::{Blob, BlobContentType, MAX_SIZE, is_valid_blob_type};
use crate::webcore::s3::client as s3;
use crate::webcore::s3::client::error_jsc::s3_error_to_js_with_async_stack;
use crate::webcore::s3::credentials_jsc::{MAX_METADATA_ENTRIES, get_credentials_with_options};

/// The source or the destination of a copy.
pub(crate) enum Object {
    /// A destination key is read with [`Defaults`]. A source key is in the bucket of the destination.
    Key(PathLike<'static>),
    /// An S3 file, as it is. The view owns a reference to its store.
    File(Box<Blob>),
}

impl Object {
    /// A path or an S3 file, as the static methods of `S3Client` take one.
    pub(crate) fn from_js(
        global: &JSGlobalObject,
        value: JSValue,
        error_message: &str,
    ) -> JsResult<Object> {
        if value.is_undefined_or_null() {
            return Err(global
                .err(ErrorCode::MISSING_ARGS, format_args!("{error_message}"))
                .throw());
        }
        let mut arguments = bun_jsc::call_frame::ArgumentsSlice::init(
            global.bun_vm(),
            core::slice::from_ref(&value),
        );
        match PathOrFileDescriptor::from_js(global, &mut arguments)? {
            // The clone owns a copy of a buffer's bytes.
            Some(PathOrFileDescriptor::Path(path)) => return Ok(Object::Key(path.clone())),
            Some(PathOrFileDescriptor::Fd(_)) => {}
            None => {
                if let Some(blob) = value.as_class_ref::<Blob>().filter(|blob| blob.is_s3()) {
                    return Ok(Object::File(Box::new(blob.borrowed_view())));
                }
            }
        }
        Err(global.throw_invalid_arguments(format_args!("{error_message}")))
    }
}

/// What a destination key starts from, before the options of the call.
pub(crate) struct Defaults<'a> {
    pub(crate) credentials: &'a S3Credentials,
    pub(crate) options: MultiPartUploadOptions,
    pub(crate) acl: Option<ACL>,
    pub(crate) storage_class: Option<StorageClass>,
    pub(crate) request_payer: bool,
    pub(crate) metadata: Option<&'a Metadata>,
}

impl<'a> Defaults<'a> {
    pub(crate) fn of_file(s3: &'a S3) -> Self {
        Defaults {
            credentials: s3.get_credentials(),
            options: s3.options,
            acl: s3.acl,
            storage_class: s3.storage_class,
            request_payer: s3.request_payer,
            metadata: s3.metadata.as_ref(),
        }
    }

    pub(crate) fn of_credentials(credentials: &'a S3Credentials) -> Self {
        Defaults {
            credentials,
            options: MultiPartUploadOptions::default(),
            acl: None,
            storage_class: None,
            request_payer: false,
            metadata: None,
        }
    }
}

bun_core::comptime_string_map! {
    /// `options.metadataDirective`: whether the copy replaces the metadata of the source.
    static REPLACES_METADATA: bool = {
        b"COPY" => false,
        b"REPLACE" => true,
    };
}

/// `options.{name}` of a condition. Only `undefined` is no condition: `Headers.get("etag")` is `null` for no header.
fn condition(
    global: &JSGlobalObject,
    options: JSValue,
    name: &'static str,
) -> JsResult<Option<JSValue>> {
    Ok(options
        .get(global, name)?
        .filter(|value| !value.is_undefined()))
}

/// `options.{name}` as the value of `x-amz-copy-source-if-match` or `x-amz-copy-source-if-none-match`.
fn entity_tag_condition(
    global: &JSGlobalObject,
    options: JSValue,
    name: &'static str,
) -> JsResult<Option<Box<[u8]>>> {
    let Some(value) = condition(global, options, name)? else {
        return Ok(None);
    };
    if !value.is_string() {
        return Err(global.throw_invalid_argument_type_value(name, "string", value));
    }
    let text = value.to_utf8(global)?;
    let entity_tag = strings::trim(text.slice(), b" ");
    // An empty condition would make the copy unconditional without a word.
    if entity_tag.is_empty() {
        return Err(global.throw_invalid_arguments(format_args!("{name} must not be empty")));
    }
    if !entity_tag.iter().all(|&c| matches!(c, 0x20..=0x7E)) {
        return Err(global
            .throw_invalid_arguments(format_args!("{name} must be printable ASCII characters")));
    }
    Ok(Some(Box::from(entity_tag)))
}

/// `options.{name}` as the HTTP date of `x-amz-copy-source-if-modified-since` or `x-amz-copy-source-if-unmodified-since`.
fn time_condition(
    global: &JSGlobalObject,
    options: JSValue,
    name: &'static str,
) -> JsResult<Option<Box<[u8]>>> {
    /// `gmtime_s` of Windows, which `write_http_date` calls there, has no later year than 3000.
    const YEAR_3001: f64 = 32_535_216_000_000.0;

    let Some(value) = condition(global, options, name)? else {
        return Ok(None);
    };
    if !value.is_date() {
        return Err(global.throw_invalid_argument_type_value2(name, "an instance of Date", value));
    }
    let milliseconds = value.get_unix_timestamp();
    let mut buffer = [0u8; 32];
    let date: &[u8] = match milliseconds as u64 {
        _ if milliseconds.is_nan() => b"",
        _ if !(0.0..YEAR_3001).contains(&milliseconds) => {
            return Err(global.throw_invalid_arguments(format_args!(
                "{name} must be a Date in the years 1970 to 3000"
            )));
        }
        // `write_http_date` takes 0 for no date.
        0 => b"Thu, 01 Jan 1970 00:00:00 GMT",
        milliseconds => write_http_date(&mut buffer, milliseconds),
    };
    if date.is_empty() {
        return Err(global.throw_invalid_arguments(format_args!("{name} must be a valid Date")));
    }
    Ok(Some(Box::from(date)))
}

/// The S3 store of a file of a copy. A slice of a file is refused: CopyObject has no range.
fn whole_file(global: &JSGlobalObject, blob: &Blob, role: &'static str) -> JsResult<RefPtr<Store>> {
    let store = blob
        .store()
        .filter(|store| matches!(store.data, crate::webcore::blob::store::Data::S3(_)))
        .cloned();
    let Some(store) = store else {
        return Err(
            global.throw_invalid_arguments(format_args!("The {role} of a copy must be an S3 file"))
        );
    };
    if blob.offset.get() > 0 || blob.size.get() != MAX_SIZE {
        return Err(global.throw_invalid_arguments(format_args!(
            "The {role} of a copy cannot be a slice of an S3 file: a server-side copy takes the whole object"
        )));
    }
    Ok(store)
}

/// The endpoint of an error message. Credentials without one are for a region of Amazon S3.
struct EndpointName<'a>(&'a S3Credentials);

impl core::fmt::Display for EndpointName<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let S3Credentials {
            endpoint, region, ..
        } = self.0;
        if !endpoint.is_empty() {
            return write!(f, "\"{}\"", bstr::BStr::new(endpoint));
        }
        let region: &[u8] = match &**region {
            b"" => bun_s3_signing::guess_region(endpoint),
            region => region,
        };
        write!(f, "Amazon S3 in {}", bstr::BStr::new(region))
    }
}

struct CopyTask {
    promise: bun_jsc::JSPromiseStrong,
    global: bun_ptr::BackRef<JSGlobalObject>,
    source: RefPtr<Store>,
    destination: RefPtr<Store>,
}

impl CopyTask {
    fn on_response(result: s3::S3CopyResult, this: *mut c_void) -> JsResult<()> {
        // SAFETY: `this` is the box `copy` leaked with heap::into_raw. Taking it back frees it on return.
        let mut this = unsafe { bun_core::heap::take(this.cast::<CopyTask>()) };
        // Copy the BackRef out so `this` is not borrowed across `&mut this.promise`.
        let global_ref = this.global;
        let global = global_ref.get();
        match result {
            s3::S3CopyResult::Success(copied) => {
                match Self::result_to_js(global, copied.etag, copied.last_modified) {
                    Ok(value) => this.promise.resolve(global, value)?,
                    Err(err) => this.promise.reject(global, Err(err))?,
                }
            }
            s3::S3CopyResult::Failure(err) => {
                let value = s3_error_to_js_with_async_stack(
                    &err,
                    global,
                    Some(this.source.data.as_s3().path()),
                    this.promise.get(),
                );
                let destination = this.destination.data.as_s3().path();
                match bun_string_jsc::create_utf8_for_js(global, destination) {
                    Ok(destination) => {
                        value.put(global, b"dest", destination);
                        this.promise.reject(global, Ok(value))?;
                    }
                    Err(err) => this.promise.reject(global, Err(err))?,
                }
            }
        }
        Ok(())
    }

    /// `{ etag, lastModified }`, with the entity tag in its quotes as `stat()` has it.
    fn result_to_js(
        global: &JSGlobalObject,
        etag: &[u8],
        last_modified: &[u8],
    ) -> JsResult<JSValue> {
        let etag = bun_string_jsc::create_utf8_for_js(global, etag)?;
        let last_modified =
            bun_string_jsc::parse_date(&StringView::from_bytes(last_modified), global)?;
        let result = JSValue::create_empty_object(global, 2);
        result.put(global, b"etag", etag);
        result.put(
            global,
            b"lastModified",
            JSValue::from_date_number(global, last_modified),
        );
        Ok(result)
    }
}

/// Starts the copy and returns its promise. Arguments that are not valid throw before a request.
pub(crate) fn copy(
    cx: &bun_jsc::JsThread<'_>,
    source: Object,
    destination: Object,
    key_defaults: Defaults<'_>,
    options: Option<JSValue>,
) -> JsResult<JSValue> {
    let global = cx.global();
    if let Some(options) = options.filter(|options| !options.is_object()) {
        return Err(global.throw_invalid_argument_type_value(b"options", b"object", options));
    }

    let source_file = match &source {
        Object::File(blob) => Some(whole_file(global, blob, "source")?),
        Object::Key(_) => None,
    };
    let destination_file = match &destination {
        Object::File(blob) => Some(whole_file(global, blob, "destination")?),
        Object::Key(_) => None,
    };

    let defaults = match &destination_file {
        Some(store) => Defaults::of_file(store.data.as_s3()),
        None => key_defaults,
    };
    // The request reads the bucket of the source too, and `requestPayer` is for the request.
    let request_payer = defaults.request_payer
        || source_file
            .as_ref()
            .is_some_and(|store| store.data.as_s3().request_payer);
    // Without the default metadata, so that `metadata` is the one of this call.
    let mut settings = get_credentials_with_options(
        defaults.credentials,
        defaults.options,
        options,
        defaults.acl,
        defaults.storage_class,
        request_payer,
        None,
        global,
    )?;

    let mut replaces_metadata = None;
    let mut if_match = None;
    let mut if_none_match = None;
    let mut if_modified_since = None;
    let mut if_unmodified_since = None;
    if let Some(options) = options {
        replaces_metadata = options.get_optional_enum_from_map(
            global,
            "metadataDirective",
            &REPLACES_METADATA,
            "\"COPY\", \"REPLACE\"",
        )?;
        if_match = entity_tag_condition(global, options, "copySourceIfMatch")?;
        if_none_match = entity_tag_condition(global, options, "copySourceIfNoneMatch")?;
        if_modified_since = time_condition(global, options, "copySourceIfModifiedSince")?;
        if_unmodified_since = time_condition(global, options, "copySourceIfUnmodifiedSince")?;
    }
    let replace = replaces_metadata == Some(true);

    let directive = if replace {
        let metadata = settings
            .metadata
            .take()
            .or_else(|| defaults.metadata.cloned())
            .unwrap_or_default();
        // The copy headers are in the list that has a place for each metadata entry.
        let limit = MAX_METADATA_ENTRIES - CopyHeaders::COUNT;
        if metadata.entries().len() > limit {
            return Err(global.throw_invalid_arguments(format_args!(
                "metadata must not have more than {limit} keys in a copy"
            )));
        }
        MetadataDirective::Replace(metadata)
    } else {
        let replaced = [
            ("type", settings.content_type.is_some()),
            ("contentDisposition", settings.content_disposition.is_some()),
            ("contentEncoding", settings.content_encoding.is_some()),
            ("metadata", settings.metadata.is_some()),
        ];
        if let Some((name, _)) = replaced.into_iter().find(|(_, given)| *given) {
            return Err(global.throw_invalid_arguments(format_args!(
                "{name} needs metadataDirective: \"REPLACE\". A copy keeps the type, the content headers and the metadata of its source, or it replaces all of them"
            )));
        }
        match replaces_metadata {
            Some(_) => MetadataDirective::Copy,
            None => MetadataDirective::Default,
        }
    };

    let source_credentials = source_file
        .as_ref()
        .map(|store| &**store.data.as_s3().get_credentials());
    let hosted = [
        ("destination", Some(&settings.credentials)),
        ("source", source_credentials),
    ];
    for (role, credentials) in hosted {
        let Some(credentials) = credentials else {
            continue;
        };
        if let Some(bucket) = bucket_mismatch(credentials) {
            return Err(global.throw_invalid_arguments(format_args!(
                "The {role} of a copy has the bucket \"{}\", but its virtual hosted-style endpoint \"{}\" does not name that bucket",
                bstr::BStr::new(bucket),
                bstr::BStr::new(&credentials.endpoint),
            )));
        }
    }

    // A key is a file of the destination's credentials from here on.
    let key_file = |path: PathLike<'static>| {
        Blob::init_with_store(
            Store::init_s3(path, None, settings.credentials.clone()).expect("oom"),
            global,
        )
    };
    let (source, is_source_key) = match source {
        Object::File(blob) => (*blob, false),
        Object::Key(path) => (key_file(path), true),
    };
    let destination = match destination {
        Object::File(blob) => *blob,
        Object::Key(path) => key_file(path),
    };
    let source_store = source_file.unwrap_or_else(|| source.store().cloned().expect("has a store"));
    let destination_store =
        destination_file.unwrap_or_else(|| destination.store().cloned().expect("has a store"));
    let source_s3 = source_store.data.as_s3();

    // As `sign_request` has it. Without credentials the endpoint is not the one of the caller either.
    let has_credentials = !settings.credentials.access_key_id.is_empty()
        && !settings.credentials.secret_access_key.is_empty();
    if has_credentials
        && !is_source_key
        && !is_same_service(source_s3.get_credentials(), &settings.credentials)
    {
        let is_unknown = is_bucket_unknown(source_s3.get_credentials())
            || is_bucket_unknown(&settings.credentials);
        return Err(global.throw_invalid_arguments(format_args!(
            "The source of a copy is at {} and the destination is at {}: a server-side copy runs inside one service{}",
            EndpointName(source_s3.get_credentials()),
            EndpointName(&settings.credentials),
            if is_unknown {
                ". If the two are one service, set the \"bucket\" option of each virtual hosted-style endpoint"
            } else {
                ""
            },
        )));
    }

    let headers = CopyHeaders {
        source: source_s3.get_credentials(),
        source_path: source_s3.path(),
        if_match: if_match.as_deref(),
        if_none_match: if_none_match.as_deref(),
        if_modified_since: if_modified_since.as_deref(),
        if_unmodified_since: if_unmodified_since.as_deref(),
        directive,
    }
    .into_signed();
    // What every S3 request rejects with, before it is sent.
    let headers = match headers {
        _ if !has_credentials => Err(get_sign_error_code_and_message(
            bun_s3_signing::Error::MissingCredentials,
        )),
        Ok(headers) => Ok(headers),
        Err(CopyHeadersError::InvalidSource) => Err(get_sign_error_code_and_message(
            bun_s3_signing::Error::InvalidPath,
        )),
        Err(CopyHeadersError::UnknownBucket) => Err(ErrorCodeAndMessage {
            code: b"ERR_S3_INVALID_PATH",
            message: b"The bucket of the source of a copy is not known: a virtual hosted-style endpoint has it in the host name only. Set the \"bucket\" option",
        }),
        Err(CopyHeadersError::InvalidValue) => {
            return Err(global.throw_invalid_arguments(format_args!(
                "The conditions of a copy must be printable ASCII characters"
            )));
        }
    };

    // What an upload to the destination sends. A copy that keeps the metadata of its source sends none.
    let (content_type, content_disposition, content_encoding) = if replace {
        // As `write()` reads `type`. `destination` is a view of this call: the caller's file keeps its type.
        if let Some(content_type) = &settings.content_type {
            if !is_valid_blob_type(content_type.slice()) {
                return Err(global.throw_invalid_arguments(format_args!(
                    "type must be printable ASCII characters"
                )));
            }
            destination.content_type.set(
                match global.bun_vm().as_mut().mime_type(content_type.slice()) {
                    Some(mime) => BlobContentType::from(mime),
                    None => BlobContentType::from_lowercased(content_type.slice()),
                },
            );
        }
        (
            destination.content_type_or_mime_type(),
            settings.content_disposition.as_deref(),
            settings.content_encoding.as_deref(),
        )
    } else {
        (None, None, None)
    };

    let promise = bun_jsc::JSPromiseStrong::init(global);
    let promise_value = promise.value();
    let task = bun_core::heap::into_raw(Box::new(CopyTask {
        promise,
        global: bun_ptr::BackRef::new(global),
        source: source_store.clone(),
        destination: destination_store.clone(),
    }))
    .cast::<c_void>();
    let headers = match headers {
        Ok(headers) => headers,
        Err(ErrorCodeAndMessage { code, message }) => {
            CopyTask::on_response(s3::S3CopyResult::Failure(S3Error { code, message }), task)?;
            return Ok(promise_value);
        }
    };
    s3::copy(
        &settings.credentials,
        cx.context(),
        destination_store.data.as_s3().path(),
        &headers,
        content_type,
        content_disposition,
        content_encoding,
        settings.acl,
        settings.storage_class,
        settings.request_payer,
        CopyTask::on_response,
        task,
    )?;
    Ok(promise_value)
}
