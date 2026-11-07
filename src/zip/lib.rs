//! zip framing without I/O and without policy. The reader takes every fact about a member from the central
//! directory, and says what the archive holds, not what to make of it. DEFLATE comes from zlib through `bun_zlib`.
#![forbid(unsafe_code)]
// Archives come from anywhere and a panic aborts the process.
#![deny(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable
)]
#![warn(unused_must_use)]

mod cp437;
mod error;
mod field;
mod open;
mod reader;
mod time;
mod writer;

pub use cp437::cp437_to_utf8;
pub use error::{Error, Result};
pub use reader::{Chunk, Entry, Reader};
pub use time::DosDateTime;
pub use writer::{Contents, Meta, Writer};

/// General purpose bit flags.
pub(crate) mod flag {
    pub(crate) const ENCRYPTED: u16 = 1 << 0;
    pub(crate) const DATA_DESCRIPTOR: u16 = 1 << 3;
    pub(crate) const STRONG_ENCRYPTION: u16 = 1 << 6;
    pub(crate) const UTF8: u16 = 1 << 11;
    pub(crate) const MASKED_HEADERS: u16 = 1 << 13;
}

pub(crate) mod signature {
    pub(crate) const LOCAL: u32 = 0x0403_4b50;
    pub(crate) const CENTRAL: u32 = 0x0201_4b50;
    pub(crate) const END: u32 = 0x0605_4b50;
    pub(crate) const END64: u32 = 0x0606_4b50;
    pub(crate) const END64_LOCATOR: u32 = 0x0706_4b50;
}

pub(crate) mod extra {
    pub(crate) const ZIP64: u16 = 0x0001;
    pub(crate) const TIMESTAMP: u16 = 0x5455;
    pub(crate) const UNICODE_PATH: u16 = 0x7075;
}

pub(crate) const METHOD_STORED: u16 = 0;
pub(crate) const METHOD_DEFLATE: u16 = 8;

pub(crate) const LOCAL_SIZE: usize = 30;
pub(crate) const CENTRAL_SIZE: usize = 46;
pub(crate) const END_SIZE: usize = 22;
pub(crate) const END64_SIZE: usize = 56;
pub(crate) const END64_LOCATOR_SIZE: usize = 20;

/// The host of "version made by" whose external attributes hold a Unix mode.
pub const HOST_UNIX: u8 = 3;
/// The host whose file system separates the parts of a path with `\`.
pub const HOST_FAT: u8 = 0;
