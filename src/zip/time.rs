//! The date and the time of a member. The format does not say in which time zone they are.

/// What the two MS-DOS fields of a header hold. The fields can hold a month 0 or 15 and a second 62: this is what
/// is there, not a date that exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DosDateTime {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl DosDateTime {
    /// From the date and the time field of a header.
    pub fn from_fields(date: u16, time: u16) -> Self {
        Self {
            year: 1980 + (date >> 9),
            month: ((date >> 5) & 0xf) as u8,
            day: (date & 0x1f) as u8,
            hour: (time >> 11) as u8,
            minute: ((time >> 5) & 0x3f) as u8,
            second: ((time & 0x1f) * 2) as u8,
        }
    }

    /// `(date, time)`. A year outside of 1980 to 2107 becomes the nearest one inside, and seconds are even.
    pub fn to_fields(self) -> (u16, u16) {
        let year = self.year.clamp(1980, 2107) - 1980;
        let date = (year << 9) | (u16::from(self.month & 0xf) << 5) | u16::from(self.day & 0x1f);
        let time = (u16::from(self.hour & 0x1f) << 11)
            | (u16::from(self.minute & 0x3f) << 5)
            | u16::from((self.second / 2) & 0x1f);
        (date, time)
    }
}
