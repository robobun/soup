//! An archive in memory that is tar or zip. [`open`] and [`crate::Archiver::extract_to_disk_any`] are the two
//! functions that read a zip, and `Bun.Archive` is what calls them. [`crate::open_memory`],
//! [`crate::Archiver::extract_to_dir`] and [`crate::Archiver::extract_to_disk`] read tar whatever the bytes are:
//! their reader is `bun_tar`'s.
//!
//! `bun_zip` says what a zip holds. What kind of file a member is, and what its name is, is decided here.

use crate::error::AnyError;
use bun_core::{S, strings};
use bun_tar::{Dialect, Entry, Event, MemoryDecoder, PathEncoding};
use bun_zip::{Chunk, DosDateTime};

/// The longest symlink target that is read from a zip: `PATH_MAX` of Linux.
const MAX_LINK_TARGET: usize = 4096;

/// When a file was last changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modified {
    /// Seconds since 1970.
    Utc(i64),
    /// A date and a time on the clock of whoever wrote the archive, which is all that a zip entry without a UTC
    /// field has. Readers take it for their own local time.
    Local(DosDateTime),
}

/// Where [`ZipEntries`] is in the events of the current entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum At {
    Between,
    /// In the contents of a file.
    Contents,
    /// Behind an entry that has no contents to give, with its end still to report.
    End,
}

/// Gives the members of a zip as the entries and events of the tar reader, so that one extraction loop takes both.
pub struct ZipEntries<'a> {
    zip: bun_zip::Reader<'a>,
    entry: Entry,
    modified: Modified,
    at: At,
    /// How much of the current entry's contents was given.
    offset: i64,
    /// The target of the current entry, once `link_read` says that it was read.
    link: Vec<u8>,
    link_read: bool,
}

/// The name of a member as a path in UTF-8.
fn path_of(member: &bun_zip::Entry<'_>) -> Result<Vec<u8>, bun_zip::Error> {
    let name = member.name();
    let mut path = Vec::new();
    match member.unicode_path() {
        Some(unicode) => {
            path.try_reserve_exact(unicode.len())?;
            path.extend_from_slice(unicode);
        }
        // Many writers leave out the flag for a name that is UTF-8.
        None if member.name_is_utf8() || strings::is_valid_utf8(name) => {
            path.try_reserve_exact(name.len())?;
            path.extend_from_slice(name);
        }
        None => bun_zip::cp437_to_utf8(name, &mut path)?,
    }
    // A writer on a file system with `\` between the parts of a path may have left it there. This is the rule of
    // Info-ZIP's unzip.
    if member.made_by_host() == bun_zip::HOST_FAT && !strings::contains_char(&path, b'/') {
        for byte in &mut path {
            if *byte == b'\\' {
                *byte = b'/';
            }
        }
    }
    Ok(path)
}

/// A directory is a name that ends in `/`, and a symlink is what Unix says is one. Everything else is a file,
/// whatever type its mode has: that is how unzip, Python and Node.js read it.
fn to_entry(member: &bun_zip::Entry<'_>) -> Result<(Entry, Modified), bun_zip::Error> {
    let path = path_of(member)?;
    let unix = if member.made_by_host() == bun_zip::HOST_UNIX {
        member.external_attributes() >> 16
    } else {
        0
    };
    let filetype = if path.last() == Some(&b'/') {
        S::IFDIR
    } else if unix & S::IFMT == S::IFLNK {
        S::IFLNK
    } else {
        S::IFREG
    };
    // An entry without permissions, as in every archive that was not made on Unix, is a file that can be read
    // or a directory that can be entered.
    let permissions = match (unix & 0o7777, filetype) {
        (0, S::IFDIR) => 0o755,
        (0, _) => 0o644,
        (permissions, _) => permissions,
    };
    let size = if filetype == S::IFREG {
        i64::try_from(member.size()).map_err(|_| bun_zip::Error::SizeOverflow)?
    } else {
        0
    };
    let modified = match member.utc_mtime() {
        Some(seconds) => Modified::Utc(i64::from(seconds)),
        None => Modified::Local(member.dos_time()),
    };
    let mtime = match modified {
        Modified::Utc(seconds) => seconds,
        Modified::Local(_) => 0,
    };
    let entry = Entry::new(
        path,
        PathEncoding::Utf8,
        filetype | permissions,
        size,
        mtime,
    )
    .ok_or(bun_zip::Error::NulInName)?;
    Ok((entry, modified))
}

impl<'a> ZipEntries<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, bun_zip::Error> {
        Ok(Self {
            zip: bun_zip::Reader::new(bytes)?,
            entry: Entry::default(),
            modified: Modified::Utc(0),
            at: At::Between,
            offset: 0,
            link: Vec::new(),
            link_read: false,
        })
    }

    fn advance(&mut self) -> Result<bool, bun_zip::Error> {
        self.at = At::Between;
        self.offset = 0;
        self.link.clear();
        self.link_read = false;
        let Some(member) = self.zip.next_entry() else {
            return Ok(false);
        };
        (self.entry, self.modified) = to_entry(&member)?;
        // The contents of anything but a file are not its data: a symlink has its target there.
        self.at = if self.entry.kind() == bun_sys::FileKind::File {
            At::Contents
        } else {
            At::End
        };
        Ok(true)
    }

    fn next(&mut self) -> Result<Event<'_>, bun_zip::Error> {
        match self.at {
            At::Between => Ok(if self.advance()? {
                Event::Entry(&self.entry)
            } else {
                Event::EndOfArchive
            }),
            At::End => {
                self.at = At::Between;
                Ok(Event::EndOfEntry { size: 0 })
            }
            At::Contents => match self.zip.read()? {
                Chunk::Data(bytes) => {
                    let offset = self.offset;
                    self.offset = offset.saturating_add(bytes.len() as i64);
                    Ok(Event::Data { offset, bytes })
                }
                Chunk::End => {
                    self.at = At::Between;
                    Ok(Event::EndOfEntry {
                        size: self.entry.size(),
                    })
                }
            },
        }
    }

    /// Reads to the end of the entry, where its length and CRC-32 are checked, whatever `size` is.
    fn read_data(&mut self, size: usize, out: &mut Vec<u8>) -> Result<(), bun_zip::Error> {
        let start = out.len();
        while self.at == At::Contents {
            match self.zip.read()? {
                Chunk::Data(bytes) => {
                    let room = size.saturating_sub(out.len().saturating_sub(start));
                    let bytes = bytes.get(..room.min(bytes.len())).unwrap_or_default();
                    out.try_reserve(bytes.len())?;
                    out.extend_from_slice(bytes);
                }
                Chunk::End => self.at = At::Between,
            }
        }
        Ok(())
    }

    /// The target of the current entry, which is a symlink. It is read here and not with the entry, so that an
    /// archive with a target that cannot be read fails where the symlink is made and nowhere else.
    fn link_target(&mut self) -> Result<&[u8], bun_zip::Error> {
        if self.entry.kind() == bun_sys::FileKind::SymLink && !self.link_read {
            loop {
                let Chunk::Data(bytes) = self.zip.read()? else {
                    break;
                };
                if self.link.len().saturating_add(bytes.len()) > MAX_LINK_TARGET {
                    return Err(bun_zip::Error::LinkTargetTooLong {
                        limit: MAX_LINK_TARGET,
                    });
                }
                self.link.try_reserve(bytes.len())?;
                self.link.extend_from_slice(bytes);
            }
            if strings::contains_char(&self.link, 0) {
                return Err(bun_zip::Error::NulInLinkTarget);
            }
            self.link_read = true;
        }
        Ok(&self.link)
    }
}

// Not boxed: opening a tar through this allocates nothing that `open_memory` does not.
#[allow(clippy::large_enum_variant)]
pub enum AnyReader<'a> {
    Tar(MemoryDecoder<'a>),
    Zip(ZipEntries<'a>),
}

/// What an archive in memory is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// A tar, gzipped or not.
    Tar,
    Zip,
}

/// A reader for an archive in memory. Without a `format` that is a guess: a tar, and if the bytes are not one, a
/// zip. Bytes can be a valid tar and a valid zip, and those are read as the tar.
pub fn open(bytes: &[u8], format: Option<Format>) -> Result<AnyReader<'_>, AnyError> {
    let tar = || crate::open_memory(bytes, Dialect::General).map(AnyReader::Tar);
    let zip = || ZipEntries::new(bytes).map(AnyReader::Zip);
    match format {
        Some(Format::Tar) => Ok(tar()?),
        Some(Format::Zip) => Ok(zip()?),
        None => match tar() {
            Err(bun_tar::Error::UnrecognizedFormat) => match zip() {
                Err(bun_zip::Error::UnrecognizedFormat) => {
                    Err(bun_tar::Error::UnrecognizedFormat.into())
                }
                other => Ok(other?),
            },
            other => Ok(other?),
        },
    }
}

impl AnyReader<'_> {
    pub fn format(&self) -> Format {
        match self {
            Self::Tar(_) => Format::Tar,
            Self::Zip(_) => Format::Zip,
        }
    }

    /// Skips what is left of the current entry. `None` at the end of the archive.
    #[inline]
    pub fn next_entry(&mut self) -> Result<Option<&Entry>, AnyError> {
        match self {
            Self::Tar(reader) => Ok(reader.next_entry()?),
            Self::Zip(reader) => Ok(if reader.advance()? {
                Some(&reader.entry)
            } else {
                None
            }),
        }
    }

    #[inline]
    pub fn next(&mut self) -> Result<Event<'_>, AnyError> {
        match self {
            Self::Tar(reader) => Ok(reader.next()?),
            Self::Zip(reader) => Ok(reader.next()?),
        }
    }

    /// Appends at most `size` bytes of the current entry's contents.
    #[inline]
    pub fn read_data(&mut self, size: usize, out: &mut Vec<u8>) -> Result<(), AnyError> {
        match self {
            Self::Tar(reader) => Ok(reader.read_data(size, out)?),
            Self::Zip(reader) => Ok(reader.read_data(size, out)?),
        }
    }

    /// Where the current entry, which is a symlink, points.
    #[inline]
    pub fn link_target(&mut self) -> Result<&[u8], AnyError> {
        match self {
            Self::Tar(reader) => Ok(reader.entry().symlink().unwrap_or_default()),
            Self::Zip(reader) => Ok(reader.link_target()?),
        }
    }

    /// When the current entry was last changed.
    pub fn modified(&self) -> Modified {
        match self {
            Self::Tar(reader) => Modified::Utc(reader.entry().mtime()),
            Self::Zip(reader) => reader.modified,
        }
    }
}
