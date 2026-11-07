//! Reads a zip that is all in memory, member by member in the order of its central directory.

use crate::error::{Error, Result};
use crate::field::range;
use crate::open::{Member, read_members};
use crate::time::DosDateTime;
use crate::{METHOD_STORED, flag};
use bun_alloc::AllocError;
use bun_zlib::{InflateDecoder, ReturnCode, crc32_bytes};

/// zlib's name for DEFLATE with nothing around it.
const RAW_DEFLATE: i32 = -15;
/// How much of a deflated member is unpacked at a time. Nothing is sized from what the archive declares.
const BLOCK: usize = 64 * 1024;

#[derive(Debug)]
pub enum Chunk<'a> {
    Data(&'a [u8]),
    /// Everything was given, and its length and CRC-32 are what the archive declares.
    End,
}

/// One member, as the central directory describes it. What kind of file that makes it is for the caller to say.
#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    data: &'a [u8],
    member: &'a Member,
}

impl<'a> Entry<'a> {
    /// The name field. Never holds a NUL.
    pub fn name(&self) -> &'a [u8] {
        self.member.name.of(self.data)
    }
    /// The name of the Info-ZIP Unicode Path field, if the entry has one that is for its name field. It is UTF-8.
    pub fn unicode_path(&self) -> Option<&'a [u8]> {
        self.member.unicode_path.map(|span| span.of(self.data))
    }
    /// The entry says that its name field is UTF-8. Without that, the format says code page 437.
    pub fn name_is_utf8(&self) -> bool {
        self.member.flags & flag::UTF8 != 0
    }
    /// The system that the entry was made on, which says what its external attributes are.
    pub fn made_by_host(&self) -> u8 {
        (self.member.made_by >> 8) as u8
    }
    pub fn external_attributes(&self) -> u32 {
        self.member.external_attributes
    }
    /// How long the contents are when they are unpacked.
    pub fn size(&self) -> u64 {
        self.member.size
    }
    pub fn crc32(&self) -> u32 {
        self.member.crc
    }
    /// The MS-DOS date and time, in the time zone of whoever wrote the entry.
    pub fn dos_time(&self) -> DosDateTime {
        DosDateTime::from_fields(self.member.dos_date, self.member.dos_time)
    }
    /// Seconds since 1970 in UTC, if the entry has an extended timestamp field.
    pub fn utc_mtime(&self) -> Option<u32> {
        self.member.utc_mtime
    }
    /// The contents, if the archive holds them uncompressed. Their CRC-32 is not checked here.
    pub fn stored(&self) -> Option<&'a [u8]> {
        (self.member.method == METHOD_STORED && self.member.unreadable().is_none())
            .then(|| range(self.data, self.member.data, self.member.compressed_size))
            .flatten()
    }
}

#[derive(Debug, Clone, Copy)]
struct Inflating {
    started: bool,
    /// How much of the member's compressed bytes zlib has taken.
    consumed: usize,
    produced: u64,
    crc: u32,
    ended: bool,
}

#[derive(Debug, Clone, Copy)]
enum Stream {
    /// Nothing of the current member is left to give.
    Done,
    Stored,
    Deflate(Inflating),
    Failed(Error),
}

pub struct Reader<'a> {
    data: &'a [u8],
    members: Vec<Member>,
    /// How many members `next_entry` has given.
    given: usize,
    stream: Stream,
    inflate: Option<InflateDecoder>,
    block: Vec<u8>,
}

impl<'a> Reader<'a> {
    /// Reads the central directory, and the local header of every member. Fails for what is not a zip, and for an
    /// archive whose members share bytes or whose two kinds of header disagree.
    pub fn new(data: &'a [u8]) -> Result<Self> {
        Ok(Self {
            data,
            members: read_members(data)?,
            given: 0,
            stream: Stream::Done,
            inflate: None,
            block: Vec::new(),
        })
    }

    /// Moves to the next member, whatever was read of the one before. `None` after the last one.
    pub fn next_entry(&mut self) -> Option<Entry<'_>> {
        let Some(member) = self.members.get(self.given) else {
            self.stream = Stream::Done;
            return None;
        };
        self.given = self.given.saturating_add(1);
        self.stream = match member.unreadable() {
            Some(error) => Stream::Failed(error),
            None if member.method == METHOD_STORED => Stream::Stored,
            None => Stream::Deflate(Inflating {
                started: false,
                consumed: 0,
                produced: 0,
                crc: 0,
                ended: false,
            }),
        };
        Some(Entry {
            data: self.data,
            member,
        })
    }

    /// The next piece of the current member's contents. An error is final for this member, and the next one can
    /// still be read.
    pub fn read(&mut self) -> Result<Chunk<'_>> {
        let Some(member) = self
            .given
            .checked_sub(1)
            .and_then(|index| self.members.get(index))
        else {
            return Ok(Chunk::End);
        };
        step(
            self.data,
            member,
            &mut self.stream,
            &mut self.inflate,
            &mut self.block,
        )
    }
}

fn step<'s>(
    data: &'s [u8],
    member: &Member,
    stream: &mut Stream,
    inflate: &mut Option<InflateDecoder>,
    block: &'s mut Vec<u8>,
) -> Result<Chunk<'s>> {
    let fail = |stream: &mut Stream, error: Error| {
        *stream = Stream::Failed(error);
        Err(error)
    };
    let mut state = match *stream {
        Stream::Done => return Ok(Chunk::End),
        Stream::Failed(error) => return Err(error),
        Stream::Stored => {
            let Some(bytes) = range(data, member.data, member.compressed_size) else {
                return fail(stream, Error::EntryOutOfBounds);
            };
            if crc32_bytes(0, bytes) != member.crc {
                return fail(stream, Error::BadCrc);
            }
            *stream = Stream::Done;
            return Ok(if bytes.is_empty() {
                Chunk::End
            } else {
                Chunk::Data(bytes)
            });
        }
        Stream::Deflate(state) => state,
    };

    let Some(packed) = range(data, member.data, member.compressed_size) else {
        return fail(stream, Error::EntryOutOfBounds);
    };
    if inflate.is_none() {
        *inflate = InflateDecoder::new(RAW_DEFLATE).ok();
    }
    let Some(decoder) = inflate else {
        return fail(stream, Error::Alloc(AllocError));
    };
    if !state.started {
        state.started = true;
        if decoder.reset() != ReturnCode::Ok {
            return fail(stream, Error::BadData);
        }
    }

    block.clear();
    while block.is_empty() && !state.ended {
        let input = packed.get(state.consumed..).unwrap_or_default();
        // One byte more than is declared is enough to tell that there is too much.
        let room = member
            .size
            .saturating_sub(state.produced)
            .saturating_add(1)
            .min(BLOCK as u64) as usize;
        let (used, code) = decoder.step_limited(input, block, room);
        state.consumed = state.consumed.saturating_add(used);
        match code {
            ReturnCode::StreamEnd => state.ended = true,
            // zlib could do nothing: the member ends inside its compressed data.
            ReturnCode::Ok | ReturnCode::BufError if used == 0 && block.is_empty() => {
                return fail(stream, Error::TruncatedData);
            }
            ReturnCode::Ok | ReturnCode::BufError => {}
            ReturnCode::MemError => return fail(stream, Error::Alloc(AllocError)),
            _ => return fail(stream, Error::BadData),
        }
    }
    state.produced = state.produced.saturating_add(block.len() as u64);
    state.crc = crc32_bytes(state.crc, block);
    if state.produced > member.size {
        return fail(stream, Error::TooMuchData);
    }
    if !block.is_empty() {
        *stream = Stream::Deflate(state);
        return Ok(Chunk::Data(block));
    }
    if state.produced != member.size {
        return fail(stream, Error::TooLittleData);
    }
    if state.crc != member.crc {
        return fail(stream, Error::BadCrc);
    }
    *stream = Stream::Done;
    Ok(Chunk::End)
}
