#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Unrecognized archive format")]
    UnrecognizedFormat,
    #[error("Truncated zip archive (no end of central directory record)")]
    NoEndRecord,
    #[error("Damaged zip archive (the central directory is not where the end record says)")]
    BadCentralDirectory,
    #[error("Damaged zip archive (bad central directory entry)")]
    BadCentralEntry,
    #[error(
        "Damaged zip archive (the end record and the central directory do not count the same entries)"
    )]
    WrongEntryCount,
    #[error("Damaged zip archive (bad ZIP64 end record)")]
    BadZip64End,
    #[error("Damaged zip archive (bad ZIP64 extra field)")]
    BadZip64Extra,
    #[error("Damaged zip archive (bad local header)")]
    BadLocalHeader,
    #[error("Damaged zip archive (local header and central directory disagree)")]
    HeaderMismatch,
    #[error("Damaged zip archive (an entry lies outside the archive)")]
    EntryOutOfBounds,
    #[error("Zip archive has overlapping entries")]
    OverlappingEntries,
    #[error("Zip entry name has a NUL byte")]
    NulInName,
    #[error("Damaged zip archive (bad Unicode Path extra field)")]
    BadUnicodePath,
    #[error("Zip symlink target has a NUL byte")]
    NulInLinkTarget,
    #[error("Zip symlink target is longer than {limit} bytes")]
    LinkTargetTooLong { limit: usize },
    #[error("Multi-disk zip archives are not supported")]
    MultiDisk,
    #[error("Encrypted zip entries are not supported")]
    Encrypted,
    #[error("Zip compression method {0} is not supported")]
    UnsupportedMethod(u16),
    #[error("Damaged zip archive (a stored entry has two sizes)")]
    StoredSizeMismatch,
    #[error("Zip entry size is too large")]
    SizeOverflow,
    #[error("Truncated zip entry")]
    TruncatedData,
    #[error("Zip entry data is damaged")]
    BadData,
    #[error("Zip entry is larger than its declared size")]
    TooMuchData,
    #[error("Zip entry is smaller than its declared size")]
    TooLittleData,
    #[error("Zip entry has a bad CRC-32")]
    BadCrc,
    #[error("Zip entry name is longer than 65,535 bytes")]
    NameTooLong,
    #[error("Zip entry with a name that ends in \"/\" is a directory and cannot have data")]
    DirectoryWithData,
    #[error(transparent)]
    Alloc(#[from] bun_alloc::AllocError),
}

impl From<std::collections::TryReserveError> for Error {
    fn from(_: std::collections::TryReserveError) -> Self {
        Self::Alloc(bun_alloc::AllocError)
    }
}

pub type Result<T, E = Error> = core::result::Result<T, E>;
