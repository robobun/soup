//! Finds the end record and reads the central directory. Nothing here reads the contents of a member.

use crate::error::{Error, Result};
use crate::field::{Fields, range};
use crate::{
    CENTRAL_SIZE, END_SIZE, END64_LOCATOR_SIZE, END64_SIZE, LOCAL_SIZE, METHOD_DEFLATE,
    METHOD_STORED, extra, flag, signature,
};
use bun_core::strings;
use bun_zlib::crc32_bytes;

/// The end record and the longest comment that can follow it.
const END_SEARCH: usize = END_SIZE + u16::MAX as usize;
/// An entry with one of these cannot be read, and its headers may not say what it holds.
const ENCRYPTION: u16 = flag::ENCRYPTED | flag::STRONG_ENCRYPTION | flag::MASKED_HEADERS;
const MAX_U16: u64 = u16::MAX as u64;
const MAX_U32: u64 = u32::MAX as u64;

/// A piece of the buffer.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Span {
    start: usize,
    len: usize,
}

impl Span {
    pub(crate) fn of<'a>(&self, data: &'a [u8]) -> &'a [u8] {
        data.get(self.start..)
            .and_then(|rest| rest.get(..self.len))
            .unwrap_or_default()
    }
}

/// One member, as the central directory describes it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Member {
    pub(crate) name: Span,
    /// The name in the Info-ZIP Unicode Path field, if the field is that of `name`.
    pub(crate) unicode_path: Option<Span>,
    pub(crate) flags: u16,
    pub(crate) method: u16,
    pub(crate) crc: u32,
    pub(crate) compressed_size: u64,
    pub(crate) size: u64,
    /// Where the local header starts in the buffer.
    header: u64,
    /// Where the contents start in the buffer.
    pub(crate) data: u64,
    pub(crate) made_by: u16,
    pub(crate) external_attributes: u32,
    pub(crate) dos_date: u16,
    pub(crate) dos_time: u16,
    /// The modification time of the extended timestamp field, which is UTC.
    pub(crate) utc_mtime: Option<u32>,
}

impl Member {
    /// Why the contents cannot be read, if they cannot. The rest of the archive can be.
    pub(crate) fn unreadable(&self) -> Option<Error> {
        if self.flags & ENCRYPTION != 0 {
            return Some(Error::Encrypted);
        }
        match self.method {
            METHOD_STORED if self.compressed_size != self.size => Some(Error::StoredSizeMismatch),
            METHOD_STORED | METHOD_DEFLATE => None,
            other => Some(Error::UnsupportedMethod(other)),
        }
    }
}

struct End {
    /// Where the central directory has to end: at the ZIP64 end record if there is one, else at the end record.
    position: u64,
    entries: u64,
    directory_size: u64,
    directory_offset: u64,
    zip64: bool,
}

/// The last end record whose comment fits in what follows it. The comment of the real one can hold what looks like one.
fn find_end_record(data: &[u8]) -> Option<usize> {
    let window_start = data.len().saturating_sub(END_SEARCH);
    let mut window = data.get(window_start..)?;
    let needle = signature::END.to_le_bytes();
    while let Some(at) = strings::last_index_of(window, &needle) {
        let position = window_start.saturating_add(at);
        // The comment is measured against the buffer: `window` ends where the last candidate started.
        let behind = data
            .get(position.saturating_add(END_SIZE - 2)..)
            .unwrap_or_default();
        let mut fields = Fields::new(behind);
        if let Some(comment) = fields.u16()
            && usize::from(comment) <= fields.rest().len()
        {
            return Some(position);
        }
        window = window.get(..at).unwrap_or_default();
    }
    None
}

fn read_end(data: &[u8], position: usize) -> Result<End> {
    let mut fields = Fields::new(data.get(position..).unwrap_or_default());
    let parsed = (|| {
        let _signature = fields.u32()?;
        Some((
            fields.u16()?,
            fields.u16()?,
            u64::from(fields.u16()?),
            u64::from(fields.u16()?),
            u64::from(fields.u32()?),
            u64::from(fields.u32()?),
        ))
    })();
    let Some((disk, directory_disk, entries_here, entries, directory_size, directory_offset)) =
        parsed
    else {
        return Err(Error::UnrecognizedFormat);
    };

    let Some(end64) = read_end64(data, position)? else {
        if disk != 0 || directory_disk != 0 || entries_here != entries {
            return Err(Error::MultiDisk);
        }
        return Ok(End {
            position: position as u64,
            entries,
            directory_size,
            directory_offset,
            zip64: false,
        });
    };
    // The ZIP64 record is read whether or not a field here is at its limit: Python writes it from 2 GiB. A field
    // that is not at its limit is a value, and the two records have to agree on it.
    let agrees = |short: u64, limit: u64, long: u64| short == limit || short == long;
    if !agrees(entries, MAX_U16, end64.entries)
        || !agrees(directory_size, MAX_U32, end64.directory_size)
        || !agrees(directory_offset, MAX_U32, end64.directory_offset)
        || (disk != 0 && disk != u16::MAX)
        || (directory_disk != 0 && directory_disk != u16::MAX)
    {
        return Err(Error::BadZip64End);
    }
    Ok(end64)
}

/// The fields of a ZIP64 end record.
struct End64 {
    /// How long the record says it is, without its first 12 bytes.
    size: u64,
    disk: u32,
    directory_disk: u32,
    entries_here: u64,
    entries: u64,
    directory_size: u64,
    directory_offset: u64,
}

/// The ZIP64 end record at `position`, if one starts there.
fn parse_end64(data: &[u8], position: u64) -> Option<End64> {
    let mut fields = Fields::new(range(data, position, END64_SIZE as u64)?);
    if fields.u32()? != signature::END64 {
        return None;
    }
    let size = fields.u64()?;
    let _made_by = fields.u16()?;
    let _needed = fields.u16()?;
    Some(End64 {
        size,
        disk: fields.u32()?,
        directory_disk: fields.u32()?,
        entries_here: fields.u64()?,
        entries: fields.u64()?,
        directory_size: fields.u64()?,
        directory_offset: fields.u64()?,
    })
}

/// The ZIP64 end record that the locator in front of the end record names. `None` without a locator, and for bytes
/// that look like one and lead to no record: those are the end of the last entry's name or comment.
fn read_end64(data: &[u8], end_position: usize) -> Result<Option<End>> {
    let Some(locator_position) = end_position.checked_sub(END64_LOCATOR_SIZE) else {
        return Ok(None);
    };
    let mut locator = Fields::new(data.get(locator_position..end_position).unwrap_or_default());
    if locator.u32() != Some(signature::END64_LOCATOR) {
        return Ok(None);
    }
    let (Some(locator_disk), Some(offset), Some(disks)) =
        (locator.u32(), locator.u64(), locator.u32())
    else {
        return Ok(None);
    };
    let locator_position = locator_position as u64;

    let (position, record) = match parse_end64(data, offset) {
        // Readers do not agree on which record counts if the one that the locator names does not reach it.
        Some(record) => {
            let reaches_locator = offset
                .checked_add(12)
                .and_then(|start| start.checked_add(record.size))
                == Some(locator_position);
            if !reaches_locator {
                return Err(Error::BadZip64End);
            }
            (offset, record)
        }
        // With data in front of the archive the offset is too small by the length of that data, and the record is
        // the one right in front of the locator.
        None => {
            let Some(position) = locator_position.checked_sub(END64_SIZE as u64) else {
                return Ok(None);
            };
            match parse_end64(data, position) {
                Some(record) if record.size == END64_SIZE as u64 - 12 => (position, record),
                _ => return Ok(None),
            }
        }
    };
    if locator_disk != 0
        || disks > 1
        || record.disk != 0
        || record.directory_disk != 0
        || record.entries_here != record.entries
    {
        return Err(Error::MultiDisk);
    }
    Ok(Some(End {
        position,
        entries: record.entries,
        directory_size: record.directory_size,
        directory_offset: record.directory_offset,
        zip64: true,
    }))
}

/// What the extra fields of a central entry add to its fixed fields.
struct Extras {
    utc_mtime: Option<u32>,
    unicode_path: Option<Span>,
}

/// The values of a central entry that its fixed fields have no room for.
struct Wide<'a> {
    size: &'a mut u64,
    compressed_size: &'a mut u64,
    header: &'a mut u64,
    disk: &'a mut u32,
}

/// `start` is where `extra_fields` is in the buffer, and `name` is the name of the entry.
fn read_extras(
    extra_fields: &[u8],
    start: usize,
    name: &[u8],
    wide: &mut Wide<'_>,
) -> Result<Extras> {
    let mut extras = Extras {
        utc_mtime: None,
        unicode_path: None,
    };
    let mut needs_zip64 = *wide.size == MAX_U32
        || *wide.compressed_size == MAX_U32
        || *wide.header == MAX_U32
        || *wide.disk == u32::from(u16::MAX);
    let mut fields = Fields::new(extra_fields);
    while let (Some(id), Some(len)) = (fields.u16(), fields.u16()) {
        let body_start = start.saturating_add(extra_fields.len() - fields.rest().len());
        let Some(body) = fields.take(usize::from(len)) else {
            break;
        };
        let mut body = Fields::new(body);
        match id {
            // The 64-bit values follow each other for the fields that are at their limit.
            extra::ZIP64 if needs_zip64 => {
                needs_zip64 = false;
                for value in [
                    &mut *wide.size,
                    &mut *wide.compressed_size,
                    &mut *wide.header,
                ] {
                    if *value == MAX_U32 {
                        *value = body.u64().ok_or(Error::BadZip64Extra)?;
                    }
                }
                if *wide.disk == u32::from(u16::MAX) {
                    *wide.disk = body.u32().ok_or(Error::BadZip64Extra)?;
                }
            }
            extra::TIMESTAMP if extras.utc_mtime.is_none() => {
                // A flag byte, and the modification time if its bit is set.
                let flags = body.take(1).and_then(<[u8]>::first).copied();
                if flags.is_some_and(|flags| flags & 1 != 0) {
                    extras.utc_mtime = body.u32();
                }
            }
            extra::UNICODE_PATH if extras.unicode_path.is_none() => {
                // Version 1, the CRC-32 of the name that this one is for, and the name in UTF-8.
                let version = body.take(1).and_then(<[u8]>::first).copied();
                let for_name = body.u32();
                let text = body.rest();
                if version == Some(1) && for_name == Some(crc32_bytes(0, name)) && !text.is_empty()
                {
                    // Readers give three different names for a field like these, so there is no right one.
                    if !strings::is_valid_utf8(text) {
                        return Err(Error::BadUnicodePath);
                    }
                    if strings::contains_char(text, 0) {
                        return Err(Error::NulInName);
                    }
                    extras.unicode_path = Some(Span {
                        start: body_start.saturating_add(5),
                        len: text.len(),
                    });
                }
            }
            _ => {}
        }
    }
    if needs_zip64 {
        return Err(Error::BadZip64Extra);
    }
    Ok(extras)
}

/// Reads one central entry at the start of `fields`. `position` is where that is in the buffer.
fn read_central(fields: &mut Fields<'_>, position: usize, delta: u64) -> Result<Member> {
    let fixed = (|| {
        if fields.u32()? != signature::CENTRAL {
            return None;
        }
        let made_by = fields.u16()?;
        let _needed = fields.u16()?;
        let flags = fields.u16()?;
        let method = fields.u16()?;
        let dos_time = fields.u16()?;
        let dos_date = fields.u16()?;
        let crc = fields.u32()?;
        let compressed_size = fields.u32()?;
        let size = fields.u32()?;
        let name_len = fields.u16()?;
        let extra_len = fields.u16()?;
        let comment_len = fields.u16()?;
        let disk = fields.u16()?;
        let _internal_attributes = fields.u16()?;
        let external_attributes = fields.u32()?;
        let header = fields.u32()?;
        let name = fields.take(usize::from(name_len))?;
        let extra_fields = fields.take(usize::from(extra_len))?;
        let _comment = fields.take(usize::from(comment_len))?;
        Some((
            (made_by, flags, method, dos_time, dos_date, crc),
            (compressed_size, size, disk, external_attributes, header),
            (name, extra_fields),
        ))
    })();
    let Some((
        (made_by, flags, method, dos_time, dos_date, crc),
        (compressed_size, size, disk, external_attributes, header),
        (name, extra_fields),
    )) = fixed
    else {
        return Err(Error::BadCentralEntry);
    };
    if strings::contains_char(name, 0) {
        return Err(Error::NulInName);
    }

    let mut size = u64::from(size);
    let mut compressed_size = u64::from(compressed_size);
    let mut header = u64::from(header);
    let mut disk = u32::from(disk);
    let name_start = position.saturating_add(CENTRAL_SIZE);
    let extras = read_extras(
        extra_fields,
        name_start.saturating_add(name.len()),
        name,
        &mut Wide {
            size: &mut size,
            compressed_size: &mut compressed_size,
            header: &mut header,
            disk: &mut disk,
        },
    )?;
    if disk != 0 {
        return Err(Error::MultiDisk);
    }
    // `i64` is what the sizes and offsets of a file are everywhere else.
    if i64::try_from(size).is_err() || i64::try_from(compressed_size).is_err() {
        return Err(Error::SizeOverflow);
    }

    Ok(Member {
        name: Span {
            start: name_start,
            len: name.len(),
        },
        unicode_path: extras.unicode_path,
        flags,
        method,
        crc,
        compressed_size,
        size,
        header: header.checked_add(delta).ok_or(Error::EntryOutOfBounds)?,
        data: 0,
        made_by,
        external_attributes,
        dos_date,
        dos_time,
        utc_mtime: extras.utc_mtime,
    })
}

/// The sizes of a local header whose fixed fields are at their limit: the original size, then the compressed one.
fn local_zip64(extra_fields: &[u8], size: &mut u64, compressed_size: &mut u64) -> Option<()> {
    let mut fields = Fields::new(extra_fields);
    while let (Some(id), Some(len)) = (fields.u16(), fields.u16()) {
        let mut body = Fields::new(fields.take(usize::from(len))?);
        if id != extra::ZIP64 {
            continue;
        }
        for value in [size, compressed_size] {
            if *value == MAX_U32 {
                *value = body.u64()?;
            }
        }
        return Some(());
    }
    None
}

/// Checks the local header of `member` against it, and finds the contents. Returns where the member ends.
///
/// A reader that goes through the file from its start sees the local headers and not the directory. If this passes,
/// both see the same name and method, and the same sizes and CRC-32 where the local header has them.
fn read_local(data: &[u8], member: &mut Member, directory_start: u64) -> Result<u64> {
    let header = range(data, member.header, LOCAL_SIZE as u64).ok_or(Error::EntryOutOfBounds)?;
    let mut fields = Fields::new(header);
    let fixed = (|| {
        if fields.u32()? != signature::LOCAL {
            return None;
        }
        let _needed = fields.u16()?;
        let flags = fields.u16()?;
        let method = fields.u16()?;
        let _dos_time = fields.u16()?;
        let _dos_date = fields.u16()?;
        Some((
            flags,
            method,
            fields.u32()?,
            u64::from(fields.u32()?),
            u64::from(fields.u32()?),
            u64::from(fields.u16()?),
            u64::from(fields.u16()?),
        ))
    })();
    let Some((flags, method, crc, mut compressed_size, mut size, name_len, extra_len)) = fixed
    else {
        return Err(Error::BadLocalHeader);
    };

    let name_start = member
        .header
        .checked_add(LOCAL_SIZE as u64)
        .ok_or(Error::EntryOutOfBounds)?;
    let local_name = range(data, name_start, name_len).ok_or(Error::EntryOutOfBounds)?;
    let extra_start = name_start.saturating_add(name_len);
    let local_extra = range(data, extra_start, extra_len).ok_or(Error::EntryOutOfBounds)?;
    if local_name != member.name.of(data)
        || method != member.method
        || (flags ^ member.flags) & ENCRYPTION != 0
    {
        return Err(Error::HeaderMismatch);
    }
    if (size == MAX_U32 || compressed_size == MAX_U32)
        && local_zip64(local_extra, &mut size, &mut compressed_size).is_none()
    {
        return Err(Error::HeaderMismatch);
    }
    // With a data descriptor the values follow the contents, and the header may hold zeros in their place.
    let later = flags & flag::DATA_DESCRIPTOR != 0;
    let same = |local: u64, central: u64| local == central || (later && local == 0);
    if !same(u64::from(crc), u64::from(member.crc))
        || !same(compressed_size, member.compressed_size)
        || !same(size, member.size)
    {
        return Err(Error::HeaderMismatch);
    }

    member.data = extra_start.saturating_add(extra_len);
    let end = member
        .data
        .checked_add(member.compressed_size)
        .ok_or(Error::EntryOutOfBounds)?;
    if end > directory_start {
        return Err(Error::EntryOutOfBounds);
    }
    Ok(end)
}

/// Every member of the archive in `data`, in the order of the central directory.
pub(crate) fn read_members(data: &[u8]) -> Result<Vec<Member>> {
    let Some(end_position) = find_end_record(data) else {
        return Err(if data.starts_with(&signature::LOCAL.to_le_bytes()) {
            Error::NoEndRecord
        } else {
            Error::UnrecognizedFormat
        });
    };
    let end = read_end(data, end_position)?;

    // Data in front of the archive shifts everything by its length, which the end record does not know about.
    let directory_end = end
        .directory_offset
        .checked_add(end.directory_size)
        .ok_or(Error::BadCentralDirectory)?;
    let delta = end
        .position
        .checked_sub(directory_end)
        .ok_or(Error::BadCentralDirectory)?;
    let directory_start = end.directory_offset.saturating_add(delta);
    let directory =
        range(data, directory_start, end.directory_size).ok_or(Error::BadCentralDirectory)?;

    // Checked before the count sizes anything: each entry takes at least this much of the directory.
    if end.entries > end.directory_size / CENTRAL_SIZE as u64 {
        return Err(Error::WrongEntryCount);
    }
    let mut members: Vec<Member> = Vec::new();
    members.try_reserve_exact(usize::try_from(end.entries).map_err(|_| Error::SizeOverflow)?)?;
    let directory_position = usize::try_from(directory_start).map_err(|_| Error::SizeOverflow)?;
    let mut fields = Fields::new(directory);
    while !fields.rest().is_empty() {
        let position = directory_position.saturating_add(directory.len() - fields.rest().len());
        let member = read_central(&mut fields, position, delta)?;
        members.try_reserve(1)?;
        members.push(member);
    }
    // The plain end record counts in 16 bits, and writers without ZIP64 let the count wrap around.
    let counted = if end.zip64 {
        members.len() as u64
    } else {
        members.len() as u64 & MAX_U16
    };
    if counted != end.entries {
        return Err(Error::WrongEntryCount);
    }

    // Two members that share bytes are how a small archive unpacks to any size.
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    ranges.try_reserve_exact(members.len())?;
    for member in &mut members {
        let end = read_local(data, member, directory_start)?;
        ranges.push((member.header, end));
    }
    ranges.sort_unstable();
    let mut taken = 0u64;
    for (start, end) in ranges {
        if start < taken {
            return Err(Error::OverlappingEntries);
        }
        taken = end;
    }
    Ok(members)
}
