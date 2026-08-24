//! Builds the single JUnit or JSON document and the coverage report from the
//! per-file data workers stream over IPC, once `drive()` completes.

use bun_collections::index_sort;
use bun_core::Output;
use bun_options_types::code_coverage_options::CodeCoverageOptions;
use bun_sourcemap_jsc::code_coverage::Report;

use super::coordinator::Coordinator;
use super::frame::Reader;
use super::runner;
use crate::test_command::{TestCaseReport, TestFailure, junit_file_name, print_coverage_reports};
use crate::test_runner::execution::Result as TestResult;

/// Feed every worker's per-test records through the coordinator's own
/// reporters in canonical file order, so the JUnit or JSON document is the one
/// a serial run would have written.
pub(crate) fn replay_test_records(coord: &mut Coordinator) {
    let files = core::mem::take(&mut coord.test_records);
    let mut junit = coord.reporter.reporters.junit.as_deref_mut();
    let mut json = coord.reporter.reporters.json.as_deref_mut();
    if junit.is_none() && json.is_none() {
        return;
    }
    for (idx, file) in files.iter().enumerate() {
        let path = coord.files[idx].as_bytes();
        let rel = junit_file_name(path);
        if let Some(junit) = junit.as_deref_mut() {
            junit.file_start_unix_ms = if file.started_unix_ms != 0 {
                file.started_unix_ms
            } else {
                bun_core::time::milli_timestamp()
            };
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
        if let Some((name, message)) = &file.unfinished {
            let unfinished = TestCaseReport {
                file: rel,
                scopes: Vec::new(),
                name,
                status: TestResult::Fail,
                assertions: 0,
                elapsed_ns: 0,
                line_number: 0,
                column_number: 0,
                unhandled: true,
                failure: Some(TestFailure {
                    message: message.to_vec(),
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

pub(crate) fn write_coverage_report(coord: &mut Coordinator, opts: &mut CodeCoverageOptions) {
    let mut merged = core::mem::take(&mut coord.coverage_files);
    let mut reports: Vec<Report<'static>> = Vec::with_capacity(merged.count());
    for m in merged.values_mut() {
        reports.push(bun_core::handle_oom(core::mem::take(m).finish()));
    }
    if reports.is_empty() {
        return;
    }
    index_sort::sort_slice_unstable_by(&mut reports, |a, b| a.source_url.cmp(&b.source_url));
    if let Err(err) = print_coverage_reports(opts, &reports) {
        Output::err(err, "Failed to write lcov.info", ());
        coord.aborted.get_or_insert(1);
    }
}
