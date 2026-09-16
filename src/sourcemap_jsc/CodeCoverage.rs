use core::cell::UnsafeCell;
use core::ffi::{c_int, c_void};
use core::ptr::NonNull;
use std::borrow::Cow;

use bun_ast::Loc;
use bun_collections::VecExt;
use bun_collections::bit_set::{DynamicBitSet, Range};
use bun_core::{self, Utf8Bytes};
use bun_jsc::{JSGlobalObject, JSValue, VM, bun_string_jsc};
use bun_sourcemap::{
    LineOffsetTable, LineOffsetTableColumns as _, Ordinal, ParsedSourceMap, internal_source_map,
    line_offset_table,
};

type LinesHits = Vec<u32>;
type Bitset = DynamicBitSet;

/// Our code coverage currently only deals with lines of code, not statements or branches.
/// JSC doesn't expose function names in their coverage data, so we don't include that either :(.
/// Since we only need to store line numbers, our job gets simpler
///
/// We can use two bitsets to store code coverage data for a given file
/// 1. executable_lines
/// 2. lines_which_have_executed
///
/// Not all lines of code are executable. Comments, whitespace, empty lines, etc. are not executable.
/// It's not a problem for anyone if comments, whitespace, empty lines etc are not executed, so those should always be omitted from coverage reports
///
/// We use two bitsets since the typical size will be decently small,
/// bitsets are simple and bitsets are relatively fast to construct and query
pub struct Report<'a> {
    pub source_url: Cow<'a, [u8]>,
    pub(crate) executable_lines: Bitset,
    pub(crate) lines_which_have_executed: Bitset,
    pub(crate) line_hits: LinesHits,
    /// Indexed in step with `functions_which_have_executed`.
    pub(crate) functions: Vec<ByteRange>,
    pub(crate) functions_which_have_executed: Bitset,
    /// Indexed in step with `stmts_which_have_executed`.
    pub(crate) stmts: Vec<ByteRange>,
    pub(crate) stmts_which_have_executed: Bitset,
}

impl<'a> Report<'a> {
    pub fn lines_coverage_fraction(&self) -> f64 {
        let mut intersected = self
            .executable_lines
            .clone()
            .unwrap_or_else(|_| bun_alloc::out_of_memory());
        intersected.set_intersection(&self.lines_which_have_executed);

        let total_count: f64 = self.executable_lines.count() as f64;
        if total_count == 0.0 {
            return 1.0;
        }

        let intersected_count: f64 = intersected.count() as f64;

        intersected_count / total_count
    }

    pub fn stmts_coverage_fraction(&self) -> f64 {
        let total_count: f64 = self.stmts.len() as f64;

        if total_count == 0.0 {
            return 1.0;
        }

        (self.stmts_which_have_executed.count() as f64) / total_count
    }

    pub fn function_coverage_fraction(&self) -> f64 {
        let total_count: f64 = self.functions.len() as f64;
        if total_count == 0.0 {
            return 1.0;
        }
        (self.functions_which_have_executed.count() as f64) / total_count
    }

    /// This file's fractions, with `failing` judged against `thresholds`.
    pub fn fraction(&self, thresholds: &Fraction) -> Fraction {
        let functions = self.function_coverage_fraction();
        let lines = self.lines_coverage_fraction();
        Fraction {
            functions,
            lines,
            stmts: self.stmts_coverage_fraction(),
            failing: functions < thresholds.functions || lines < thresholds.lines,
        }
    }

    /// Detach from the `ByteRangeMapping` this was generated from.
    pub fn into_owned(self) -> Report<'static> {
        Report {
            source_url: Cow::Owned(self.source_url.into_owned()),
            ..self
        }
    }

    /// Leave the `ignored` lines out of the report. A function that starts on
    /// one is left out as a whole, with its lines and the functions in it.
    ///
    /// `function_lines` (the line each function starts on, `u32::MAX` when
    /// that is not known, and its last line) and `stmt_first_lines` are
    /// indexed in step with `functions` and `stmts`.
    fn ignore_lines(
        &mut self,
        ignored: &Bitset,
        function_lines: &[(u32, u32)],
        stmt_first_lines: &[u32],
    ) -> Result<(), bun_alloc::AllocError> {
        let line_count = self.line_hits.len();
        let mut lines = ignored.clone()?;
        lines.resize(line_count, false)?;
        let mut ignored_functions: Vec<ByteRange> = Vec::new();
        for (function, &(first, last)) in self.functions.iter().zip(function_lines) {
            let range = Range {
                start: first as usize,
                end: (last as usize + 1).min(line_count),
            };
            if range.start < range.end && ignored.is_set(range.start) {
                lines.set_range_value(range, true);
                ignored_functions.push(*function);
            }
        }

        let functions = self.functions.clone();
        Self::remove_ranges(
            &mut self.functions,
            &mut self.functions_which_have_executed,
            |i| {
                ignored_functions
                    .iter()
                    .any(|outer| outer.start <= functions[i].start && functions[i].end <= outer.end)
            },
        )?;
        Self::remove_ranges(&mut self.stmts, &mut self.stmts_which_have_executed, |i| {
            lines.is_set_allow_out_of_bound(stmt_first_lines[i] as usize, false)
        })?;

        self.executable_lines
            .unmanaged
            .set_exclude(&lines.unmanaged);
        self.lines_which_have_executed
            .unmanaged
            .set_exclude(&lines.unmanaged);
        let mut iter = lines.iterator::<true, true>();
        while let Some(line) = iter.next() {
            self.line_hits[line] = 0;
        }
        Ok(())
    }

    fn remove_ranges(
        ranges: &mut Vec<ByteRange>,
        executed: &mut Bitset,
        remove: impl Fn(usize) -> bool,
    ) -> Result<(), bun_alloc::AllocError> {
        let mut kept_executed = Bitset::init_empty(ranges.len())?;
        let mut kept = 0;
        for i in 0..ranges.len() {
            if remove(i) {
                continue;
            }
            if executed.is_set(i) {
                kept_executed.set(kept);
            }
            ranges[kept] = ranges[i];
            kept += 1;
        }
        ranges.truncate(kept);
        kept_executed.resize(kept, false)?;
        *executed = kept_executed;
        Ok(())
    }

    /// `ignored_lines` are zero-based lines of the original source to leave
    /// out of the report (see [`ignore_hints`]).
    pub fn generate(
        global_this: &JSGlobalObject,
        byte_range_mapping: &'a ByteRangeMapping,
        ignore_sourcemap_: bool,
        ignored_lines: Option<&Bitset>,
    ) -> Option<Report<'a>> {
        bun_jsc::mark_binding();
        // Use the raw `*mut VM` accessor instead of narrowing through `&VM` and
        // casting back to `*mut` — C++ mutates the VM (controlFlowProfiler /
        // functionHasExecutedCache), so we must preserve write provenance.
        let vm = global_this.vm_ptr();

        let mut result: Option<Report<'a>> = None;

        let mut generator = Generator {
            result: &mut result,
            byte_range_mapping,
            ignored_lines,
        };

        // SAFETY: `vm` is the live `*mut VM` owning `global_this`; Generator and the
        // callback are kept alive for the duration of the FFI call;
        // CodeCoverage__withBlocksAndFunctions invokes the callback synchronously.
        let ok = unsafe {
            CodeCoverage__withBlocksAndFunctions(
                vm,
                generator.byte_range_mapping.source_id,
                (&raw mut generator).cast::<c_void>(),
                ignore_sourcemap_,
                Generator::do_,
            )
        };
        if !ok {
            return None;
        }

        result
    }
}

/// Byte encoding of a `Report` for handing one process's coverage of a file to
/// another (`bun test --parallel` workers → coordinator). Both ends are the
/// same executable on the same host, so integers and bitset words are written
/// in native layout.
///
///   str  source_url
///   u32  line_count, then executable_lines words, lines_which_have_executed
///        words, line_count × u32 hits
///   u32  n_functions, then n × {u32 start, u32 end}, executed words
///   u32  n_stmts, same shape
pub mod wire {
    use super::*;

    fn put_u32(out: &mut Vec<u8>, v: u32) {
        out.extend_from_slice(&v.to_ne_bytes());
    }

    fn put_ranges(out: &mut Vec<u8>, ranges: &[ByteRange], executed: &Bitset) {
        debug_assert_eq!(executed.bit_length(), ranges.len());
        put_u32(out, u32::try_from(ranges.len()).expect("int cast"));
        for r in ranges {
            put_u32(out, r.start);
            put_u32(out, r.end);
        }
        out.extend_from_slice(executed.bytes());
    }

    pub fn encode(report: &Report<'_>, out: &mut Vec<u8>) {
        let line_count = report.line_hits.len();
        debug_assert_eq!(report.executable_lines.bit_length(), line_count);
        debug_assert_eq!(report.lines_which_have_executed.bit_length(), line_count);

        put_u32(
            out,
            u32::try_from(report.source_url.len()).expect("int cast"),
        );
        out.extend_from_slice(&report.source_url);
        put_u32(out, u32::try_from(line_count).expect("int cast"));
        out.extend_from_slice(report.executable_lines.bytes());
        out.extend_from_slice(report.lines_which_have_executed.bytes());
        out.extend_from_slice(bun_core::cast_slice::<u32, u8>(&report.line_hits));
        put_ranges(
            out,
            &report.functions,
            &report.functions_which_have_executed,
        );
        put_ranges(out, &report.stmts, &report.stmts_which_have_executed);
    }

    struct Reader<'a>(&'a [u8]);

    impl<'a> Reader<'a> {
        fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
            let (head, tail) = self.0.split_at_checked(n)?;
            self.0 = tail;
            Some(head)
        }
        fn u32(&mut self) -> Option<u32> {
            Some(u32::from_ne_bytes(self.bytes(4)?.try_into().unwrap()))
        }
        fn len(&mut self) -> Option<usize> {
            self.u32().map(|n| n as usize)
        }
        fn bitset(&mut self, bit_length: usize) -> Option<Bitset> {
            let words = bit_length.div_ceil(usize::BITS as usize) * core::mem::size_of::<usize>();
            Bitset::from_bytes(bit_length, self.bytes(words)?).ok()?
        }
        fn ranges(&mut self) -> Option<(Vec<ByteRange>, Bitset)> {
            let n = self.len()?;
            let mut ranges = Vec::with_capacity(n.min(self.0.len() / 8));
            for _ in 0..n {
                ranges.push(ByteRange {
                    start: self.u32()?,
                    end: self.u32()?,
                });
            }
            Some((ranges, self.bitset(n)?))
        }
    }

    pub fn decode(bytes: &[u8]) -> Option<Report<'static>> {
        let mut r = Reader(bytes);
        let url_len = r.len()?;
        let source_url = Cow::Owned(r.bytes(url_len)?.to_vec());
        let line_count = r.len()?;
        // Bound the allocations below by the input size, not by a length
        // field read from it.
        if line_count.checked_mul(4)? > r.0.len() {
            return None;
        }
        let executable_lines = r.bitset(line_count)?;
        let lines_which_have_executed = r.bitset(line_count)?;
        let mut line_hits = vec![0u32; line_count];
        bun_core::cast_slice_mut::<u32, u8>(&mut line_hits)
            .copy_from_slice(r.bytes(line_count * 4)?);
        let (functions, functions_which_have_executed) = r.ranges()?;
        let (stmts, stmts_which_have_executed) = r.ranges()?;
        if !r.0.is_empty() {
            return None;
        }
        Some(Report {
            source_url,
            executable_lines,
            lines_which_have_executed,
            line_hits,
            functions,
            functions_which_have_executed,
            stmts,
            stmts_which_have_executed,
        })
    }
}

/// Folds several processes' `Report`s for one source file into one, for
/// `bun test --parallel` where each worker that loaded the file reports it.
///
/// Hits and executed lines/functions/blocks union across reports. Executable
/// lines do not: a process that never ran a function marks the function's
/// whole line span (blank lines included) executable, while one that ran it
/// knows the real lines. So a line counts as executable only if it executed
/// somewhere or every report agrees it is executable; otherwise the coarse
/// span from an import-only worker would show a fully executed function as
/// partially covered (#39930).
#[derive(Default)]
pub struct MergedReport {
    source_url: Vec<u8>,
    reports: u32,
    executable_in_all: Bitset,
    executed_in_any: Bitset,
    line_hits: LinesHits,
    /// Every report's ranges with their executed bit; deduplicated in `finish`.
    functions: Vec<(ByteRange, bool)>,
    stmts: Vec<(ByteRange, bool)>,
}

impl MergedReport {
    pub fn add(&mut self, report: &Report<'_>) -> Result<(), bun_alloc::AllocError> {
        let n = report.line_hits.len();
        self.reports += 1;
        if self.reports == 1 {
            self.source_url = report.source_url.to_vec();
            self.executable_in_all = report.executable_lines.clone()?;
            self.executed_in_any = report.lines_which_have_executed.clone()?;
            self.line_hits.clone_from(&report.line_hits);
        } else {
            if n != self.line_hits.len() {
                // Same path, different contents between workers. Keep the
                // longer view; lines past the shorter one's end count only
                // if executed.
                let len = n.max(self.line_hits.len());
                self.executable_in_all.resize(len, false)?;
                self.executed_in_any.resize(len, false)?;
                self.line_hits.resize(len, 0);
            }
            let mut executable = report.executable_lines.clone()?;
            let mut executed = report.lines_which_have_executed.clone()?;
            executable.resize(self.line_hits.len(), false)?;
            executed.resize(self.line_hits.len(), false)?;
            self.executable_in_all.set_intersection(&executable);
            self.executed_in_any.set_union(&executed);
            for (sum, &hits) in self.line_hits.iter_mut().zip(&report.line_hits) {
                *sum = sum.saturating_add(hits);
            }
        }
        for (i, &r) in report.functions.iter().enumerate() {
            self.functions
                .push((r, report.functions_which_have_executed.is_set(i)));
        }
        for (i, &r) in report.stmts.iter().enumerate() {
            self.stmts
                .push((r, report.stmts_which_have_executed.is_set(i)));
        }
        Ok(())
    }

    fn dedupe(
        mut all: Vec<(ByteRange, bool)>,
    ) -> Result<(Vec<ByteRange>, Bitset), bun_alloc::AllocError> {
        all.sort_unstable_by_key(|e| e.0);
        all.dedup_by(|next, kept| {
            next.0 == kept.0 && {
                kept.1 |= next.1;
                true
            }
        });
        let mut executed = Bitset::init_empty(all.len())?;
        let mut ranges = Vec::with_capacity(all.len());
        for (i, (r, hit)) in all.into_iter().enumerate() {
            if hit {
                executed.set(i);
            }
            ranges.push(r);
        }
        Ok((ranges, executed))
    }

    pub fn finish(self) -> Result<Report<'static>, bun_alloc::AllocError> {
        let mut executable_lines = self.executable_in_all;
        executable_lines.set_union(&self.executed_in_any);
        let (functions, functions_which_have_executed) = Self::dedupe(self.functions)?;
        let (stmts, stmts_which_have_executed) = Self::dedupe(self.stmts)?;
        Ok(Report {
            source_url: Cow::Owned(self.source_url),
            executable_lines,
            lines_which_have_executed: self.executed_in_any,
            line_hits: self.line_hits,
            functions,
            functions_which_have_executed,
            stmts,
            stmts_which_have_executed,
        })
    }
}

pub mod text {
    use super::*;
    // The `pretty_fmt!` macro only accepts literal `true`/`false` today,
    // so call the runtime rewriter for the `ENABLE_COLORS` const-generic sites.
    // PERF: runtime `pretty_fmt` allocates a small Vec per call — if hot,
    // hoist into `const` once the proc-macro lands.
    use bun_core::output::pretty_fmt;

    pub fn write_format_with_values<const ENABLE_COLORS: bool>(
        filename: &[u8],
        max_filename_length: usize,
        vals: Fraction,
        failing: Fraction,
        failed: bool,
        writer: &mut impl bun_io::Write,
        indent_name: bool,
    ) -> bun_io::Result<()> {
        if ENABLE_COLORS {
            if failed {
                writer.write_all(&pretty_fmt::<true>("<r><b><red>"))?;
            } else {
                writer.write_all(&pretty_fmt::<true>("<r><b><green>"))?;
            }
        }

        if indent_name {
            writer.write_all(b" ")?;
        }

        writer.write_all(filename)?;
        writer.splat_byte_all(
            b' ',
            max_filename_length - filename.len() + usize::from(!indent_name),
        )?;
        writer.write_all(&pretty_fmt::<ENABLE_COLORS>("<r><d> | <r>"))?;

        if ENABLE_COLORS {
            if vals.functions < failing.functions {
                writer.write_all(&pretty_fmt::<true>("<b><red>"))?;
            } else {
                writer.write_all(&pretty_fmt::<true>("<b><green>"))?;
            }
        }

        write!(writer, "{:>7.2}", vals.functions * 100.0)?;
        // writer.write_all(&pretty_fmt("<r><d> | <r>", ENABLE_COLORS))?;
        // if ENABLE_COLORS {
        //     // if vals.stmts < failing.stmts {
        //     writer.write_all(&pretty_fmt("<d>", true))?;
        //     // } else {
        //     //     writer.write_all(&pretty_fmt("<d>", true))?;
        //     // }
        // }
        // write!(writer, "{:>8.2}", vals.stmts * 100.0)?;
        writer.write_all(&pretty_fmt::<ENABLE_COLORS>("<r><d> | <r>"))?;

        if ENABLE_COLORS {
            if vals.lines < failing.lines {
                writer.write_all(&pretty_fmt::<true>("<b><red>"))?;
            } else {
                writer.write_all(&pretty_fmt::<true>("<b><green>"))?;
            }
        }

        write!(writer, "{:>7.2}", vals.lines * 100.0)?;
        Ok(())
    }

    /// One table row: name, the two percentages from `fraction` (coloured
    /// against `thresholds`), and the uncovered line ranges.
    pub fn write_format<const ENABLE_COLORS: bool>(
        report: &Report,
        max_filename_length: usize,
        fraction: &Fraction,
        thresholds: &Fraction,
        base_path: &[u8],
        writer: &mut impl bun_io::Write,
    ) -> bun_io::Result<()> {
        let mut filename: &[u8] = &report.source_url;
        if !base_path.is_empty() {
            filename = bun_paths::resolve_path::relative(base_path, filename);
        }

        write_format_with_values::<ENABLE_COLORS>(
            filename,
            max_filename_length,
            *fraction,
            *thresholds,
            fraction.failing,
            writer,
            true,
        )?;

        writer.write_all(&pretty_fmt::<ENABLE_COLORS>("<r><d> | <r>"))?;

        let mut executable_lines_that_havent_been_executed = report
            .lines_which_have_executed
            .clone()
            .unwrap_or_else(|_| bun_alloc::out_of_memory());
        executable_lines_that_havent_been_executed.toggle_all();

        // This sets statements in executed scopes
        executable_lines_that_havent_been_executed.set_intersection(&report.executable_lines);

        let mut iter = executable_lines_that_havent_been_executed.iterator::<true, true>();

        // `concat!(pretty_fmt!(..), "{}")` requires a literal; split into a
        // prefix `write_all` + plain `write!` so the const-generic `ENABLE_COLORS` can
        // route through the runtime rewriter.
        let red = pretty_fmt::<ENABLE_COLORS>("<red>");
        let comma = pretty_fmt::<ENABLE_COLORS>("<r><d>,<r>");

        let mut is_first = true;
        let mut emit =
            |writer: &mut dyn bun_io::Write, start: usize, end: usize| -> bun_io::Result<()> {
                if !core::mem::take(&mut is_first) {
                    writer.write_all(&comma)?;
                }
                writer.write_all(&red)?;
                if start == end {
                    write!(writer, "{}", start + 1)
                } else {
                    write!(writer, "{}-{}", start + 1, end + 1)
                }
            };
        let mut range: Option<(usize, usize)> = None;
        while let Some(line) = iter.next() {
            range = match range {
                Some((start, end)) if line == end + 1 => Some((start, line)),
                Some((start, end)) => {
                    emit(writer, start, end)?;
                    Some((line, line))
                }
                None => Some((line, line)),
            };
        }
        if let Some((start, end)) = range {
            emit(writer, start, end)?;
        }
        Ok(())
    }
}

pub mod lcov {
    use super::*;

    pub fn write_format(
        report: &Report,
        base_path: &[u8],
        writer: &mut impl bun_io::Write,
    ) -> bun_io::Result<()> {
        let mut filename: &[u8] = &report.source_url;
        if !base_path.is_empty() {
            filename = bun_paths::resolve_path::relative(base_path, filename);
        }

        // TN: test name
        // Empty value appears fine. For example, `TN:`.
        writer.write_all(b"TN:\n")?;

        // SF: Source File path
        // For example, `SF:path/to/source.ts`
        // Sanitize newlines so a crafted source path cannot inject extra LCOV records.
        writer.write_all(b"SF:")?;
        for &byte in filename {
            match byte {
                b'\n' | b'\r' => writer.write_all(b"?")?,
                byte => writer.write_all(&[byte])?,
            }
        }
        writer.write_all(b"\n")?;

        // ** Per-function coverage not supported yet, since JSC does not support function names yet. **
        // FN: line number,function name

        // FNF: functions found
        writeln!(writer, "FNF:{}", report.functions.len())?;

        // FNH: functions hit
        writeln!(
            writer,
            "FNH:{}",
            report.functions_which_have_executed.count()
        )?;

        // ** Track all executable lines **
        // Executable lines that were not hit should be marked as 0
        // `DynamicBitSet::iterator` borrows `&self`, so no clone is needed.
        let mut iter = report.executable_lines.iterator::<true, true>();

        // ** Branch coverage not supported yet, since JSC does not support those yet. ** //
        // BRDA: line, block, (expressions,count)+
        // BRF: branches found
        // BRH: branches hit
        let line_hits = report.line_hits.slice();
        while let Some(line) = iter.next() {
            // DA: line number, hit count
            writeln!(writer, "DA:{},{}", line + 1, line_hits[line])?;
        }

        // LF: lines found
        writeln!(writer, "LF:{}", report.executable_lines.count())?;

        // LH: lines hit
        writeln!(writer, "LH:{}", report.lines_which_have_executed.count())?;

        writer.write_all(b"end_of_record\n")?;
        Ok(())
    }
}

/// Comments in a source file that leave code out of its coverage report:
///
/// ```js
/// /* v8 ignore next */         // this line and the next one
/// /* v8 ignore next 3 */       // this line and the next three
/// foo(); /* v8 ignore next */  // after code: this line only
/// /* v8 ignore start */ ... /* v8 ignore stop */
/// /* v8 ignore file */
/// ```
///
/// `c8`, `istanbul` and `node:coverage` are read in place of `v8`, and
/// `node:coverage disable` / `enable` as `start` / `stop`. These are the rules
/// of v8-to-istanbul (c8, Vitest) and of Node's own coverage: hints count
/// lines, not syntax nodes, and are found in the text of a line, so one
/// written inside a string literal counts as well.
pub mod ignore_hints {
    use super::*;
    use bun_core::strings;

    pub enum IgnoreHints {
        /// `ignore file`: the file is left out of the report.
        File,
        /// One bit per line of the source, set for the lines to leave out.
        Lines(Bitset),
    }

    #[derive(Clone, Copy)]
    enum Hint {
        /// The line of the hint and this many after it.
        Next(u32),
        Start,
        Stop,
        File,
    }

    pub fn scan(source: &[u8]) -> Result<Option<IgnoreHints>, bun_alloc::AllocError> {
        // Every hint has one of these words, and most files have neither.
        let mut offsets: Vec<usize> = Vec::new();
        for word in [&b"ignore"[..], b"node:coverage"] {
            let mut from = 0;
            while let Some(i) = strings::index_of(&source[from..], word) {
                offsets.push(from + i);
                from += i + word.len();
            }
        }
        if offsets.is_empty() {
            return Ok(None);
        }
        offsets.sort_unstable();

        // The same line numbers as the ones in the source map.
        let mut table = LineOffsetTable::generate(source, 0)?;
        let line_starts = table.items_byte_offset_to_start_of_line().to_vec();
        table.drop_elements();
        let line_count = line_starts.len();
        let mut lines = Bitset::init_empty(line_count)?;
        let mut ignore = |start: usize, end: usize| {
            lines.set_range_value(
                Range {
                    start,
                    end: end.min(line_count),
                },
                true,
            );
        };

        let mut any = false;
        let mut region_start: Option<usize> = None;
        let mut previous_line = usize::MAX;
        for offset in offsets {
            let line = line_starts
                .partition_point(|&start| start as usize <= offset)
                .saturating_sub(1);
            if line == previous_line {
                continue;
            }
            previous_line = line;
            let end = line_starts
                .get(line + 1)
                .map_or(source.len(), |&next| next as usize);
            let Some(hint) = parse_line(&source[line_starts[line] as usize..end]) else {
                continue;
            };
            match hint {
                Hint::File => return Ok(Some(IgnoreHints::File)),
                Hint::Next(count) => {
                    ignore(line, line.saturating_add(count as usize).saturating_add(1));
                    any = true;
                }
                Hint::Start => {
                    region_start.get_or_insert(line);
                }
                Hint::Stop => {
                    if let Some(start) = region_start.take() {
                        ignore(start, line + 1);
                        any = true;
                    }
                }
            }
        }
        if let Some(start) = region_start {
            ignore(start, line_count);
            any = true;
        }
        Ok(any.then_some(IgnoreHints::Lines(lines)))
    }

    /// The hint of a comment that opens and closes on this line, if there is
    /// one. Every `/*` and `//` is tried, as what comes before it may be a
    /// string: `fetch("http://host"); /* v8 ignore next */`.
    fn parse_line(line: &[u8]) -> Option<Hint> {
        let mut from = 0;
        while let Some(i) = strings::index_of_char_usize(&line[from..], b'/') {
            let slash = from + i;
            from = slash + 1;
            let comment = match line.get(slash + 1) {
                Some(b'*') => match strings::index_of(&line[slash + 2..], b"*/") {
                    Some(close) => &line[slash + 2..slash + 2 + close],
                    None => continue,
                },
                Some(b'/') => &line[slash + 2..],
                _ => continue,
            };
            if let Some(hint) = parse_comment(comment) {
                return Some(match hint {
                    Hint::Next(_) if has_word(&line[..slash]) => Hint::Next(0),
                    hint => hint,
                });
            }
        }
        None
    }

    /// `comment` is the text between the delimiters.
    fn parse_comment(comment: &[u8]) -> Option<Hint> {
        // `/* istanbul ignore next: the reason */`
        let is = |word: &[u8], keyword: &[u8]| {
            word.strip_prefix(keyword)
                .is_some_and(|rest| !has_word(rest))
        };
        let mut words = strings::tokenize_any(comment, b" \t\r\n*");
        let tool = words.next()?;
        if !matches!(tool, b"v8" | b"c8" | b"istanbul" | b"node:coverage") {
            return None;
        }
        let verb = words.next()?;
        if tool == b"node:coverage" && is(verb, b"disable") {
            return Some(Hint::Start);
        }
        if tool == b"node:coverage" && is(verb, b"enable") {
            return Some(Hint::Stop);
        }
        if verb != b"ignore" {
            return None;
        }
        let what = words.next()?;
        if is(what, b"next") {
            return Some(Hint::Next(words.next().and_then(parse_count).unwrap_or(1)));
        }
        if is(what, b"start") {
            return Some(Hint::Start);
        }
        if is(what, b"stop") {
            return Some(Hint::Stop);
        }
        is(what, b"file").then_some(Hint::File)
    }

    /// Whether there is code in `text`, as opposed to blanks and punctuation.
    fn has_word(text: &[u8]) -> bool {
        text.iter().any(|&c| c.is_ascii_alphanumeric() || c == b'_')
    }

    fn parse_count(word: &[u8]) -> Option<u32> {
        if !word.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(word.iter().fold(0u32, |count, &digit| {
            count
                .saturating_mul(10)
                .saturating_add(u32::from(digit - b'0'))
        }))
    }
}

unsafe extern "C" {
    fn CodeCoverage__withBlocksAndFunctions(
        vm: *mut VM,
        source_id: i32,
        ctx: *mut c_void,
        ignore_sourcemap: bool,
        cb: extern "C" fn(&mut Generator, *const BasicBlockRange, usize, usize, bool),
    ) -> bool;
}

struct Generator<'a, 'r> {
    byte_range_mapping: &'a ByteRangeMapping,
    result: &'r mut Option<Report<'a>>,
    ignored_lines: Option<&'r Bitset>,
}

impl Generator<'_, '_> {
    extern "C" fn do_(
        this: &mut Generator,
        blocks_ptr: *const BasicBlockRange,
        blocks_len: usize,
        function_start_offset: usize,
        ignore_sourcemap: bool,
    ) {
        // The C++ side (CodeCoverage.cpp) invokes this callback with `(nullptr, 0, 0)` when
        // basicBlocks is empty. `core::slice::from_raw_parts` requires a non-null, aligned
        // pointer even for zero-length slices, so we must bail before constructing the slice.
        if blocks_len == 0 {
            return;
        }
        // SAFETY: blocks_len != 0, so blocks_ptr[0..blocks_len] is a valid contiguous C array
        // provided by JSC for the duration of this synchronous callback.
        let all = unsafe { core::slice::from_raw_parts(blocks_ptr, blocks_len) };
        let blocks: &[BasicBlockRange] = &all[0..function_start_offset];
        let mut function_blocks: &[BasicBlockRange] = &all[function_start_offset..blocks_len];
        if function_blocks.len() > 1 {
            function_blocks = &function_blocks[1..];
        }

        if blocks.is_empty() {
            return;
        }

        *this.result = this
            .byte_range_mapping
            .generate_report_from_blocks(
                blocks,
                function_blocks,
                ignore_sourcemap,
                this.ignored_lines,
            )
            .ok();
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BasicBlockRange {
    start_offset: c_int,
    end_offset: c_int,
    has_executed: bool,
    execution_count: usize,
}

pub struct ByteRangeMapping {
    pub(crate) line_offset_table: line_offset_table::List,
    pub(crate) source_len: usize,
    pub(crate) source_id: i32,
    pub source_url: Utf8Bytes<'static>,
}

// Keys are already wyhashes (`bun_wyhash::hash` of the source URL — see
// `ByteRangeMapping__find`), so use the identity context instead of
// re-hashing them.
pub type ByteRangeMappingHashMap =
    bun_collections::HashMap<u64, ByteRangeMapping, bun_collections::IdentityContext<u64>>;

thread_local! {
    // Lazily-initialized per-thread map. Stored behind `Box` so the address of the
    // `HashMap` is stable for the lifetime of the thread (extern "C" fns return
    // `*mut ByteRangeMapping` pointing into it). The Box is **owned** by the
    // thread-local — it is dropped on thread exit, never leaked (PORTING.md
    // §Forbidden: no Box::leak).
    static MAP: UnsafeCell<Option<Box<ByteRangeMappingHashMap>>> =
        const { UnsafeCell::new(None) };
}

/// Returns a raw pointer to this thread's map, lazily creating it.
/// The pointer is valid until thread exit (the Box is pinned in the thread-local
/// slot and never moved or dropped earlier).
fn thread_map() -> *mut ByteRangeMappingHashMap {
    MAP.with(|cell| {
        // SAFETY: thread-local; no other reference to this UnsafeCell can exist
        // concurrently on this thread while we hold this exclusive borrow.
        let slot = unsafe { &mut *cell.get() };
        if slot.is_none() {
            *slot = Some(Box::new(ByteRangeMappingHashMap::default()));
        }
        // SAFETY: just ensured Some above; Box deref gives stable address.
        &raw mut **slot.as_mut().unwrap()
    })
}

/// Returns a raw pointer to this thread's map if it has been created, else null.
fn thread_map_opt() -> Option<NonNull<ByteRangeMappingHashMap>> {
    MAP.with(|cell| {
        // SAFETY: thread-local exclusive access.
        let slot = unsafe { &mut *cell.get() };
        slot.as_mut().map(|b| NonNull::from(&mut **b))
    })
}

impl ByteRangeMapping {
    /// Read-only accessor
    /// for the per-thread `ByteRangeMappingHashMap`. Returns `None` if no
    /// coverage data was recorded on this thread.
    ///
    /// The pointer borrows the thread-local `Box`, which is pinned for the
    /// thread's lifetime and never re-entered while the caller holds it
    /// (single-threaded CLI report path). Callers reborrow per-access —
    /// PORTING.md §Global mutable state.
    pub fn map() -> Option<NonNull<ByteRangeMappingHashMap>> {
        thread_map_opt()
    }

    pub(crate) fn generate_report_from_blocks(
        &self,
        blocks: &[BasicBlockRange],
        function_blocks: &[BasicBlockRange],
        ignore_sourcemap: bool,
        ignored_lines: Option<&Bitset>,
    ) -> Result<Report<'_>, bun_alloc::AllocError> {
        let source_url = self.source_url.slice();
        let line_starts = self.line_offset_table.items_byte_offset_to_start_of_line();

        let mut executable_lines: Bitset;
        let mut lines_which_have_executed: Bitset;
        // `SavedSourceMap::get` returns an `Option<Arc<ParsedSourceMap>>`, so the
        // +1 ref is released automatically when `parsed_mappings_` drops at scope
        // exit — no explicit guard is required.
        let parsed_mappings_: Option<std::sync::Arc<ParsedSourceMap>> =
            // SAFETY: `VirtualMachine::get()` returns the live singleton `*mut VirtualMachine`
            // with full write provenance; dereference to call the `&mut self` accessor.
            bun_jsc::VirtualMachine::VirtualMachine::get().as_mut()
                .source_mappings()
                .get(source_url);
        let mut line_hits: LinesHits;

        let mut functions: Vec<ByteRange> = Vec::new();
        functions.reserve_exact(function_blocks.len());
        let mut functions_which_have_executed: Bitset = Bitset::init_empty(function_blocks.len())?;
        let mut stmts_which_have_executed: Bitset = Bitset::init_empty(blocks.len())?;

        let mut stmts: Vec<ByteRange> = Vec::new();
        stmts.reserve_exact(blocks.len());

        // Only filled when there are lines to ignore, for `Report::ignore_lines`.
        let mut function_lines: Vec<(u32, u32)> = Vec::new();
        let mut stmt_first_lines: Vec<u32> = Vec::new();
        // A source with fewer lines than the report is not the one the report
        // numbers its lines by (a plugin's output, a file edited since it ran).
        let has_every_line =
            |lines: &&Bitset, line_count: u32| lines.bit_length() >= line_count as usize;
        let mut ignored_lines = ignored_lines;

        let line_count: u32;

        if ignore_sourcemap || parsed_mappings_.is_none() {
            line_count = line_starts.len() as u32;
            ignored_lines = ignored_lines.filter(|lines| has_every_line(lines, line_count));
            executable_lines = Bitset::init_empty(line_count as usize)?;
            lines_which_have_executed = Bitset::init_empty(line_count as usize)?;
            line_hits = vec![0u32; line_count as usize];
            let line_hits_slice = line_hits.as_mut_slice();

            for block in blocks {
                if block.end_offset < 0 || block.start_offset < 0 {
                    continue; // does not map to anything
                }

                let min: usize =
                    usize::try_from(block.start_offset.min(block.end_offset)).expect("int cast");
                let max: usize =
                    usize::try_from(block.start_offset.max(block.end_offset)).expect("int cast");
                let mut min_line: u32 = u32::MAX;
                let mut max_line: u32 = 0;

                let has_executed = block.has_executed || block.execution_count > 0;

                for byte_offset in min..max {
                    let Some(new_line_index) = LineOffsetTable::find_index(
                        line_starts,
                        Loc {
                            start: i32::try_from(byte_offset).expect("int cast"),
                        },
                    ) else {
                        continue;
                    };
                    let line_start_byte_offset = line_starts[new_line_index];
                    if (line_start_byte_offset as usize) >= byte_offset {
                        continue;
                    }

                    let line: u32 = u32::try_from(new_line_index).expect("int cast");
                    min_line = min_line.min(line);
                    max_line = max_line.max(line);

                    executable_lines.set(line as usize);
                    if has_executed {
                        lines_which_have_executed.set(line as usize);
                        line_hits_slice[line as usize] += 1;
                    }
                }

                if min_line != u32::MAX {
                    if has_executed {
                        stmts_which_have_executed.set(stmts.len());
                    }

                    stmts.push(ByteRange::of(min, max));
                    if ignored_lines.is_some() {
                        stmt_first_lines.push(min_line);
                    }
                }
            }

            for function in function_blocks {
                if function.end_offset < 0 || function.start_offset < 0 {
                    continue; // does not map to anything
                }

                let min: usize = usize::try_from(function.start_offset.min(function.end_offset))
                    .expect("int cast");
                let max: usize = usize::try_from(function.start_offset.max(function.end_offset))
                    .expect("int cast");
                let mut min_line: u32 = u32::MAX;
                let mut max_line: u32 = 0;

                for byte_offset in min..max {
                    let Some(new_line_index) = LineOffsetTable::find_index(
                        line_starts,
                        Loc {
                            start: i32::try_from(byte_offset).expect("int cast"),
                        },
                    ) else {
                        continue;
                    };
                    let line_start_byte_offset = line_starts[new_line_index];
                    if (line_start_byte_offset as usize) >= byte_offset {
                        continue;
                    }

                    let line: u32 = u32::try_from(new_line_index).expect("int cast");
                    min_line = min_line.min(line);
                    max_line = max_line.max(line);
                }

                let did_fn_execute = function.execution_count > 0 || function.has_executed;

                // only mark the lines as executable if the function has not executed
                // functions that have executed have non-executable lines in them and thats fine.
                if !did_fn_execute {
                    let end = max_line.min(line_count);
                    line_hits_slice[min_line as usize..end as usize].fill(0);
                    for line in min_line..end {
                        executable_lines.set(line as usize);
                        lines_which_have_executed.unset(line as usize);
                    }
                }

                if did_fn_execute {
                    functions_which_have_executed.set(functions.len());
                }
                functions.push(ByteRange::of(min, max));
                if ignored_lines.is_some() {
                    let start_line = if self.is_whole_source(min, max) {
                        u32::MAX
                    } else {
                        min_line
                    };
                    function_lines.push((start_line, max_line));
                }
            }
        } else if let Some(parsed_mapping) = parsed_mappings_.as_deref() {
            line_count = (parsed_mapping.input_line_count as u32) + 1;
            ignored_lines = ignored_lines.filter(|lines| has_every_line(lines, line_count));
            executable_lines = Bitset::init_empty(line_count as usize)?;
            lines_which_have_executed = Bitset::init_empty(line_count as usize)?;
            line_hits = vec![0u32; line_count as usize];
            let line_hits_slice = line_hits.as_mut_slice();

            let mut cur_: Option<internal_source_map::Cursor> = parsed_mapping.internal_cursor();

            for block in blocks {
                if block.end_offset < 0 || block.start_offset < 0 {
                    continue; // does not map to anything
                }

                let min: usize =
                    usize::try_from(block.start_offset.min(block.end_offset)).expect("int cast");
                let max: usize =
                    usize::try_from(block.start_offset.max(block.end_offset)).expect("int cast");
                let mut min_line: u32 = u32::MAX;
                let mut max_line: u32 = 0;
                let has_executed = block.has_executed || block.execution_count > 0;

                for byte_offset in min..max {
                    let Some(new_line_index) = LineOffsetTable::find_index(
                        line_starts,
                        Loc {
                            start: i32::try_from(byte_offset).expect("int cast"),
                        },
                    ) else {
                        continue;
                    };
                    let line_start_byte_offset = line_starts[new_line_index];
                    if (line_start_byte_offset as usize) >= byte_offset {
                        continue;
                    }
                    let column_position =
                        byte_offset.saturating_sub(line_start_byte_offset as usize);

                    let found: Option<bun_sourcemap::Mapping> = if let Some(c) = cur_.as_mut() {
                        c.move_to(
                            Ordinal::from_zero_based(
                                i32::try_from(new_line_index).expect("int cast"),
                            ),
                            Ordinal::from_zero_based(
                                i32::try_from(column_position).expect("int cast"),
                            ),
                        )
                    } else {
                        parsed_mapping.find_mapping(
                            Ordinal::from_zero_based(
                                i32::try_from(new_line_index).expect("int cast"),
                            ),
                            Ordinal::from_zero_based(
                                i32::try_from(column_position).expect("int cast"),
                            ),
                        )
                    };
                    if let Some(point) = found.as_ref() {
                        if point.original.lines.zero_based() < 0 {
                            continue;
                        }

                        let line: u32 =
                            u32::try_from(point.original.lines.zero_based()).expect("int cast");
                        if line >= line_count {
                            continue;
                        }

                        executable_lines.set(line as usize);
                        if has_executed {
                            lines_which_have_executed.set(line as usize);
                            line_hits_slice[line as usize] += 1;
                        }

                        min_line = min_line.min(line);
                        max_line = max_line.max(line);
                    }
                }

                if min_line != u32::MAX {
                    if has_executed {
                        stmts_which_have_executed.set(stmts.len());
                    }
                    stmts.push(ByteRange::of(min, max));
                    if ignored_lines.is_some() {
                        stmt_first_lines.push(min_line);
                    }
                }
            }

            for function in function_blocks {
                if function.end_offset < 0 || function.start_offset < 0 {
                    continue; // does not map to anything
                }

                let min: usize = usize::try_from(function.start_offset.min(function.end_offset))
                    .expect("int cast");
                let max: usize = usize::try_from(function.start_offset.max(function.end_offset))
                    .expect("int cast");
                let mut min_line: u32 = u32::MAX;
                let mut max_line: u32 = 0;

                for byte_offset in min..max {
                    let Some(new_line_index) = LineOffsetTable::find_index(
                        line_starts,
                        Loc {
                            start: i32::try_from(byte_offset).expect("int cast"),
                        },
                    ) else {
                        continue;
                    };
                    let line_start_byte_offset = line_starts[new_line_index];
                    if (line_start_byte_offset as usize) >= byte_offset {
                        continue;
                    }

                    let column_position =
                        byte_offset.saturating_sub(line_start_byte_offset as usize);

                    let found: Option<bun_sourcemap::Mapping> = if let Some(c) = cur_.as_mut() {
                        c.move_to(
                            Ordinal::from_zero_based(
                                i32::try_from(new_line_index).expect("int cast"),
                            ),
                            Ordinal::from_zero_based(
                                i32::try_from(column_position).expect("int cast"),
                            ),
                        )
                    } else {
                        parsed_mapping.find_mapping(
                            Ordinal::from_zero_based(
                                i32::try_from(new_line_index).expect("int cast"),
                            ),
                            Ordinal::from_zero_based(
                                i32::try_from(column_position).expect("int cast"),
                            ),
                        )
                    };
                    if let Some(point) = found {
                        if point.original.lines.zero_based() < 0 {
                            continue;
                        }

                        let line: u32 =
                            u32::try_from(point.original.lines.zero_based()).expect("int cast");
                        if line >= line_count {
                            continue;
                        }
                        min_line = min_line.min(line);
                        max_line = max_line.max(line);
                    }
                }

                // no sourcemaps? ignore it
                if min_line == u32::MAX && max_line == 0 {
                    continue;
                }

                let did_fn_execute = function.execution_count > 0 || function.has_executed;

                let mut is_ignored = false;
                if let Some(ignored) = ignored_lines {
                    let start_line = if self.is_whole_source(min, max) {
                        u32::MAX
                    } else {
                        Self::original_start_line(parsed_mapping, line_starts, min)
                            .unwrap_or(u32::MAX)
                    };
                    is_ignored = ignored.is_set_allow_out_of_bound(start_line as usize, false);
                    function_lines.push((start_line, max_line));
                }

                // only mark the lines as executable if the function has not executed
                // functions that have executed have non-executable lines in them and thats fine.
                // `min_line` can be a line above the function, which an ignored
                // function must leave as it is.
                if !did_fn_execute && !is_ignored {
                    let end = max_line.min(line_count);
                    for line in min_line..end {
                        executable_lines.set(line as usize);
                        lines_which_have_executed.unset(line as usize);
                        line_hits_slice[line as usize] = 0;
                    }
                }

                if did_fn_execute {
                    functions_which_have_executed.set(functions.len());
                }
                functions.push(ByteRange::of(min, max));
            }
        } else {
            unreachable!();
        }

        functions_which_have_executed.resize(functions.len(), false)?;
        stmts_which_have_executed.resize(stmts.len(), false)?;

        let mut report = Report {
            source_url: Cow::Borrowed(source_url),
            functions,
            executable_lines,
            lines_which_have_executed,
            line_hits,
            stmts,
            functions_which_have_executed,
            stmts_which_have_executed,
        };
        if let Some(ignored) = ignored_lines {
            report.ignore_lines(ignored, &function_lines, &stmt_first_lines)?;
        }
        Ok(report)
    }

    /// JSC lists the module itself (bytes `0..=len - 1`) and the function Bun
    /// wraps a CommonJS module in (`1..=len - 4`) among the functions of a
    /// source. Neither starts on a line of its own, so a hint never ignores
    /// one of them as a function.
    fn is_whole_source(&self, start: usize, end: usize) -> bool {
        start <= 1 && end + 4 >= self.source_len
    }

    /// The line of the original source that the function whose first token is
    /// at byte `start` of the generated code starts on. `async`, `get`, `set`,
    /// `*` and `[` have no mapping of their own, and on an indented line the
    /// mapping before them repeats the position of the last token of the line
    /// above. So the first mapping at or after `start` is asked first (the
    /// key or the name), and one before it on the line is the fallback.
    fn original_start_line(
        parsed_mapping: &ParsedSourceMap,
        line_starts: &[u32],
        start: usize,
    ) -> Option<u32> {
        const LONGEST_PREFIX: i32 = "export default async function* ".len() as i32;

        let line = line_starts
            .partition_point(|&line_start| line_start as usize <= start)
            .checked_sub(1)?;
        let start_column = i32::try_from(start - line_starts[line] as usize).ok()?;
        let line = Ordinal::from_zero_based(i32::try_from(line).ok()?);
        let mut found: Option<bun_sourcemap::Mapping> = None;
        for column in start_column..start_column.saturating_add(LONGEST_PREFIX) {
            let Some(mapping) = parsed_mapping.find_mapping(line, Ordinal::from_zero_based(column))
            else {
                continue;
            };
            if mapping.generated.columns.zero_based() >= start_column {
                found = Some(mapping);
                break;
            }
            found.get_or_insert(mapping);
        }
        u32::try_from(found?.original.lines.zero_based()).ok()
    }

    pub(crate) fn compute(
        source_contents: &[u8],
        source_id: i32,
        source_url: Utf8Bytes<'static>,
    ) -> ByteRangeMapping {
        ByteRangeMapping {
            line_offset_table: LineOffsetTable::generate(source_contents, 0)
                .unwrap_or_else(|_| bun_alloc::out_of_memory()),
            source_len: source_contents.len(),
            source_id,
            source_url,
        }
    }
}

#[unsafe(no_mangle)]
extern "C" fn ByteRangeMapping__generate(
    str_: &bun_core::String,
    source_contents_str: &bun_core::String,
    source_id: i32,
) {
    // SAFETY: thread_map() returns a pointer into this thread's owned Box<HashMap>;
    // valid for the lifetime of the thread, and we are the only mutable accessor on
    // this thread for the duration of this call.
    let map = unsafe { &mut *thread_map() };

    let source_url = str_.clone().into_utf8();
    let hash = bun_wyhash::hash(source_url.slice());
    let source_contents = source_contents_str.to_utf8();

    let new_value = ByteRangeMapping::compute(source_contents.slice(), source_id, source_url);
    map.insert(hash, new_value);
}

#[unsafe(no_mangle)]
extern "C" fn ByteRangeMapping__getSourceID(this: &ByteRangeMapping) -> i32 {
    this.source_id
}

#[unsafe(no_mangle)]
extern "C" fn ByteRangeMapping__find(path: &bun_core::String) -> Option<NonNull<ByteRangeMapping>> {
    let slice = path.to_utf8();

    let map_ptr = thread_map_opt()?;
    // SAFETY: map_ptr points into this thread's owned Box; valid until thread exit.
    let map = unsafe { &mut *map_ptr.as_ptr() };
    let hash = bun_wyhash::hash(slice.slice());
    let entry = map.get_mut(&hash)?;
    Some(NonNull::from(entry))
}

#[unsafe(no_mangle)]
extern "C" fn ByteRangeMapping__findExecutedLines(
    global_this: &JSGlobalObject,
    source_url: &bun_core::String,
    blocks_ptr: NonNull<BasicBlockRange>,
    blocks_len: usize,
    function_start_offset: usize,
    ignore_sourcemap: bool,
) -> JSValue {
    let Some(this_ptr) = ByteRangeMapping__find(source_url) else {
        return JSValue::NULL;
    };
    // SAFETY: pointer into the thread-local map, valid for this call.
    let this = unsafe { &*this_ptr.as_ptr() };

    // SAFETY: blocks_ptr[0..blocks_len] is a valid contiguous C array from JSC.
    let all = unsafe { core::slice::from_raw_parts(blocks_ptr.as_ptr(), blocks_len) };
    let blocks: &[BasicBlockRange] = &all[0..function_start_offset];
    let mut function_blocks: &[BasicBlockRange] = &all[function_start_offset..blocks_len];
    if function_blocks.len() > 1 {
        function_blocks = &function_blocks[1..];
    }
    let report =
        match this.generate_report_from_blocks(blocks, function_blocks, ignore_sourcemap, None) {
            Ok(r) => r,
            Err(_) => return global_this.throw_out_of_memory_value(),
        };

    let thresholds = Fraction::default();

    // std.Io.Writer.Allocating → Vec<u8> byte buffer (bun_io::Write target).
    let mut buf: Vec<u8> = Vec::new();

    if text::write_format::<false>(
        &report,
        source_url.utf8_byte_length(),
        &report.fraction(&thresholds),
        &thresholds,
        b"",
        &mut buf,
    )
    .is_err()
    {
        return global_this.throw_out_of_memory_value();
    }

    // flush is a no-op for Vec<u8> writer.

    let Ok(v) = bun_string_jsc::create_utf8_for_js(global_this, &buf) else {
        return JSValue::ZERO;
    };
    v
}

// move-out: TYPE_ONLY → bun_options_types::code_coverage_options::Fraction.
// Lifted into options_types so the CLI tier can hold `CodeCoverageOptions.fractions`
// without depending on tier-6 sourcemap_jsc; re-exported here so coverage report
// writers and the test runner share one definition.
pub use bun_options_types::code_coverage_options::Fraction;

/// A basic block or function body as `[start, end)` byte offsets into the
/// generated source. Offsets are what JSC reports, so they identify the same
/// block across processes that loaded the same file.
#[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct ByteRange {
    pub start: u32,
    pub end: u32,
}

impl ByteRange {
    fn of(min: usize, max: usize) -> ByteRange {
        ByteRange {
            start: u32::try_from(min).expect("int cast"),
            end: u32::try_from(max).expect("int cast"),
        }
    }
}
