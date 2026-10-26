//! User-defined object metadata: the `x-amz-meta-*` headers of PutObject and
//! CreateMultipartUpload.

/// One header of an [`AmzHeaders`] list.
#[derive(Clone)]
pub struct AmzHeader {
    name: Box<[u8]>,
    value: Box<[u8]>,
}

impl AmzHeader {
    /// The header name, in lowercase.
    #[inline]
    pub fn name(&self) -> &[u8] {
        &self.name
    }

    /// The header value as it goes on the wire.
    #[inline]
    pub fn value(&self) -> &[u8] {
        &self.value
    }

    /// The value as Signature Version 4 signs it: without the spaces around
    /// it, and with one space for each run of spaces inside it. (A value has
    /// no other whitespace: a list takes printable ASCII.)
    pub(crate) fn canonical_value(&self) -> impl Iterator<Item = u8> + '_ {
        let value = bun_core::strings::trim(&self.value, b" ");
        let mut previous = 0u8;
        value.iter().copied().filter(move |&c| {
            let repeated_space = c == b' ' && previous == b' ';
            previous = c;
            !repeated_space
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, strum::IntoStaticStr)]
pub enum MetadataError {
    /// Empty, or it has a byte that a header name cannot have.
    #[error("InvalidKey")]
    InvalidKey,
    /// It has a byte that is not printable ASCII. A server and a client do
    /// not agree on the bytes of other characters in a header, which fails
    /// the signature. Amazon S3 has RFC 2047 encoded words for them.
    #[error("InvalidValue")]
    InvalidValue,
    /// Header names are case-insensitive: `Color` and `color` are one key.
    #[error("DuplicateKey")]
    DuplicateKey,
}

/// The user-defined metadata of an upload. The entries are sorted by header
/// name, which is the order Signature Version 4 lists signed headers in, and
/// no two have the same name.
#[derive(Clone, Default)]
pub struct Metadata {
    headers: AmzHeaders,
}

impl Metadata {
    pub const PREFIX: &'static [u8] = b"x-amz-meta-";

    /// `key` is the name without the prefix, in any case.
    pub fn insert(&mut self, key: &[u8], value: &[u8]) -> Result<(), MetadataError> {
        if key.is_empty() || !key.iter().all(|&c| is_header_name_byte(c)) {
            return Err(MetadataError::InvalidKey);
        }
        if !value.iter().all(|&c| c == b' ' || c.is_ascii_graphic()) {
            return Err(MetadataError::InvalidValue);
        }
        let mut name = Vec::with_capacity(Self::PREFIX.len() + key.len());
        name.extend_from_slice(Self::PREFIX);
        name.extend(key.iter().map(u8::to_ascii_lowercase));
        self.headers.insert_entry(name.into_boxed_slice(), value)
    }

    pub(crate) fn into_headers(self) -> AmzHeaders {
        self.headers
    }
}

impl core::ops::Deref for Metadata {
    type Target = AmzHeaders;

    #[inline]
    fn deref(&self) -> &AmzHeaders {
        &self.headers
    }
}

/// The headers that `sign_request` signs between `x-amz-content-sha256` and `x-amz-request-payer`, sorted by name.
#[derive(Clone, Default)]
pub struct AmzHeaders {
    entries: Vec<AmzHeader>,
}

impl AmzHeaders {
    /// Keeps the entries sorted by name.
    fn insert_entry(&mut self, name: Box<[u8]>, value: &[u8]) -> Result<(), MetadataError> {
        match self.entries.binary_search_by(|entry| entry.name.cmp(&name)) {
            Ok(_) => Err(MetadataError::DuplicateKey),
            Err(index) => {
                self.entries.insert(
                    index,
                    AmzHeader {
                        name,
                        value: Box::from(value),
                    },
                );
                Ok(())
            }
        }
    }

    /// The fixed signed headers on each side of the entries.
    pub(crate) const BEFORE_ENTRIES: &'static [u8] = b"x-amz-content-sha256";
    pub(crate) const AFTER_ENTRIES: &'static [u8] = b"x-amz-request-payer";

    /// Adds one of [`crate::copy::CopyHeaders`].
    pub(crate) fn insert(
        &mut self,
        name: &'static [u8],
        value: &[u8],
    ) -> Result<(), MetadataError> {
        debug_assert!(Self::BEFORE_ENTRIES < name && name < Self::AFTER_ENTRIES);
        if !value.iter().all(|&c| c == b' ' || c.is_ascii_graphic()) {
            return Err(MetadataError::InvalidValue);
        }
        self.insert_entry(Box::from(name), value)
    }

    #[inline]
    pub fn entries(&self) -> &[AmzHeader] {
        &self.entries
    }

    /// The entries that sort before `x-amz-date`, and the rest, which has all user-defined metadata.
    pub(crate) fn split_at_date(&self) -> (&[AmzHeader], &[AmzHeader]) {
        const DATE: &[u8] = b"x-amz-date";
        match self.entries.first() {
            Some(first) if &*first.name < DATE => self
                .entries
                .split_at(self.entries.partition_point(|entry| &*entry.name < DATE)),
            _ => (&[], &self.entries),
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn estimated_size(&self) -> usize {
        self.entries
            .iter()
            .map(|entry| size_of::<AmzHeader>() + entry.name.len() + entry.value.len())
            .sum()
    }

    /// An upper bound for the bytes of the entries in a canonical request:
    /// the `name:value\n` lines and the `;name` items of the signed headers.
    pub(crate) fn signed_len(&self) -> usize {
        self.entries
            .iter()
            .map(|entry| 2 * entry.name.len() + entry.value.len() + 3)
            .sum()
    }
}

/// `tchar` of RFC 9110: what a header name is made of.
fn is_header_name_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}
