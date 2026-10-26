use super::new_writer::NewWriter;
use crate::postgres::AnyPostgresError;
use crate::postgres::types::int_types::Int4;

pub struct Execute<'a> {
    /// Empty for the unnamed portal.
    pub portal: &'a [u8],
    /// 0 is no limit.
    pub max_rows: Int4,
}

impl<'a> Execute<'a> {
    pub fn write_internal<Context: super::new_writer::WriterContext>(
        &self,
        writer: &mut NewWriter<Context>,
    ) -> Result<(), AnyPostgresError> {
        writer.write(b"E")?;
        let length = writer.length()?;
        if self.portal.is_empty() {
            writer.write(&[0u8])?;
        } else {
            writer.string(self.portal)?;
        }
        writer.int4(self.max_rows)?;
        length.write()?;
        Ok(())
    }
}
