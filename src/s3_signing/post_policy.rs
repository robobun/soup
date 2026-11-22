//! The fields and the signed policy of an S3 POST form: <https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html>

use std::io::Write as _;

use bstr::BStr;
use bun_core::fmt::{format_json_string_utf8, hex_lower};
use bun_core::strings;

use crate::credentials::{
    DIGESTED_HMAC_256_LEN, S3Credentials, SERVICE_NAME, SignError, amz_date_at, bucket_and_key,
    encode_uri_component, epoch_to_utc_components, guess_region, normalize_name, unix_time,
};
use crate::{ACL, AmzHeaders, StorageClass};

/// How a condition compares the value of a field.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Operator {
    Eq,
    StartsWith,
}

impl Operator {
    pub const fn name(self) -> &'static str {
        match self {
            Operator::Eq => "eq",
            Operator::StartsWith => "starts-with",
        }
    }
}

/// One condition of a policy.
#[derive(Clone, Copy)]
pub enum Condition<'a> {
    /// `{"name": "value"}`: the field `name` has this value.
    Field { name: &'a [u8], value: &'a [u8] },
    /// `["eq", "$name", "value"]` or `["starts-with", "$name", "value"]`.
    Match {
        operator: Operator,
        name: &'a [u8],
        value: &'a [u8],
    },
    /// `["content-length-range", min, max]`: the size of the file in bytes.
    ContentLengthRange { min: u64, max: u64 },
}

impl Condition<'_> {
    fn write_json(&self, out: &mut Vec<u8>) {
        let json = |text| format_json_string_utf8(text, Default::default());
        let written = match *self {
            Condition::Field { name, value } => write!(out, "{{{}:{}}}", json(name), json(value)),
            Condition::Match {
                operator,
                name,
                value,
            } => {
                let variable = [b"$", name].concat();
                write!(
                    out,
                    "[\"{}\",{},{}]",
                    operator.name(),
                    json(&variable),
                    json(value)
                )
            }
            Condition::ContentLengthRange { min, max } => {
                write!(out, "[\"content-length-range\",{min},{max}]")
            }
        };
        written.expect("write to Vec<u8> never fails");
    }
}

pub struct PostOptions<'a> {
    pub path: &'a [u8],
    /// How long the policy is good for, in seconds.
    pub expires: u64,
    /// Go into the policy as they are, before the conditions for the fields.
    pub conditions: &'a [Condition<'a>],
    /// UTF-8 fields of the caller, none of [`is_reserved_field`]. One replaces the same field of an option below.
    pub fields: &'a [(&'a [u8], &'a [u8])],
    pub acl: Option<ACL>,
    pub storage_class: Option<StorageClass>,
    pub content_type: Option<&'a [u8]>,
    pub content_disposition: Option<&'a [u8]>,
    pub content_encoding: Option<&'a [u8]>,
    pub metadata: Option<&'a AmzHeaders>,
}

pub struct PresignedPost {
    /// The URL of the bucket, which the form is sent to.
    pub url: Box<[u8]>,
    /// In the order of the form. The file is one more field, after these.
    pub fields: Vec<(Box<[u8]>, Box<[u8]>)>,
}

/// S3 replaces it, in the value of a field, with the name of the uploaded file.
const FILENAME_VARIABLE: &[u8] = b"${filename}";
/// The most bytes a key has.
const MAX_KEY_LEN: usize = 1024;

const ALGORITHM: &[u8] = b"AWS4-HMAC-SHA256";

/// Whether `name` is, in any case, `file` or a field that [`S3Credentials::presign_post`] writes itself.
pub fn is_reserved_field(name: &[u8]) -> bool {
    const RESERVED: [&[u8]; 9] = [
        b"key",
        b"bucket",
        b"file",
        b"policy",
        b"x-amz-algorithm",
        b"x-amz-credential",
        b"x-amz-date",
        b"x-amz-security-token",
        b"x-amz-signature",
    ];
    RESERVED
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

impl S3Credentials {
    /// Signs a policy for an upload to `options.path` with exactly the fields of the result and `options.conditions`.
    pub fn presign_post(&self, options: &PostOptions<'_>) -> Result<PresignedPost, SignError> {
        if self.access_key_id.is_empty() || self.secret_access_key.is_empty() {
            return Err(SignError::MissingCredentials);
        }
        let region: &[u8] = if !self.region.is_empty() {
            &self.region
        } else {
            guess_region(&self.endpoint)
        };
        // A request has `/` where its path has `\` (`encode_uri_component`), and the form names the same object.
        let path = strings::replace_char(options.path, b'\\', b'/');
        bucket_and_key!(self, &path[..], bucket, key, SignError::InvalidPath);
        // The policy names the bucket that the form goes to.
        let bucket = crate::copy::bucket_in_endpoint(self).unwrap_or(bucket);
        if bucket.is_empty() || key.is_empty() || key.len() > MAX_KEY_LEN {
            return Err(SignError::InvalidPath);
        }
        // Bytes that are not UTF-8 would differ between the field and its condition.
        if !strings::is_valid_utf8(bucket) || !strings::is_valid_utf8(key) {
            return Err(SignError::InvalidPath);
        }
        if !strings::is_valid_utf8(&self.session_token) {
            return Err(SignError::InvalidSessionToken);
        }

        let mut bucket_buffer = [0u8; 63];
        let encoded_bucket = encode_uri_component::<false>(bucket, &mut bucket_buffer)
            .map_err(|_| SignError::InvalidPath)?;
        // A request puts what follows a `/` of the bucket in front of the key, and a form cannot.
        if strings::contains_char(encoded_bucket, b'/') {
            return Err(SignError::InvalidPath);
        }
        let (host, path_prefix) = self.host_and_path_prefix(region, encoded_bucket)?;
        // Default to https. Only use http if they explicit pass "http://" as the endpoint.
        let protocol: &str = if self.insecure_http { "http" } else { "https" };
        let mut url: Vec<u8> = Vec::new();
        write!(
            &mut url,
            "{}://{}{}/",
            protocol,
            BStr::new(&host),
            BStr::new(path_prefix)
        )
        .expect("write to Vec<u8> never fails");
        if !self.virtual_hosted_style {
            url.extend_from_slice(encoded_bucket);
        }

        let now = unix_time();
        let date = amz_date_at(now);
        let amz_day = &date.date[0..8];
        let mut credential: Vec<u8> = Vec::new();
        write!(
            &mut credential,
            "{}/{}/{}/{}/aws4_request",
            BStr::new(&self.access_key_id),
            BStr::new(amz_day),
            BStr::new(region),
            SERVICE_NAME
        )
        .expect("write to Vec<u8> never fails");
        if !strings::is_valid_utf8(&credential) {
            return Err(SignError::InvalidHeaderValue);
        }

        // The fields in front of the policy and the signature. The policy gets a condition for each.
        let mut fields: Vec<(&[u8], &[u8])> = Vec::new();
        fields.push((b"key", key));
        fields.extend_from_slice(options.fields);
        let given = options.fields.len() + 1;
        let defaults: [(&[u8], Option<&[u8]>); 5] = [
            (b"acl", options.acl.map(ACL::to_string)),
            (b"Content-Type", options.content_type),
            (b"Content-Disposition", options.content_disposition),
            (b"Content-Encoding", options.content_encoding),
            (
                b"x-amz-storage-class",
                options.storage_class.map(StorageClass::to_string),
            ),
        ];
        let metadata = options.metadata.map_or(&[][..], AmzHeaders::entries);
        let metadata = metadata
            .iter()
            .map(|entry| (entry.name(), Some(entry.value())));
        for (name, value) in defaults.into_iter().chain(metadata) {
            debug_assert!(!is_reserved_field(name));
            let is_given = fields[..given]
                .iter()
                .any(|(field, _)| field.eq_ignore_ascii_case(name));
            if let (Some(value), false) = (value, is_given) {
                fields.push((name, value));
            }
        }
        // The fields so far are what the upload is. The rest says who signed.
        let described = fields.len();
        fields.push((b"bucket", bucket));
        fields.push((b"X-Amz-Algorithm", ALGORITHM));
        fields.push((b"X-Amz-Credential", &credential));
        fields.push((b"X-Amz-Date", &date.date));
        if !self.session_token.is_empty() {
            fields.push((b"X-Amz-Security-Token", &self.session_token));
        }

        let (year, month, day, hours, minutes, seconds, _) =
            epoch_to_utc_components(now.saturating_add(options.expires));
        let mut policy: Vec<u8> = Vec::new();
        write!(
            &mut policy,
            "{{\"expiration\":\"{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z\",\"conditions\":["
        )
        .expect("write to Vec<u8> never fails");
        let field_conditions = fields.iter().enumerate().map(|(index, &(name, value))| {
            // S3 puts the file name in before it checks the policy, which can therefore pin only the text in front.
            match strings::index_of(value, FILENAME_VARIABLE) {
                Some(at) if index < described => Condition::Match {
                    operator: Operator::StartsWith,
                    name,
                    value: &value[..at],
                },
                _ => Condition::Field { name, value },
            }
        });
        let conditions = options.conditions.iter().copied().chain(field_conditions);
        for (index, condition) in conditions.enumerate() {
            if index > 0 {
                policy.push(b',');
            }
            condition.write_json(&mut policy);
        }
        policy.extend_from_slice(b"]}");

        let mut encoded_policy = vec![0u8; bun_base64::encode_len(&policy)];
        let encoded_len = bun_base64::encode(&mut encoded_policy, &policy);
        encoded_policy.truncate(encoded_len);

        let signing_key = self.signing_key(region, date.numeric_day)?;
        let mut hmac_buffer = [0u8; bun_sha_hmac::hmac::EVP_MAX_MD_SIZE];
        let signature = bun_sha_hmac::generate(
            &signing_key,
            &encoded_policy,
            bun_sha_hmac::Algorithm::Sha256,
            &mut hmac_buffer,
        )
        .ok_or(SignError::FailedToGenerateSignature)?;
        let mut signature_hex: Vec<u8> = Vec::with_capacity(2 * DIGESTED_HMAC_256_LEN);
        write!(
            &mut signature_hex,
            "{}",
            hex_lower(&signature[0..DIGESTED_HMAC_256_LEN])
        )
        .expect("write to Vec<u8> never fails");

        let mut fields: Vec<(Box<[u8]>, Box<[u8]>)> = fields
            .iter()
            .map(|&(name, value)| (Box::from(name), Box::from(value)))
            .collect();
        fields.push((Box::from(&b"Policy"[..]), encoded_policy.into_boxed_slice()));
        fields.push((
            Box::from(&b"X-Amz-Signature"[..]),
            signature_hex.into_boxed_slice(),
        ));
        Ok(PresignedPost {
            url: url.into_boxed_slice(),
            fields,
        })
    }
}
