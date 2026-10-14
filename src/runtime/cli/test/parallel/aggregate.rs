//! Builds the single JUnit or JSON document and the coverage report from the
//! per-file data workers stream over IPC, once `drive()` completes.

use core::sync::atomic::Ordering;

use bun_collections::index_sort;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_options_types::code_coverage_options::CodeCoverageOptions;
use bun_sourcemap_jsc::code_coverage::Report;

use super::coordinator::{Coordinator, FileTestRecords, abort_handler};
use super::frame::Reader;
use super::runner;
use crate::cli::test::coverage_include;
use crate::cli::test::json_reporter::JsonReporter;
use crate::test_command::{
    JunitReporter, TestCaseReport, TestFailure, finish_coverage_reports, junit_file_name,
};
use crate::test_runner::execution::Result as TestResult;

/// Feed every worker's per-test records through the coordinator's own
/// reporters in canonical file order, so the JUnit or JSON document is the one
/// a serial run would have written.
pub(crate) fn replay_test_records(coord: &mut Coordinator) {
    let files = core::mem::take(&mut coord.test_records);
    (coord.reporter).with_junit_and_json(|junit, json| replay_into(junit, json, coord, &files));
}

fn replay_into(
    mut junit: Option<&mut JunitReporter>,
    mut json: Option<&mut JsonReporter>,
    coord: &Coordinator,
    files: &[FileTestRecords],
) {
    if junit.is_none() && json.is_none() {
        return;
    }
    for (idx, file) in files.iter().enumerate() {
        let path = coord.schedule.path(idx);
        let rel = junit_file_name(path);
        if let Some(junit) = junit.as_deref_mut() {
            junit.file_start_unix_ms = file
                .started_unix_ms
                .unwrap_or_else(bun_core::time::milli_timestamp);
        }
        if let Some(json) = json.as_deref_mut() {
            json.begin_file(path);
        }
        for payload in &file.tests {
            if let Some(test) = runner::decode_test_case(&mut Reader { p: payload }, rel) {
                if let Some(junit) = junit.as_deref_mut() {
                    junit.record_test_case(&test).expect("oom");
                }
                if let Some(json) = json.as_deref_mut() {
                    json.record_test_case(&test);
                }
            }
        }
        if let Some((name, message)) = file.unfinished {
            let unfinished = TestCaseReport {
                file: rel,
                scopes: Vec::new(),
                name: name.as_bytes(),
                status: TestResult::Fail,
                assertions: 0,
                elapsed_ns: 0,
                line_number: 0,
                column_number: 0,
                unhandled: true,
                failure: Some(TestFailure {
                    message: message.into(),
                    ..Default::default()
                }),
                earlier_failures: Vec::new(),
            };
            if let Some(junit) = junit.as_deref_mut() {
                junit.record_test_case(&unfinished).expect("oom");
            }
            if let Some(json) = json.as_deref_mut() {
                json.record_test_case(&unfinished);
            }
        }
        if let Some(junit) = junit.as_deref_mut() {
            junit
                .end_file(Some(rel), Some(file.elapsed_ns))
                .expect("oom");
        }
        if let Some(json) = json.as_deref_mut() {
            json.end_file(Some(file.elapsed_ns));
        }
    }
}

pub(crate) fn write_coverage_report(
    coord: &mut Coordinator,
    vm: &VirtualMachine,
    opts: &mut CodeCoverageOptions,
    mut include: Option<&mut coverage_include::Run>,
) {
    let mut merged = core::mem::take(&mut coord.coverage_files);
    let mut reports: Vec<Report<'static>> = Vec::with_capacity(merged.count());
    for m in merged.values_mut() {
        reports.push(bun_core::handle_oom(core::mem::take(m).finish()));
    }
    if let Some(run) = include.as_deref_mut()
        && (coord.aborted.is_some()
            || coord.stop_reason.is_some()
            || coord.worker_crashed
            || coord.schedule.has_queued()
            || coord.schedule.running().next().is_some())
    {
        run.ended_early();
    }
    let include = include.as_deref();
    if reports.is_empty() && !include.is_some_and(coverage_include::Run::adds_files) {
        return;
    }
    index_sort::sort_slice_unstable_by(&mut reports, |a, b| a.source_url.cmp(&b.source_url));
    // SIGINT and SIGTERM only set a flag while the coordinator runs.
    let interrupted = || abort_handler::ABORT_SIGNAL.load(Ordering::Acquire) != 0;
    match finish_coverage_reports(vm, opts, include, reports, &interrupted) {
        Ok(coverage_include::Completed::Yes) => {}
        Ok(coverage_include::Completed::Interrupted) => {
            let signal = abort_handler::ABORT_SIGNAL.load(Ordering::Acquire);
            coord
                .aborted
                .get_or_insert_with(|| u32::from(bun_sys::SignalCode(signal as u8).to_exit_code()));
        }
        Err(err) => {
            err.print();
            coord.aborted.get_or_insert(1);
        }
    }
}
