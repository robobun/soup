use super::new_writer::NewWriter;
use super::portal_or_prepared_statement::PortalOrPreparedStatement;
use crate::postgres::AnyPostgresError;

pub struct Close<'a> {
    pub p: PortalOrPreparedStatement<'a>,
}

impl<'a> Close<'a> {
    pub fn write_internal<Context: super::new_writer::WriterContext>(
        &self,
        writer: NewWriter<Context>,
    ) -> Result<(), AnyPostgresError> {
        writer.write(b"C")?;
        let length = writer.length()?;
        writer.write(&[self.p.tag()])?;
        writer.string(self.p.slice())?;
        length.write()?;
        Ok(())
    }
}
