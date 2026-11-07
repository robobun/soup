//! Little-endian fields. A read past the end is `None`.

#[derive(Clone, Copy)]
pub(crate) struct Fields<'a> {
    bytes: &'a [u8],
}

impl<'a> Fields<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    pub(crate) fn rest(&self) -> &'a [u8] {
        self.bytes
    }

    pub(crate) fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (head, tail) = self.bytes.split_at_checked(len)?;
        self.bytes = tail;
        Some(head)
    }

    pub(crate) fn u16(&mut self) -> Option<u16> {
        let (bytes, tail) = self.bytes.split_first_chunk::<2>()?;
        self.bytes = tail;
        Some(u16::from_le_bytes(*bytes))
    }

    pub(crate) fn u32(&mut self) -> Option<u32> {
        let (bytes, tail) = self.bytes.split_first_chunk::<4>()?;
        self.bytes = tail;
        Some(u32::from_le_bytes(*bytes))
    }

    pub(crate) fn u64(&mut self) -> Option<u64> {
        let (bytes, tail) = self.bytes.split_first_chunk::<8>()?;
        self.bytes = tail;
        Some(u64::from_le_bytes(*bytes))
    }
}

/// `bytes[start..start + len]`, also when the sum overflows.
pub(crate) fn range(bytes: &[u8], start: u64, len: u64) -> Option<&[u8]> {
    let start = usize::try_from(start).ok()?;
    let end = start.checked_add(usize::try_from(len).ok()?)?;
    bytes.get(start..end)
}
