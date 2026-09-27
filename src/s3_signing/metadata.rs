//! User-defined object metadata: the `x-amz-meta-*` headers of PutObject and
//! CreateMultipartUpload.

/// One `x-amz-meta-*` header of an upload.
#[derive(Clone)]
pub struct MetadataEntry {
    name: Box<[u8]>,
    value: Box<[u8]>,
}

impl MetadataEntry {
    /// The header name: lowercase, with the `x-amz-meta-` prefix.
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
    /// no other whitespace: [`Metadata::insert`] takes printable ASCII.)
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
    entries: Vec<MetadataEntry>,
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
        match self
            .entries
            .binary_search_by(|entry| (*entry.name).cmp(&name[..]))
        {
            Ok(_) => Err(MetadataError::DuplicateKey),
            Err(index) => {
                self.entries.insert(
                    index,
                    MetadataEntry {
                        name: name.into_boxed_slice(),
                        value: Box::from(value),
                    },
                );
                Ok(())
            }
        }
    }

    #[inline]
    pub fn entries(&self) -> &[MetadataEntry] {
        &self.entries
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn estimated_size(&self) -> usize {
        self.entries
            .iter()
            .map(|entry| size_of::<MetadataEntry>() + entry.name.len() + entry.value.len())
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
