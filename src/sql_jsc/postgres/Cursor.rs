//! A cursor: a portal with a name and a row limit, which lives as long as the transaction that it is bound in. Each batch is the same request, queued again, and ends with its own Sync.

use super::{Entry, PostgresSQLConnection, Seat};
use crate::jsc::{JSGlobalObject, JSValue, JsResult, VirtualMachine, VirtualMachineSqlExt as _};
use crate::postgres::error_jsc::create_postgres_error;
use crate::postgres::postgres_request::NamedPortal;
use crate::postgres::postgres_sql_query::{CopyStream, js};
use crate::postgres::{PostgresSQLQuery, PostgresSQLStatement};
use bun_ptr::RefPtr;
use bun_sql::postgres::PostgresErrorOptions;
use bun_sql::postgres::pipeline::Protocol;

impl PostgresSQLConnection {
    /// What the statement of a cursor is rejected with when `Pipeline::refuses` it.
    pub(super) fn needs_transaction_error(&self) -> JSValue {
        let global = self.global();
        create_postgres_error(
            global,
            b"A cursor needs a transaction, and this connection is in none. Call cursor() on sql, or on the handle that begin() gives",
            &PostgresErrorOptions {
                code: b"ERR_POSTGRES_INVALID_TRANSACTION_STATE",
                ..Default::default()
            },
        )
        .unwrap_or_else(|err| global.take_error(err))
    }

    /// For `fetch()`, of a cursor that asks for the next rows of its portal. `statement` has the columns of those rows.
    pub(crate) fn enqueue_fetch(
        &self,
        request: &PostgresSQLQuery,
        statement: RefPtr<PostgresSQLStatement>,
    ) -> Seat {
        let request = request.ref_guard();
        Seat {
            session: self.ref_guard(),
            turn: (self.pipeline).with_mut(|it| it.push(request, statement, Protocol::Fetch)),
        }
    }

    /// The row limit ended the Execute of `entry`, which has left the queue. Its target gets the rows, and `fetch()` queues it again.
    pub(super) fn park(&self, entry: &Entry) {
        let request = &entry.request;
        request.suspend(entry.statement.clone());
        if let Err(err) = request.on_suspended(self.global(), &entry.statement) {
            request.leave_queue();
            request.reject(self.global().take_exception(err), self.global());
        }
    }
}

impl PostgresSQLQuery {
    /// Of a request of a cursor: what `set_cursor` left in the wrapper.
    pub(super) fn portal(&self) -> Option<NamedPortal> {
        match self.copy.get() {
            CopyStream::Cursor | CopyStream::CursorClose => {
                NamedPortal::unpack(js::copy_get_cached(self.this_value.get().try_get()?)?)
            }
            _ => None,
        }
    }

    /// What `on_result` calls for a result and then for the end of a request, with command 0. The target and the statement stay.
    fn on_suspended(
        &self,
        global_object: &JSGlobalObject,
        statement: &PostgresSQLStatement,
    ) -> JsResult<()> {
        let Some(this_value) = self.this_value.get().try_get() else {
            return Ok(());
        };
        this_value.ensure_still_alive();
        // Weak before the calls: the target can queue the request again from inside the second one.
        self.this_value.with_mut(|r| r.downgrade());
        js::binding_set_cached(this_value, global_object, JSValue::ZERO);
        let description = statement.columns.with_mut(|columns| {
            columns.description(global_object, &self.query, statement.described())
        })?;
        let Some(target) = self.get_target(global_object, false) else {
            return Ok(());
        };
        let rows =
            js::pending_value_take_cached(this_value, global_object).unwrap_or(JSValue::UNDEFINED);

        let vm = VirtualMachine::get();
        let Some(function) = vm
            .sql_state()
            .postgresql_context
            .get()
            .on_query_resolve_fn
            .get()
        else {
            return Ok(());
        };
        let event_loop = vm.event_loop();
        let no_command = JSValue::js_number(0.0);
        for (result, is_last) in [(rows, false), (JSValue::UNDEFINED, true)] {
            event_loop.run_callback(
                bun_event_loop::ContextId::NONE,
                function,
                global_object,
                this_value,
                &[
                    target,
                    result,
                    no_command,
                    no_command,
                    JSValue::from(is_last),
                    description,
                ],
            );
        }
        Ok(())
    }
}
