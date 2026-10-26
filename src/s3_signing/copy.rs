//! CopyObject: the headers that turn a `PUT` into a server-side copy. Only this file names them.

use bun_core::strings;

use crate::credentials::{S3Credentials, bucket_and_key, encode_uri_component, normalize_name};
use crate::metadata::{AmzHeaders, Metadata, MetadataError};

const COPY_SOURCE: &[u8] = b"x-amz-copy-source";
const IF_MATCH: &[u8] = b"x-amz-copy-source-if-match";
const IF_MODIFIED_SINCE: &[u8] = b"x-amz-copy-source-if-modified-since";
const IF_NONE_MATCH: &[u8] = b"x-amz-copy-source-if-none-match";
const IF_UNMODIFIED_SINCE: &[u8] = b"x-amz-copy-source-if-unmodified-since";
const METADATA_DIRECTIVE: &[u8] = b"x-amz-metadata-directive";

const NAMES: [&[u8]; CopyHeaders::COUNT] = [
    COPY_SOURCE,
    IF_MATCH,
    IF_MODIFIED_SINCE,
    IF_NONE_MATCH,
    IF_UNMODIFIED_SINCE,
    METADATA_DIRECTIVE,
];

const fn sorts_before(a: &[u8], b: &[u8]) -> bool {
    let mut i = 0;
    while i < a.len() && i < b.len() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
        i += 1;
    }
    a.len() < b.len()
}

// `sign_request` writes the entries of an `AmzHeaders` between these two headers only.
const _: () = {
    let mut i = 0;
    while i < NAMES.len() {
        assert!(sorts_before(AmzHeaders::BEFORE_ENTRIES, NAMES[i]));
        assert!(sorts_before(NAMES[i], AmzHeaders::AFTER_ENTRIES));
        i += 1;
    }
};

/// `x-amz-metadata-directive`: what the new object gets its metadata and its content headers from.
pub enum MetadataDirective {
    /// No header. The service copies them from the source.
    Default,
    /// `COPY`, said in the request.
    Copy,
    /// `REPLACE`: from the request, as an upload, with these `x-amz-meta-*` entries.
    Replace(Metadata),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyHeadersError {
    /// The path of the source has no key or no bucket.
    InvalidSource,
    /// A virtual hosted-style endpoint has the bucket in a host that does not tell its name.
    UnknownBucket,
    /// A condition has a byte that is not printable ASCII.
    InvalidValue,
}

/// The headers of a CopyObject request, next to the ones every upload has.
pub struct CopyHeaders<'a> {
    /// Names the source. The request itself is signed with the credentials of the destination.
    pub source: &'a S3Credentials,
    /// The path of the source, as `sign_request` takes the path of a request.
    pub source_path: &'a [u8],
    pub if_match: Option<&'a [u8]>,
    pub if_none_match: Option<&'a [u8]>,
    pub if_modified_since: Option<&'a [u8]>,
    pub if_unmodified_since: Option<&'a [u8]>,
    pub directive: MetadataDirective,
}

impl CopyHeaders<'_> {
    /// How many headers this module can add to a request.
    pub const COUNT: usize = 6;

    /// The headers and the metadata of a `Replace`, sorted by name, for `SignOptions::metadata`.
    pub fn into_signed(self) -> Result<AmzHeaders, CopyHeadersError> {
        let (mut headers, directive) = match self.directive {
            MetadataDirective::Default => (AmzHeaders::default(), None),
            MetadataDirective::Copy => (AmzHeaders::default(), Some(&b"COPY"[..])),
            MetadataDirective::Replace(metadata) => {
                (metadata.into_headers(), Some(&b"REPLACE"[..]))
            }
        };
        let source = source_value(self.source, self.source_path)?;
        let optional = [
            (IF_MATCH, self.if_match),
            (IF_MODIFIED_SINCE, self.if_modified_since),
            (IF_NONE_MATCH, self.if_none_match),
            (IF_UNMODIFIED_SINCE, self.if_unmodified_since),
            (METADATA_DIRECTIVE, directive),
        ];
        let present = optional
            .into_iter()
            .filter_map(|(name, value)| Some((name, value?)));
        for (name, value) in core::iter::once((COPY_SOURCE, &source[..])).chain(present) {
            headers.insert(name, value).map_err(|err| match err {
                MetadataError::InvalidValue => CopyHeadersError::InvalidValue,
                // The names are distinct, and none is an `x-amz-meta-*` one.
                MetadataError::InvalidKey | MetadataError::DuplicateKey => unreachable!(),
            })?;
        }
        Ok(headers)
    }
}

/// The object that a request of `credentials` for `path` reads, as the service names it: `bucket/key`, URL-encoded.
fn source_value(credentials: &S3Credentials, path: &[u8]) -> Result<Vec<u8>, CopyHeadersError> {
    bucket_and_key!(
        credentials,
        path,
        bucket,
        key,
        CopyHeadersError::InvalidSource
    );
    let in_host = if credentials.virtual_hosted_style {
        match hosted_bucket(credentials) {
            // `sign_request` refuses a bucket that would change the host.
            HostedBucket::Named(bucket) if strings::index_of_any(bucket, b"/\\").is_some() => {
                return Err(CopyHeadersError::InvalidSource);
            }
            HostedBucket::Named(bucket) => Some(bucket),
            HostedBucket::Unknown | HostedBucket::Mismatch(_) => {
                return Err(CopyHeadersError::UnknownBucket);
            }
        }
    } else {
        None
    };
    let bucket = in_host.unwrap_or(bucket);
    if key.is_empty() || bucket.is_empty() {
        return Err(CopyHeadersError::InvalidSource);
    }

    // The sizes `sign_request` has for a key and a bucket.
    let mut key_buffer = [0u8; 1024];
    let mut bucket_buffer = [0u8; 63];
    let bucket = encode_uri_component::<false>(bucket, &mut bucket_buffer)
        .map_err(|_| CopyHeadersError::InvalidSource)?;
    let key = encode_uri_component::<false>(key, &mut key_buffer)
        .map_err(|_| CopyHeadersError::InvalidSource)?;
    // Amazon S3 and R2 have their API at the root of a host, so the path of an endpoint is a part of the name.
    let in_name = match service(credentials) {
        Service::Other { .. } => b"",
        Service::Amazon(_) | Service::R2(_) => split_endpoint(&credentials.endpoint).1,
    };
    let mut value = Vec::with_capacity(in_name.len() + bucket.len() + 1 + key.len());
    if in_host.is_some() {
        value.extend_from_slice(bucket);
        value.extend_from_slice(in_name);
    } else {
        // `sign_request` has the path of the endpoint before the bucket.
        if let Some(before_bucket) = in_name.strip_prefix(b"/") {
            value.extend_from_slice(before_bucket);
            value.push(b'/');
        }
        value.extend_from_slice(bucket);
    }
    value.push(b'/');
    value.extend_from_slice(key);
    Ok(value)
}

enum HostedBucket<'a> {
    Named(&'a [u8]),
    Unknown,
    /// The `bucket` of the credentials is not the one of the host, and the request goes to the host.
    Mismatch(&'a [u8]),
}

/// The bucket that a virtual hosted-style request of `credentials` goes to.
fn hosted_bucket(credentials: &S3Credentials) -> HostedBucket<'_> {
    let named = normalize_name(&credentials.bucket);
    if credentials.endpoint.is_empty() {
        // `sign_request` makes the host from the bucket.
        return match named {
            b"" => HostedBucket::Unknown,
            named => HostedBucket::Named(named),
        };
    }
    let host = without_port(split_endpoint(&credentials.endpoint).0);
    match bucket_in_host(host) {
        Some(in_host) if named.is_empty() || named == in_host => HostedBucket::Named(in_host),
        Some(_) => HostedBucket::Mismatch(named),
        None if named.is_empty() => HostedBucket::Unknown,
        None if host == named => HostedBucket::Named(named),
        None => match host.strip_prefix(named) {
            Some(rest) if rest.starts_with(b".") => HostedBucket::Named(named),
            _ => HostedBucket::Mismatch(named),
        },
    }
}

/// Whether `credentials` have a virtual hosted-style endpoint that does not say which bucket it is the host of.
pub fn is_bucket_unknown(credentials: &S3Credentials) -> bool {
    credentials.virtual_hosted_style && matches!(hosted_bucket(credentials), HostedBucket::Unknown)
}

/// The `bucket` of `credentials`, if their virtual hosted-style endpoint goes to another bucket.
pub fn bucket_mismatch(credentials: &S3Credentials) -> Option<&[u8]> {
    if !credentials.virtual_hosted_style {
        return None;
    }
    match hosted_bucket(credentials) {
        HostedBucket::Mismatch(named) => Some(named),
        HostedBucket::Named(_) | HostedBucket::Unknown => None,
    }
}

/// The `host[:port]` and the path of an endpoint, as `sign_request` splits it.
fn split_endpoint(endpoint: &[u8]) -> (&[u8], &[u8]) {
    match strings::index_of_char_usize(endpoint, b'/') {
        Some(slash) => endpoint.split_at(slash),
        None => (endpoint, b""),
    }
}

fn without_port(host: &[u8]) -> &[u8] {
    strings::split_once_char(host, b':').map_or(host, |(host, _)| host)
}

const R2: &[u8] = b".r2.cloudflarestorage.com";

/// A host of Amazon without `.amazonaws.com` or `.amazonaws.com.cn`.
fn amazon_labels(host: &[u8]) -> Option<&[u8]> {
    host.strip_suffix(b".amazonaws.com.cn")
        .or_else(|| host.strip_suffix(b".amazonaws.com"))
}

/// The labels of a host of Amazon S3 around its last `s3` or `s3-*` label: before it, the label, after it.
fn split_at_s3_label(labels: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    let mut end = labels.len();
    loop {
        let start = strings::last_index_of_char(&labels[..end], b'.').map_or(0, |dot| dot + 1);
        let label = &labels[start..end];
        if label == b"s3" || label.starts_with(b"s3-") {
            let after = labels.get(end + 1..).unwrap_or_default();
            return Some((&labels[..start.saturating_sub(1)], label, after));
        }
        if start == 0 {
            return None;
        }
        end = start - 1;
    }
}

/// The bucket in a virtual hosted-style host of Amazon S3 or of R2. No other host says which of its labels are a bucket.
fn bucket_in_host(host: &[u8]) -> Option<&[u8]> {
    if let Some(labels) = host.strip_suffix(R2) {
        let (labels, last) = strings::rsplit_once_char(labels, b'.')?;
        let (bucket, account) = match last {
            b"eu" | b"fedramp" => strings::rsplit_once_char(labels, b'.')?,
            account => (labels, account),
        };
        let is_account = account.len() == 32 && account.iter().all(u8::is_ascii_hexdigit);
        return (is_account && !bucket.is_empty()).then_some(bucket);
    }
    let (bucket, s3, after) = split_at_s3_label(amazon_labels(host)?)?;
    // `s3-us-west-2` and `s3-external-1` are hosts of buckets. An access point, a website and PrivateLink are not.
    let is_for_buckets = match s3 {
        b"s3" | b"s3-fips" | b"s3-accelerate" => true,
        s3 => s3.last().is_some_and(u8::is_ascii_digit) && !s3.starts_with(b"s3-website"),
    };
    let region = after.strip_prefix(b"dualstack").unwrap_or(after);
    let region = region.strip_prefix(b".").unwrap_or(region);
    let is_region = !strings::contains_char(region, b'.') && region != b"vpce";
    (is_for_buckets && is_region && !bucket.is_empty()).then_some(bucket)
}

#[derive(PartialEq, Eq)]
enum AmazonPartition {
    Standard,
    China,
    GovCloud,
}

/// Where the objects of some credentials are.
enum Service<'a> {
    /// Amazon S3 has one set of buckets in each partition, whatever the region.
    Amazon(AmazonPartition),
    /// An account of R2 in one jurisdiction: its host.
    R2(&'a [u8]),
    /// The host without the bucket of a virtual hosted-style host name, and where the S3 API is in it.
    Other { host: &'a [u8], root: &'a [u8] },
}

fn service(credentials: &S3Credentials) -> Service<'_> {
    if credentials.endpoint.is_empty() {
        let region: &[u8] = &credentials.region;
        return Service::Amazon(if region.starts_with(b"us-gov-") {
            AmazonPartition::GovCloud
        } else if region.starts_with(b"cn-") {
            AmazonPartition::China
        } else {
            AmazonPartition::Standard
        });
    }
    let (mut host, root) = split_endpoint(&credentials.endpoint);
    if credentials.virtual_hosted_style {
        if let HostedBucket::Named(bucket) = hosted_bucket(credentials) {
            // A host that is the name of its bucket has no other part.
            let without_bucket = host.strip_prefix(bucket);
            host = without_bucket
                .and_then(|rest| rest.strip_prefix(b"."))
                .unwrap_or(host);
        }
    }
    let name = without_port(host);
    if name.ends_with(R2) {
        return Service::R2(host);
    }
    // `ec2-203-0-113-10.compute-1.amazonaws.com` is a host of Amazon and not of Amazon S3.
    match amazon_labels(name).and_then(split_at_s3_label) {
        Some(_) if name.ends_with(b".cn") => Service::Amazon(AmazonPartition::China),
        Some((_, s3, after))
            if [s3, after]
                .iter()
                .any(|part| strings::contains(part, b"us-gov-")) =>
        {
            Service::Amazon(AmazonPartition::GovCloud)
        }
        Some(_) => Service::Amazon(AmazonPartition::Standard),
        None => Service::Other { host, root },
    }
}

/// Whether `destination` has the objects of `source`: one partition of Amazon S3, or one host of another service.
pub fn is_same_service(source: &S3Credentials, destination: &S3Credentials) -> bool {
    let is_same = |a: &[u8], b: &[u8]| a.eq_ignore_ascii_case(b);
    match (service(source), service(destination)) {
        (Service::Amazon(source), Service::Amazon(destination)) => source == destination,
        (Service::R2(source), Service::R2(destination)) => is_same(source, destination),
        (
            Service::Other { host, root },
            Service::Other {
                host: to_host,
                root: to_root,
            },
        ) => {
            // Two hosts that are one endpoint are one service, also when nothing says which part is the bucket.
            (is_same(host, to_host) && root == to_root)
                || is_same(&source.endpoint, &destination.endpoint)
        }
        _ => false,
    }
}
