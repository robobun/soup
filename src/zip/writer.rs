//! Writes a zip into memory. The caller compresses: this is the framing only.
//!
//! What this writes, `Reader` reads.

use crate::error::{Error, Result};
use crate::time::DosDateTime;
use crate::{
    CENTRAL_SIZE, END_SIZE, END64_LOCATOR_SIZE, END64_SIZE, HOST_UNIX, LOCAL_SIZE, METHOD_DEFLATE,
    METHOD_STORED, extra, flag, signature,
};
use bun_core::strings;
use bun_zlib::crc32_bytes;

/// The version of the format that the plain records need, and the one that ZIP64 needs.
const VERSION: u16 = 20;
const VERSION_ZIP64: u16 = 45;
/// The MS-DOS attribute of a directory, which readers that know no Unix mode look at.
const DOS_DIRECTORY: u32 = 0x10;
/// The file types of a Unix mode.
const REGULAR: u32 = 0o100000;
const DIRECTORY: u32 = 0o040000;
/// An extended timestamp field with the modification time: its header, a flag byte and 32 bits of seconds.
const TIMESTAMP_LEN: u16 = 4 + 1 + 4;
/// Where the CRC-32 is in what a local header and a central entry share: behind five 16-bit fields.
const CRC_IN_SHARED: usize = 10;

/// What a member is, apart from its name and its bytes.
#[derive(Debug, Clone, Copy)]
pub struct Meta {
    /// The permission bits of a Unix mode. The file type comes from the name.
    pub permissions: u16,
    /// Seconds since 1970 in UTC, for the extended timestamp field.
    pub mtime: u32,
    /// The same moment for the MS-DOS fields, where readers expect the local time of the writer.
    pub dos: DosDateTime,
}

#[derive(Debug, Clone, Copy)]
pub enum Contents<'a> {
    /// The bytes as they are. Their CRC-32 is taken from the copy that goes into the archive.
    Stored(&'a [u8]),
    /// A raw DEFLATE stream, and the length and the CRC-32 of what it unpacks to.
    Deflated { crc: u32, size: u64, data: &'a [u8] },
}

/// A name that is not ASCII is recorded as UTF-8. A name that ends in `/` is a directory, and everything else a file.
pub struct Writer {
    out: Vec<u8>,
    directory: Vec<u8>,
    entries: u64,
    /// From which size or offset an entry gets 64-bit fields, and from how many entries the archive gets the ZIP64
    /// end record. The format's own limits, unless a test asks for less.
    wide_from: u64,
    many_from: u64,
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

impl Writer {
    pub fn new() -> Self {
        Self::with_zip64_from(u64::from(u32::MAX), u64::from(u16::MAX))
    }

    /// A writer that uses ZIP64 from a size or offset of `wide_from` bytes and from `many_from` entries.
    pub fn with_zip64_from(wide_from: u64, many_from: u64) -> Self {
        Self {
            out: Vec::new(),
            directory: Vec::new(),
            entries: 0,
            wide_from: wide_from.min(u64::from(u32::MAX)),
            many_from: many_from.min(u64::from(u16::MAX)),
        }
    }

    pub fn add(&mut self, name: &[u8], contents: Contents<'_>, meta: &Meta) -> Result<()> {
        let name_len = u16::try_from(name.len()).map_err(|_| Error::NameTooLong)?;
        if strings::contains_char(name, 0) {
            return Err(Error::NulInName);
        }
        let is_directory = name.last() == Some(&b'/');
        let (method, data, known) = match contents {
            Contents::Stored(data) => (METHOD_STORED, data, None),
            Contents::Deflated { crc, size, data } => (METHOD_DEFLATE, data, Some((crc, size))),
        };
        if is_directory && !(method == METHOD_STORED && data.is_empty()) {
            return Err(Error::DirectoryWithData);
        }
        let compressed_size = data.len() as u64;
        let size = known.map_or(compressed_size, |(_, size)| size);

        let offset = self.out.len() as u64;
        let flags = if name.is_ascii() { 0 } else { flag::UTF8 };
        // A local header has both sizes in its ZIP64 field or none, and a central entry only what does not fit.
        let wide_sizes = size >= self.wide_from || compressed_size >= self.wide_from;
        let wide_offset = offset >= self.wide_from;
        let narrow = |value: u64, wide: bool| if wide { u32::MAX } else { value as u32 };
        let version = if wide_sizes || wide_offset {
            VERSION_ZIP64
        } else {
            VERSION
        };
        let sizes_len: u16 = if wide_sizes { 16 } else { 0 };
        let offset_len: u16 = if wide_offset { 8 } else { 0 };
        let local_extra_len = if wide_sizes { 4 + sizes_len } else { 0 } + TIMESTAMP_LEN;
        let central_extra_len = if wide_sizes || wide_offset {
            4 + sizes_len + offset_len
        } else {
            0
        } + TIMESTAMP_LEN;
        let (dos_date, dos_time) = meta.dos.to_fields();

        // What a local header and a central entry have in common, in the order that both have it in.
        let shared = |out: &mut Vec<u8>, crc: u32| {
            out.extend_from_slice(&version.to_le_bytes());
            out.extend_from_slice(&flags.to_le_bytes());
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&dos_time.to_le_bytes());
            out.extend_from_slice(&dos_date.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&narrow(compressed_size, wide_sizes).to_le_bytes());
            out.extend_from_slice(&narrow(size, wide_sizes).to_le_bytes());
            out.extend_from_slice(&name_len.to_le_bytes());
        };
        let sizes = |out: &mut Vec<u8>| {
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&compressed_size.to_le_bytes());
        };
        let timestamp = |out: &mut Vec<u8>| {
            out.extend_from_slice(&extra::TIMESTAMP.to_le_bytes());
            out.extend_from_slice(&(TIMESTAMP_LEN - 4).to_le_bytes());
            // Of the three times that the field can hold, this one has the first: the modification time.
            out.push(1);
            out.extend_from_slice(&meta.mtime.to_le_bytes());
        };

        let out = &mut self.out;
        out.try_reserve(
            LOCAL_SIZE
                .saturating_add(name.len())
                .saturating_add(usize::from(local_extra_len))
                .saturating_add(data.len()),
        )?;
        out.extend_from_slice(&signature::LOCAL.to_le_bytes());
        let crc_at = out.len().saturating_add(CRC_IN_SHARED);
        shared(out, known.map_or(0, |(crc, _)| crc));
        out.extend_from_slice(&local_extra_len.to_le_bytes());
        out.extend_from_slice(name);
        if wide_sizes {
            out.extend_from_slice(&extra::ZIP64.to_le_bytes());
            out.extend_from_slice(&sizes_len.to_le_bytes());
            sizes(out);
        }
        timestamp(out);
        let contents_at = out.len();
        out.extend_from_slice(data);
        // The CRC-32 of stored contents is of the bytes in the archive, not of what the caller's buffer held a
        // moment before or after the copy.
        let crc = match known {
            Some((crc, _)) => crc,
            None => {
                let crc = crc32_bytes(0, out.get(contents_at..).unwrap_or_default());
                if let Some(field) = out.get_mut(crc_at..crc_at.saturating_add(4)) {
                    field.copy_from_slice(&crc.to_le_bytes());
                }
                crc
            }
        };

        let mode =
            if is_directory { DIRECTORY } else { REGULAR } | u32::from(meta.permissions & 0o7777);
        let attributes = (mode << 16) | if is_directory { DOS_DIRECTORY } else { 0 };
        let directory = &mut self.directory;
        directory.try_reserve(
            CENTRAL_SIZE
                .saturating_add(name.len())
                .saturating_add(usize::from(central_extra_len)),
        )?;
        directory.extend_from_slice(&signature::CENTRAL.to_le_bytes());
        directory.extend_from_slice(&(u16::from(HOST_UNIX) << 8 | version).to_le_bytes());
        shared(directory, crc);
        directory.extend_from_slice(&central_extra_len.to_le_bytes());
        // No comment, disk 0, no internal attributes.
        directory.extend_from_slice(&[0u8; 6]);
        directory.extend_from_slice(&attributes.to_le_bytes());
        directory.extend_from_slice(&narrow(offset, wide_offset).to_le_bytes());
        directory.extend_from_slice(name);
        if wide_sizes || wide_offset {
            directory.extend_from_slice(&extra::ZIP64.to_le_bytes());
            directory.extend_from_slice(&(sizes_len + offset_len).to_le_bytes());
            if wide_sizes {
                sizes(directory);
            }
            if wide_offset {
                directory.extend_from_slice(&offset.to_le_bytes());
            }
        }
        timestamp(directory);
        self.entries = self.entries.saturating_add(1);
        Ok(())
    }

    /// Writes the central directory and the end records, and gives the archive.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        let directory_offset = self.out.len() as u64;
        let directory_size = self.directory.len() as u64;
        // The end of the last name can start like a ZIP64 locator. Some readers look no further than that, and
        // the real locator is what they have to find there.
        let ends_like_locator = self
            .directory
            .len()
            .checked_sub(END64_LOCATOR_SIZE)
            .and_then(|at| self.directory.get(at..))
            .is_some_and(|tail| tail.starts_with(&signature::END64_LOCATOR.to_le_bytes()));
        let wide = self.entries >= self.many_from
            || directory_size >= self.wide_from
            || directory_offset >= self.wide_from
            || ends_like_locator;
        self.out.try_reserve(
            self.directory
                .len()
                .saturating_add(END64_SIZE + END64_LOCATOR_SIZE + END_SIZE),
        )?;
        let out = &mut self.out;
        out.extend_from_slice(&self.directory);
        if wide {
            let end64_offset = out.len() as u64;
            out.extend_from_slice(&signature::END64.to_le_bytes());
            out.extend_from_slice(&(END64_SIZE as u64 - 12).to_le_bytes());
            out.extend_from_slice(&(u16::from(HOST_UNIX) << 8 | VERSION_ZIP64).to_le_bytes());
            out.extend_from_slice(&VERSION_ZIP64.to_le_bytes());
            out.extend_from_slice(&[0u8; 8]);
            out.extend_from_slice(&self.entries.to_le_bytes());
            out.extend_from_slice(&self.entries.to_le_bytes());
            out.extend_from_slice(&directory_size.to_le_bytes());
            out.extend_from_slice(&directory_offset.to_le_bytes());
            out.extend_from_slice(&signature::END64_LOCATOR.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&end64_offset.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
        }
        // With the ZIP64 record in front, the fields here are at their limit and say to look there.
        let (entries, size, offset) = if wide {
            (u16::MAX, u32::MAX, u32::MAX)
        } else {
            (
                self.entries as u16,
                directory_size as u32,
                directory_offset as u32,
            )
        };
        out.extend_from_slice(&signature::END.to_le_bytes());
        out.extend_from_slice(&[0u8; 4]);
        out.extend_from_slice(&entries.to_le_bytes());
        out.extend_from_slice(&entries.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        Ok(self.out)
    }
}
