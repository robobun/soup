//! `bun test --reporter=json`: Jest's `--json` results document, which is also
//! what vitest's `--reporter=json` produces, so tools written for either read
//! it as is. Written once, at the end of the run, to `--reporter-outfile` or to
//! stdout.
//!
//! ```json
//! {
//!   "numTotalTestSuites": 1, "numPassedTestSuites": 1, "numFailedTestSuites": 0,
//!   "numPendingTestSuites": 0, "numRuntimeErrorTestSuites": 0,
//!   "numTotalTests": 2, "numPassedTests": 1, "numFailedTests": 0,
//!   "numPendingTests": 1, "numTodoTests": 0,
//!   "startTime": 1724500000000, "success": true,
//!   "testResults": [{
//!     "name": "/home/me/app/math.test.ts", "status": "passed",
//!     "startTime": 1724500000001, "endTime": 1724500000050, "message": "",
//!     "assertionResults": [{
//!       "ancestorTitles": ["math"], "fullName": "math adds", "title": "adds",
//!       "status": "passed", "duration": 0.42, "failureMessages": [],
//!       "location": { "line": 4, "column": 1 }
//!     }]
//!   }]
//! }
//! ```
//!
//! One `testResults` entry per test file, one `assertionResults` entry per
//! test. Tests that `-t` or `.only` leave out are not listed, as in the console
//! output. The reporter consumes the same `TestCaseReport` the JUnit reporter
//! does: the serial runner records each test as it finishes, the `--parallel`
//! coordinator replays the workers' records in file order (see
//! `parallel/aggregate.rs`).

use std::io::Write as _;

use bstr::BStr;
use bun_core::fmt::format_json_string_utf8;
use bun_core::{Output, time};
use bun_sys::{Fd, File, O};

use crate::test_command::{TestCaseReport, TestFailure};
use crate::test_runner::execution::{Basic, Result as TestResult};

/// Jest's `testResults[].status`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FileStatus {
    Passed,
    Failed,
    /// Every test in the file is skipped or todo.
    Skipped,
    /// The file threw while loading or outside of any test. Jest reports these
    /// as `failed` and counts them in `numRuntimeErrorTestSuites` as well.
    Error,
}

impl FileStatus {
    fn as_str(self) -> &'static str {
        match self {
            FileStatus::Passed => "passed",
            FileStatus::Failed | FileStatus::Error => "failed",
            FileStatus::Skipped => "skipped",
        }
    }
}

/// How many of a file's tests ended with each Jest status.
#[derive(Default, Clone, Copy)]
struct TestCounts {
    passed: u32,
    failed: u32,
    /// Skipped tests, and every test under `--dry-run`.
    pending: u32,
    todo: u32,
}

impl TestCounts {
    fn add(&mut self, other: &TestCounts) {
        self.passed += other.passed;
        self.failed += other.failed;
        self.pending += other.pending;
        self.todo += other.todo;
    }
}

/// One finished file's serialized `testResults` entry.
struct FileResult {
    status: FileStatus,
    counts: TestCounts,
    json: Box<[u8]>,
}

pub struct JsonReporter {
    /// Finished files, in completion order.
    files: Vec<FileResult>,
    current: Option<CurrentFile>,
}

struct CurrentFile {
    path: Box<[u8]>,
    start_ms: i64,
    /// Comma separated `assertionResults` entries.
    assertions: Vec<u8>,
    counts: TestCounts,
}

impl JsonReporter {
    pub(crate) fn init() -> Box<JsonReporter> {
        Box::new(JsonReporter {
            files: Vec::new(),
            current: None,
        })
    }

    /// Called before a file is loaded, with its absolute path. Repeats of the
    /// same file (`--rerun-each`) keep adding to the same entry.
    pub(crate) fn begin_file(&mut self, path: &[u8]) {
        if let Some(current) = &self.current {
            if *current.path == *path {
                return;
            }
            self.end_file(None, None);
        }
        self.current = Some(CurrentFile {
            path: Box::from(path),
            start_ms: time::milli_timestamp(),
            assertions: Vec::new(),
            counts: TestCounts::default(),
        });
    }

    /// Appends the file's `testResults` entry. `failure` is an error the file
    /// threw outside of any test; it becomes the entry's `message` and makes
    /// the file a runtime error suite. `elapsed_ns` is the file's run time when
    /// the caller measured it (the `--parallel` coordinator replaying a
    /// worker's file), else the time since `begin_file`.
    pub(crate) fn end_file(&mut self, failure: Option<&TestFailure>, elapsed_ns: Option<u64>) {
        let Some(current) = self.current.take() else {
            return;
        };

        let counts = current.counts;
        let status = if failure.is_some() {
            FileStatus::Error
        } else if counts.failed > 0 {
            FileStatus::Failed
        } else if counts.passed == 0 && counts.pending + counts.todo > 0 {
            FileStatus::Skipped
        } else {
            FileStatus::Passed
        };

        let end_ms = time::milli_timestamp();
        let start_ms = match elapsed_ns {
            Some(ns) => end_ms - (ns / time::NS_PER_MS) as i64,
            None => current.start_ms,
        };

        let mut json: Vec<u8> = Vec::with_capacity(current.assertions.len() + 256);
        let _ = write!(
            &mut json,
            "{{\"name\":{},\"status\":\"{}\",\"startTime\":{},\"endTime\":{},\"message\":",
            format_json_string_utf8(&current.path, Default::default()),
            status.as_str(),
            start_ms,
            end_ms,
        );
        let message: &[u8] = failure.map(|f| f.body.as_slice()).unwrap_or(b"");
        let _ = write!(
            &mut json,
            "{},\"assertionResults\":[",
            format_json_string_utf8(message, Default::default())
        );
        json.extend_from_slice(&current.assertions);
        json.extend_from_slice(b"]}");

        self.files.push(FileResult {
            status,
            counts,
            json: json.into_boxed_slice(),
        });
    }

    /// Records one finished test of the current file.
    pub(crate) fn record_test_case(&mut self, t: &TestCaseReport<'_>) {
        use TestResult as R;

        if t.status == R::SkippedBecauseLabel {
            return;
        }
        let Some(current) = self.current.as_mut() else {
            return;
        };

        let status = match t.status.basic_result() {
            Basic::Pass => {
                current.counts.passed += 1;
                "passed"
            }
            Basic::Fail => {
                current.counts.failed += 1;
                "failed"
            }
            Basic::Skip | Basic::Pending => {
                current.counts.pending += 1;
                "pending"
            }
            Basic::Todo => {
                current.counts.todo += 1;
                "todo"
            }
        };

        let out = &mut current.assertions;
        if !out.is_empty() {
            out.push(b',');
        }
        out.extend_from_slice(b"{\"ancestorTitles\":[");
        for (i, &(name, _)) in t.scopes.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            let _ = write!(out, "{}", format_json_string_utf8(name, Default::default()));
        }
        out.extend_from_slice(b"],\"fullName\":");
        let mut full_name: Vec<u8> = Vec::new();
        for &(name, _) in &t.scopes {
            full_name.extend_from_slice(name);
            full_name.push(b' ');
        }
        full_name.extend_from_slice(t.name);
        let _ = write!(
            out,
            "{},\"title\":{},\"status\":\"{}\",\"duration\":",
            format_json_string_utf8(&full_name, Default::default()),
            format_json_string_utf8(t.name, Default::default()),
            status,
        );
        push_millis(out, t.elapsed_ns);
        out.extend_from_slice(b",\"failureMessages\":[");
        if t.status.basic_result() == Basic::Fail {
            let message: Vec<u8> = match t.status {
                R::Fail => match &t.failure {
                    Some(f) if !f.body.is_empty() => f.body.clone(),
                    _ => b"Error: test failed".to_vec(),
                },
                R::FailBecauseTimeout | R::FailBecauseTimeoutWithDoneCallback => {
                    b"TimeoutError: test timed out".to_vec()
                }
                R::FailBecauseHookTimeout | R::FailBecauseHookTimeoutWithDoneCallback => {
                    b"TimeoutError: a beforeEach/afterEach hook timed out".to_vec()
                }
                R::FailBecauseFailingTestPassed => {
                    b"AssertionError: test marked with .failing() did not throw".to_vec()
                }
                R::FailBecauseTodoPassed => b"AssertionError: TODO passed".to_vec(),
                R::FailBecauseExpectedHasAssertions => {
                    b"AssertionError: Expected to have assertions, but none were run".to_vec()
                }
                R::FailBecauseExpectedAssertionCount => format!(
                    "AssertionError: Expected more assertions, but only received {}",
                    t.assertions
                )
                .into_bytes(),
                R::Pending | R::Pass | R::Skip | R::SkippedBecauseLabel | R::Todo => Vec::new(),
            };
            let _ = write!(
                out,
                "{}",
                format_json_string_utf8(&message, Default::default())
            );
        }
        out.extend_from_slice(b"],\"location\":");
        match (t.line_number, t.column_number) {
            (line, column) if line > 0 && column > 0 => {
                let _ = write!(out, "{{\"line\":{line},\"column\":{column}}}");
            }
            _ => out.extend_from_slice(b"null"),
        }
        out.push(b'}');
    }

    /// Finishes the current file, if any, and writes the document to `outfile`
    /// or to stdout.
    pub(crate) fn write(&mut self, outfile: Option<&[u8]>) {
        self.end_file(None, None);
        let mut contents: Vec<u8> = Vec::new();
        self.write_document(&mut contents);
        write_report(outfile, &contents);
    }

    /// The whole document. As in Jest, a file that threw outside of its tests
    /// counts as a failed suite and a runtime-error suite, not as a failed test.
    fn write_document(&self, out: &mut Vec<u8>) {
        let files = &self.files;
        let mut passed_suites: u32 = 0;
        let mut failed_suites: u32 = 0;
        let mut skipped_suites: u32 = 0;
        let mut error_suites: u32 = 0;
        let mut tests = TestCounts::default();
        for file in files {
            tests.add(&file.counts);
            match file.status {
                FileStatus::Passed => passed_suites += 1,
                FileStatus::Failed => failed_suites += 1,
                FileStatus::Skipped => skipped_suites += 1,
                FileStatus::Error => {
                    failed_suites += 1;
                    error_suites += 1;
                }
            }
        }
        let total = tests.passed + tests.failed + tests.pending + tests.todo;
        let success = failed_suites == 0;

        let _ = write!(
            out,
            "{{\n  \"numTotalTestSuites\": {},\n  \"numPassedTestSuites\": {},\n  \"numFailedTestSuites\": {},\n  \"numPendingTestSuites\": {},\n  \"numRuntimeErrorTestSuites\": {},\n  \"numTotalTests\": {},\n  \"numPassedTests\": {},\n  \"numFailedTests\": {},\n  \"numPendingTests\": {},\n  \"numTodoTests\": {},\n  \"startTime\": {},\n  \"success\": {},\n  \"testResults\": [",
            files.len(),
            passed_suites,
            failed_suites,
            skipped_suites,
            error_suites,
            total,
            tests.passed,
            tests.failed,
            tests.pending,
            tests.todo,
            bun_core::start_time() / time::NS_PER_MS as i128,
            success,
        );
        for (i, file) in files.iter().enumerate() {
            out.extend_from_slice(if i == 0 { b"\n    " } else { b",\n    " });
            out.extend_from_slice(&file.json);
        }
        if !files.is_empty() {
            out.extend_from_slice(b"\n  ");
        }
        out.extend_from_slice(b"]\n}\n");
    }
}

/// `ns` as fractional milliseconds with at most three decimals.
fn push_millis(out: &mut Vec<u8>, ns: u64) {
    let micros = ns / time::NS_PER_US;
    let _ = write!(out, "{}", micros / 1000);
    let frac = micros % 1000;
    if frac > 0 {
        let mut digits = [b'0'; 3];
        digits[0] += (frac / 100) as u8;
        digits[1] += (frac / 10 % 10) as u8;
        digits[2] += (frac % 10) as u8;
        let mut len = 3;
        while digits[len - 1] == b'0' {
            len -= 1;
        }
        out.push(b'.');
        out.extend_from_slice(&digits[..len]);
    }
}

fn write_report(outfile: Option<&[u8]>, contents: &[u8]) {
    let Some(path) = outfile else {
        let _ = Output::writer().write_all(contents);
        Output::flush();
        return;
    };
    let path_z = bun_core::ZBox::from_bytes(path);
    let written = File::openat(Fd::cwd(), &path_z, O::WRONLY | O::CREAT | O::TRUNC, 0o664)
        .and_then(|file| file.write_all(contents));
    if let Err(err) = written {
        Output::err(
            crate::Error::JSONReportFailed,
            "Failed to write JSON report to {}\n{}",
            (BStr::new(path), err),
        );
    }
}
