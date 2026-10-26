//! A cursor: a portal with a name and a row limit, which lives as long as the transaction that it is bound in. Each batch is the same request, queued again, and ends with its own Sync.

use super::PostgresSQLConnection;
use crate::generated_bindgen::postgres_sql_query::CursorRequest;
use crate::jsc::{JSGlobalObject, JSValue, JsResult, VirtualMachineSqlExt as _};
use crate::postgres::PostgresSQLQuery;
use crate::postgres::error_jsc::{create_postgres_error, postgres_error_to_js};
use crate::postgres::postgres_request::{self as PostgresRequest, Portal as _};
use crate::postgres::postgres_sql_query::{CopyStream, RequestCounter, Status as QueryStatus, js};
use bun_jsc::bindgen::{JsScope, JsWrapper};
use bun_sql::postgres::AnyPostgresError;
use bun_sql::postgres::any_postgres_error::PostgresErrorOptions;
use bun_sql::postgres::postgres_types::Int4;

/// The portal name and the row limit of a cursor. The wrapper of the request keeps them as one number in its `copy` slot.
struct NamedPortal {
    name: [u8; Self::NAME_LENGTH],
    name_length: usize,
    max_rows: Int4,
}

impl NamedPortal {
    const MAX_ROWS_BITS: u32 = 31;
    /// What is left of the 53 bits that a number keeps exactly.
    const ID_BITS: u32 = 22;
    /// `C` and the digits of an id.
    const NAME_LENGTH: usize = 8;

    fn pack(id: u32, max_rows: u32) -> Option<JSValue> {
        if id >> Self::ID_BITS != 0 || max_rows >> Self::MAX_ROWS_BITS != 0 {
            return None;
        }
        Some(JSValue::js_number_from_uint64(
            (u64::from(id) << Self::MAX_ROWS_BITS) | u64::from(max_rows),
        ))
    }

    fn unpack(packed: JSValue) -> Option<NamedPortal> {
        if !packed.is_number() {
            return None;
        }
        let packed = packed.as_number() as u64;
        let mut name = [0u8; Self::NAME_LENGTH];
        let name_length = {
            use std::io::Write as _;
            let mut unwritten = &mut name[..];
            write!(unwritten, "C{}", packed >> Self::MAX_ROWS_BITS).ok()?;
            Self::NAME_LENGTH - unwritten.len()
        };
        Some(NamedPortal {
            name,
            name_length,
            max_rows: (packed & ((1 << Self::MAX_ROWS_BITS) - 1)) as Int4,
        })
    }
}

impl PostgresRequest::Portal for &NamedPortal {
    const DESCRIBED: bool = true;

    fn name(&self) -> &[u8] {
        &self.name[..self.name_length]
    }

    fn max_rows(&self) -> Int4 {
        self.max_rows
    }
}

impl PostgresSQLConnection {
    /// For `dispatch_next`, when the first unwritten request is one of a cursor.
    #[cold]
    pub(super) fn dispatch_cursor(&self, req: &PostgresSQLQuery) -> bool {
        debug_assert!(req.status.get() == QueryStatus::Cursor);
        let kind = req.flags.get().copy;
        let Some(portal) = req.portal() else {
            debug_assert!(false, "a queued request of a cursor has a wrapper");
            return self.remove_unwritten(req);
        };
        match kind {
            CopyStream::CursorOpen => {
                // Only with nothing on its way has the server said where the session is by now.
                if self.has_request_in_flight() {
                    return false;
                }
                // In no transaction the portal is gone at its first Sync, and what the statement wrote is committed.
                if !self.is_in_transaction() {
                    let global = self.global();
                    let error = create_postgres_error(
                        global,
                        b"A cursor needs a transaction, and this connection is in none. Call cursor() on sql, or on the handle that begin() gives",
                        &PostgresErrorOptions {
                            code: b"ERR_POSTGRES_INVALID_TRANSACTION_STATE",
                            ..Default::default()
                        },
                    )
                    .unwrap_or_else(|err| global.take_error(err));
                    self.reject_unwritten(req, error);
                    return true;
                }
                self.dispatch_named_portal(req, &portal)
            }
            CopyStream::CursorFetch | CopyStream::CursorClose => {
                // A Close behind a request that is on its way would keep a cancel of that request from the server.
                if self.has_request_in_flight()
                    && (kind == CopyStream::CursorClose || !self.can_pipeline())
                {
                    return false;
                }
                if let Err(err) = if kind == CopyStream::CursorFetch {
                    PostgresRequest::execute_portal(&portal, self.writer())
                } else {
                    PostgresRequest::close_portal((&portal).name(), self.writer())
                } {
                    return self.fail_write(err);
                }
                self.count(req, RequestCounter::Pipelined);
                req.status.set(QueryStatus::Running);
                true
            }
            _ => {
                debug_assert!(
                    false,
                    "a request with Status::Cursor is a request of a cursor"
                );
                self.remove_unwritten(req)
            }
        }
    }

    #[inline(never)]
    fn dispatch_named_portal(&self, req: &PostgresSQLQuery, portal: &NamedPortal) -> bool {
        self.dispatch_extended(req, portal)
    }

    /// The row limit ended the Execute of the head. What its ReadyForQuery does says `park`.
    pub(super) fn on_portal_suspended(&self) {
        if let Some(head) = self.current()
            && matches!(
                head.flags.get().copy,
                CopyStream::CursorOpen | CopyStream::CursorFetch
            )
            && matches!(
                head.status.get(),
                QueryStatus::Binding | QueryStatus::Running
            )
            && !head.is_rejected()
        {
            head.update_flags(|f| f.copy = CopyStream::CursorSuspended);
        }
    }

    /// The ReadyForQuery of a head that is a request of a cursor and has had no result: its rows ended at the limit, or it was a Close.
    #[cold]
    pub(super) fn ready_cursor(&self, request: &PostgresSQLQuery) {
        match request.flags.get().copy {
            CopyStream::CursorSuspended => self.park(request),
            CopyStream::CursorClose
                if request.status.get() == QueryStatus::Running && !request.is_rejected() =>
            {
                self.count(request, RequestCounter::None);
                request.on_result(b"", self.global(), true);
                self.discard_request(request);
            }
            _ => {}
        }
    }

    /// The head leaves the queue, and its target gets the rows. `fetch()` queues it again.
    fn park(&self, request: &PostgresSQLQuery) {
        let request = request.ref_guard();
        self.count(&request, RequestCounter::None);
        if self
            .current()
            .is_some_and(|head| core::ptr::eq(&raw const *head, &raw const *request))
        {
            request.leave_queue_suspended();
            self.requests.with_mut(|q| q.pop_front());
        }
        request.on_suspended(self.global());
    }
}

impl PostgresSQLQuery {
    fn portal(&self) -> Option<NamedPortal> {
        NamedPortal::unpack(js::copy_get_cached(self.this_value.get().try_get()?)?)
    }

    /// What `on_result` calls for a result and for the end of a request, with command 0, and the statement stays.
    fn on_suspended(&self, global_object: &JSGlobalObject) {
        let Some(this_value) = self.this_value.get().try_get() else {
            return;
        };
        this_value.ensure_still_alive();
        // Weak before the calls: the target can queue the request again from inside the second one.
        self.this_value.with_mut(|r| r.downgrade());
        js::binding_set_cached(this_value, global_object, JSValue::ZERO);
        let description = match self
            .statement_mut()
            .map(|statement| statement.description(global_object, &self.query))
        {
            Some(Ok(description)) => description,
            Some(Err(err)) => {
                let err = global_object.take_exception(err);
                return self.on_js_error(err, global_object);
            }
            None => JSValue::NULL,
        };
        let Some(target) = self.get_target(global_object, false) else {
            return;
        };
        let rows =
            js::pending_value_take_cached(this_value, global_object).unwrap_or(JSValue::UNDEFINED);

        let vm = crate::jsc::VirtualMachine::get().as_mut();
        let function = vm
            .sql_state()
            .postgresql_context
            .on_query_resolve_fn
            .get()
            .unwrap();
        let event_loop = vm.event_loop_mut();
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
    }

    /// For `run()`, of a cursor. Its statement is its own: parsed for it, never cached, so never stale. That of a simple query too, and its rows stay text.
    #[cold]
    pub(crate) fn set_cursor_statement(&self, global_object: &JSGlobalObject) -> JsResult<()> {
        // A COPY has no portal to suspend, and no Sync ends a COPY FROM STDIN.
        if self.is_copy_statement() {
            return Err(global_object.throw_value(postgres_error_to_js(
                global_object,
                Some(b"A COPY statement has no cursor: use query.readable() or query.writable()"),
                AnyPostgresError::CopyNotSupported,
            )));
        }
        self.update_flags(|f| f.simple = false);
        Ok(())
    }

    /// Before `run()`: the statement of a cursor. Before `fetch()`: the Close of a portal.
    pub fn set_cursor(
        &self,
        this_value: JsWrapper<'_, Self>,
        cx: &mut JsScope<'_>,
        request: CursorRequest,
        portal: u32,
        rows: u32,
    ) -> JsResult<()> {
        let global_object = cx.global();
        let copy = self.flags.get().copy;
        let waits = self.status.get() == QueryStatus::Cursor
            && copy == CopyStream::CursorSuspended
            && self.connection().is_none();
        let fresh = self.status.get() == QueryStatus::Pending && copy == CopyStream::None;
        let (Some(packed), true) = (
            NamedPortal::pack(portal, rows),
            fresh || (waits && request == CursorRequest::Close),
        ) else {
            return Err(global_object.throw_invalid_arguments(format_args!(
                "setCursor: the query has started, or the portal or the row limit is out of range"
            )));
        };
        js::copy_set_cached(this_value.to_js(), global_object, packed);
        self.update_flags(|f| {
            f.copy = match request {
                CursorRequest::Open => CopyStream::CursorOpen,
                CursorRequest::Close => CopyStream::CursorClose,
            }
        });
        self.status.set(QueryStatus::Cursor);
        Ok(())
    }

    /// Queues the request for the next rows of its portal, or for the Close that `set_cursor` asked for.
    pub fn fetch(
        &self,
        this_value: JsWrapper<'_, Self>,
        cx: &mut JsScope<'_>,
        connection: &PostgresSQLConnection,
    ) -> JsResult<()> {
        self.queue(this_value.to_js(), cx.global(), connection, JSValue::ZERO)
    }

    /// For `queue`, of a request without a target: what `run()` made of it is still there.
    #[cold]
    pub(crate) fn queue_again(
        &self,
        global_object: &JSGlobalObject,
        connection: &PostgresSQLConnection,
        target: JSValue,
    ) -> JsResult<()> {
        if !target.is_empty() {
            return Err(global_object.throw_invalid_argument_type("run", "query", "Query"));
        }
        let copy = self.flags.get().copy;
        if self.status.get() != QueryStatus::Cursor
            || self.connection().is_some()
            || !matches!(copy, CopyStream::CursorSuspended | CopyStream::CursorClose)
        {
            return Err(global_object.throw_invalid_arguments(format_args!(
                "fetch: the query does not wait for the next rows of a cursor"
            )));
        }
        if connection.status.get().is_closed() {
            return Err(global_object.throw_value(postgres_error_to_js(
                global_object,
                Some(b"Connection closed"),
                AnyPostgresError::ConnectionClosed,
            )));
        }
        if copy == CopyStream::CursorSuspended {
            self.update_flags(|f| f.copy = CopyStream::CursorFetch);
        }
        Ok(())
    }
}
