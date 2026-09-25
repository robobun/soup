//! Loads a `bun.lock` that git left conflict markers in.
//!
//! `Lockfile::load_from_dir` comes here from its parse-error arm only, so a
//! lockfile that parses never pays for any of this. The steps:
//!
//! 1. Split the text into the two documents git merged: the lines outside the
//!    hunks plus one side's lines.
//! 2. Parse both and write one union document. A row is taken whole from one
//!    side. When both sides put a different package at one path, the higher
//!    version keeps the path, and what is below the path is taken from the
//!    side that keeps it. The other row and what that side has below it move
//!    below [`OURS_PREFIX`] or [`THEIRS_PREFIX`], where no dependency name can
//!    reach them by path.
//! 3. Load the union with [`LoadMode::Recover`], which leaves a required
//!    dependency without a row unbound where the strict loader fails.
//! 4. Check every edge against its range and point the ones that fail at a
//!    package of the merged graph that fits. What is left is an open edge.
//! 5. [`Purpose::Read`]: print the graph and load that text strictly, so the
//!    caller sees exactly what loading the saved file gives.
//!    [`Purpose::Install`]: keep the graph with the packages that lost their
//!    path. `bun install` compares it with package.json first.

use core::cmp::Ordering;
use core::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::io::Write as _;

use bun_ast::e::{JsonValue, ObjectJSON, PropertyJSON};
use bun_ast::expr::Data as ExprData;
use bun_collections::{DynamicBitSet, HashMap, StringHashMap};
use bun_core::{UnwrapOrOom as _, strings, zstr};
use bun_install_types::DependencyVersionTag;
use bun_semver::{self as Semver, SlicedString};

use super::bun_lock::{self as TextLockfile, LoadMode};
use super::package::PackageColumns as _;
use super::{LoadResult, LoadResultErr, LoadStep, Lockfile, LockfileFormat, reachable};
use crate::bun_json as JSON;
use crate::dependency::{
    self, Dependency, DependencyExt as _, TagExt as _, Version as DependencyVersion,
};
use crate::package_manager_real::follows_npm_alias;
use crate::package_manager_real::options::LogLevel;
use crate::resolution::Tag as ResolutionTag;
use crate::{
    DependencyID, PackageID, PackageManager, PackageNameHash, initialize_store, invalid_package_id,
};

bun_core::declare_scope!(lockfile_merge, hidden);

/// A `:` is not valid in a dependency name (`is_safe_install_folder_name`),
/// so the upward path walk of the loader never builds a key below these.
const OURS_PREFIX: &[u8] = b":ours/";
const THEIRS_PREFIX: &[u8] = b":theirs/";

/// A lockfile nests five levels. The writers of the union recurse once per level.
const DEEPEST: usize = 64;

/// Why a conflicted lockfile is left to the parse error of the caller.
enum Declined {
    /// The sides do not merge, with the path or the package that says so.
    Unmergeable(&'static str, Option<Box<[u8]>>),
    /// The merge has a dependency that only `bun install` can resolve.
    NeedsInstall,
}

impl Declined {
    fn at(reason: &'static str, subject: &[u8]) -> Declined {
        Declined::Unmergeable(reason, Some(Box::from(subject)))
    }
}

impl From<&'static str> for Declined {
    fn from(reason: &'static str) -> Declined {
        Declined::Unmergeable(reason, None)
    }
}

/// What the caller does with the lockfile.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// It reads the lockfile, so the merge has to be complete.
    Read,
    /// `bun install`: it compares the lockfile with package.json and resolves what is open.
    Install,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Region {
    Outside,
    Ours,
    Base,
    Theirs,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Marker {
    Start,
    Base,
    Separator,
    End,
}

/// `<<<<<<< label`, `||||||| label`, `=======` or `>>>>>>> label` at column 0, with the length of its run.
/// git pads to `conflict-marker-size`, so any run of 7 or more counts.
fn marker_of(line: &[u8]) -> Option<(Marker, usize)> {
    let first = *line.first()?;
    let marker = match first {
        b'<' => Marker::Start,
        b'|' => Marker::Base,
        b'=' => Marker::Separator,
        b'>' => Marker::End,
        _ => return None,
    };
    let mut run = 1;
    while run < line.len() && line[run] == first {
        run += 1;
    }
    if run < 7 {
        return None;
    }
    match line.get(run) {
        None => Some((marker, run)),
        Some(b' ') if marker != Marker::Separator => Some((marker, run)),
        _ => None,
    }
}

pub(crate) fn has_marker(text: &[u8]) -> bool {
    text.starts_with(b"<<<<<<<") || strings::contains(text, b"\n<<<<<<<")
}

struct Sides {
    ours: Vec<u8>,
    theirs: Vec<u8>,
}

/// `None` for a stray, nested or unterminated marker.
fn split_sides(text: &[u8]) -> Option<Sides> {
    let mut sides = Sides {
        ours: Vec::with_capacity(text.len()),
        theirs: Vec::with_capacity(text.len()),
    };
    let mut region = Region::Outside;
    // The run of the marker that opened the hunk.
    let mut size = 0usize;
    let mut hunks = 0usize;
    let mut rest = text;
    while !rest.is_empty() {
        let line = match strings::index_of_char_usize(rest, b'\n') {
            Some(newline) => &rest[..=newline],
            None => rest,
        };
        rest = &rest[line.len()..];
        let mut content = line;
        if let [head @ .., b'\n'] = content {
            content = head;
        }
        if let [head @ .., b'\r'] = content {
            content = head;
        }
        // The base of a merge with two ancestors holds the markers of the merge of those, which git makes longer.
        let marker = marker_of(content)
            .filter(|&(_, run)| region == Region::Outside || run == size)
            .map(|(marker, run)| {
                size = run;
                marker
            });
        match (marker, region) {
            (Some(Marker::Start), Region::Outside) => {
                region = Region::Ours;
                hunks += 1;
            }
            (Some(Marker::Base), Region::Ours) => region = Region::Base,
            (Some(Marker::Separator), Region::Ours | Region::Base) => region = Region::Theirs,
            (Some(Marker::End), Region::Theirs) => region = Region::Outside,
            (Some(_), _) => return None,
            (None, Region::Outside) => {
                sides.ours.extend_from_slice(line);
                sides.theirs.extend_from_slice(line);
            }
            (None, Region::Ours) => sides.ours.extend_from_slice(line),
            (None, Region::Base) => {}
            (None, Region::Theirs) => sides.theirs.extend_from_slice(line),
        }
    }
    (region == Region::Outside && hunks > 0).then_some(sides)
}

/// The JSON parser stops at the end of the stack, which is deeper than the writers below can follow.
fn nests_deeper_than(value: &JsonValue, levels: usize) -> bool {
    let Some(levels) = levels.checked_sub(1) else {
        return true;
    };
    match value {
        JsonValue::Object(object) => object
            .get()
            .properties()
            .iter()
            .any(|property| nests_deeper_than(&property.value, levels)),
        JsonValue::Array(array) => array
            .get()
            .items()
            .iter()
            .any(|item| nests_deeper_than(item, levels)),
        _ => false,
    }
}

fn write_string(out: &mut Vec<u8>, bytes: &[u8]) {
    let _ = write!(
        out,
        "{}",
        bun_core::fmt::format_json_string_utf8(bytes, Default::default())
    );
}

fn write_value(out: &mut Vec<u8>, value: &JsonValue) {
    match value {
        JsonValue::Null => out.extend_from_slice(b"null"),
        JsonValue::Boolean(true) => out.extend_from_slice(b"true"),
        JsonValue::Boolean(false) => out.extend_from_slice(b"false"),
        JsonValue::Number(number) => {
            let _ = write!(out, "{}", number.value());
        }
        JsonValue::String(string) => write_string(out, string.slice()),
        JsonValue::Object(object) => {
            out.push(b'{');
            for (i, property) in object.get().properties().iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(out, property.key.slice());
                out.push(b':');
                write_value(out, &property.value);
            }
            out.push(b'}');
        }
        JsonValue::Array(array) => {
            out.push(b'[');
            for (i, item) in array.get().items().iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item);
            }
            out.push(b']');
        }
    }
}

fn canonical(value: &JsonValue) -> Vec<u8> {
    let mut out = Vec::new();
    write_value(&mut out, value);
    out
}

/// Objects are merged key by key and arrays item by item. Anything else, and
/// any pair of different kinds, is ours.
fn write_merged(out: &mut Vec<u8>, ours: &JsonValue, theirs: &JsonValue) {
    match (ours, theirs) {
        (JsonValue::Object(ours), JsonValue::Object(theirs)) => {
            let (ours, theirs) = (ours.get(), theirs.get());
            out.push(b'{');
            let mut first = true;
            // A side can hold a key twice: once from its hunk and once from the lines git merged.
            let mut written: StringHashMap<()> = StringHashMap::default();
            for (property, side) in both(ours.properties(), theirs.properties()) {
                let key = property.key.slice();
                if written.contains_key(key) {
                    continue;
                }
                written.put(key, ()).unwrap_or_oom();
                write_separator(out, &mut first);
                write_string(out, key);
                out.push(b':');
                match theirs.get(key) {
                    Some(other) if side == Side::Ours => write_merged(out, &property.value, other),
                    _ => write_value(out, &property.value),
                }
            }
            out.push(b'}');
        }
        (JsonValue::Array(ours), JsonValue::Array(theirs)) => {
            out.push(b'[');
            let mut first = true;
            let mut seen: HashMap<Vec<u8>, ()> = HashMap::default();
            for item in ours.get().items().iter().chain(theirs.get().items()) {
                let text = canonical(item);
                if seen.contains_key(&text) {
                    continue;
                }
                write_separator(out, &mut first);
                out.extend_from_slice(&text);
                seen.insert(text, ());
            }
            out.push(b']');
        }
        _ => write_value(out, ours),
    }
}

fn write_separator(out: &mut Vec<u8>, first: &mut bool) {
    if !*first {
        out.push(b',');
    }
    *first = false;
}

fn number_of(object: &ObjectJSON, key: &[u8]) -> Option<f64> {
    match object.get(key)? {
        JsonValue::Number(number) => Some(number.value()),
        _ => None,
    }
}

fn pick(ours: Option<f64>, theirs: Option<f64>, higher: bool) -> Option<f64> {
    match (ours, theirs) {
        (Some(ours), Some(theirs)) => Some(if higher {
            ours.max(theirs)
        } else {
            ours.min(theirs)
        }),
        (ours, theirs) => ours.or(theirs),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Ours = 0,
    Theirs = 1,
}

const SIDES: [Side; 2] = [Side::Ours, Side::Theirs];

/// Both sides in the order the union is written in: ours, then what only theirs has.
fn both<'a, T>(ours: &'a [T], theirs: &'a [T]) -> impl Iterator<Item = (&'a T, Side)> {
    ours.iter()
        .map(|item| (item, Side::Ours))
        .chain(theirs.iter().map(|item| (item, Side::Theirs)))
}

fn properties_of<'a>(value: Option<&'a JsonValue>) -> Option<&'a [PropertyJSON]> {
    match value {
        None => Some(&[]),
        Some(JsonValue::Object(object)) => Some(object.get().properties()),
        Some(_) => None,
    }
}

const NOT_A_LOCKFILE: &str = "one side is not a lockfile";

struct Workspace<'a> {
    path: &'a [u8],
    name: Option<&'a [u8]>,
    ours: &'a JsonValue,
    theirs: Option<&'a JsonValue>,
}

#[derive(Default)]
struct Workspaces<'a> {
    list: Vec<Workspace<'a>>,
    paths: StringHashMap<()>,
    /// The loader registers every workspace but the root at its name.
    names: StringHashMap<()>,
}

impl<'a> Workspaces<'a> {
    /// One workspace name at two paths fails the load, so the second path is left out.
    fn collect(
        ours: Option<&'a JsonValue>,
        theirs: Option<&'a JsonValue>,
    ) -> Result<Workspaces<'a>, Declined> {
        let (ours_rows, theirs_rows) = (
            properties_of(ours).ok_or(NOT_A_LOCKFILE)?,
            properties_of(theirs).ok_or(NOT_A_LOCKFILE)?,
        );
        let theirs_object = theirs.and_then(JsonValue::as_object);
        let mut workspaces = Workspaces::default();
        for (row, side) in both(ours_rows, theirs_rows) {
            let path = row.key.slice();
            if workspaces.paths.contains_key(path) {
                continue;
            }
            let name = row
                .value
                .as_object()
                .and_then(|object| object.get(b"name"))
                .and_then(JsonValue::as_str)
                .filter(|_| !path.is_empty());
            if let Some(name) = name {
                if workspaces.names.contains_key(name) {
                    continue;
                }
                workspaces.names.put(name, ()).unwrap_or_oom();
            }
            workspaces.paths.put(path, ()).unwrap_or_oom();
            workspaces.list.push(Workspace {
                path,
                name,
                ours: &row.value,
                theirs: theirs_object
                    .and_then(|object| object.get(path))
                    .filter(|_| side == Side::Ours),
            });
        }
        Ok(workspaces)
    }

    fn write(&self, out: &mut Vec<u8>, packages: &Packages<'a>) {
        out.push(b'{');
        let mut first = true;
        for workspace in &self.list {
            write_separator(out, &mut first);
            write_string(out, workspace.path);
            out.push(b':');
            match (workspace.ours, workspace.theirs) {
                (JsonValue::Object(ours), Some(JsonValue::Object(theirs))) => {
                    workspace.write(out, ours.get(), theirs.get(), packages)
                }
                (ours, _) => write_value(out, ours),
            }
        }
        out.push(b'}');
    }
}

const DEPENDENCY_GROUPS: [&[u8]; 4] = [
    b"dependencies",
    b"devDependencies",
    b"optionalDependencies",
    b"peerDependencies",
];

/// The first groups of [`DEPENDENCY_GROUPS`] are the ones whose rows get a folder. A peer goes where another row put the package.
const PLACED_GROUPS: usize = 3;

/// The row of one side that the union leaves out.
struct LeftOut<'a> {
    name: &'a [u8],
    group: usize,
    side: Side,
}

impl<'a> Workspace<'a> {
    fn write(
        &self,
        out: &mut Vec<u8>,
        ours: &'a ObjectJSON,
        theirs: &'a ObjectJSON,
        packages: &Packages<'a>,
    ) {
        let left_out = self.left_out(ours, theirs, packages);
        out.push(b'{');
        let mut first = true;
        let mut written: StringHashMap<()> = StringHashMap::default();
        for (property, side) in both(ours.properties(), theirs.properties()) {
            let key = property.key.slice();
            if written.contains_key(key) {
                continue;
            }
            written.put(key, ()).unwrap_or_oom();
            write_separator(out, &mut first);
            write_string(out, key);
            out.push(b':');
            let (ours_value, theirs_value) = match side {
                Side::Ours => (Some(&property.value), theirs.get(key)),
                Side::Theirs => (None, Some(&property.value)),
            };
            let group = DEPENDENCY_GROUPS.iter().position(|group| *group == key);
            match (
                group,
                properties_of(ours_value),
                properties_of(theirs_value),
            ) {
                (Some(group), Some(ours_rows), Some(theirs_rows)) => {
                    self.write_dependencies(out, group, ours_rows, theirs_rows, &left_out, packages)
                }
                _ => match theirs_value.filter(|_| side == Side::Ours) {
                    Some(theirs_value) => write_merged(out, &property.value, theirs_value),
                    None => write_value(out, &property.value),
                },
            }
        }
        out.push(b'}');
    }

    /// When the sides ask for two ranges, the range that takes the package at
    /// the path is kept. The package.json decides later, and the pin stays
    /// when its range takes the package too.
    fn keeps_theirs(
        &self,
        name: &[u8],
        ours: &[u8],
        theirs: &[u8],
        packages: &Packages<'a>,
    ) -> bool {
        let package = packages.at(self.name, name);
        let takes = |range: &[u8]| package.is_some_and(|row| row.satisfies(range));
        !takes(ours) && takes(theirs)
    }

    /// A dependency that the sides have in two groups would be two rows of one
    /// folder, and the row that fits the package would speak for the other.
    fn left_out(
        &self,
        ours: &'a ObjectJSON,
        theirs: &'a ObjectJSON,
        packages: &Packages<'a>,
    ) -> Vec<LeftOut<'a>> {
        let range_in = |side: &'a ObjectJSON, group: usize, name: &[u8]| -> Option<&'a [u8]> {
            side.get(DEPENDENCY_GROUPS[group])?
                .as_object()?
                .get(name)?
                .as_str()
        };
        let mut left_out = Vec::new();
        for group in 0..PLACED_GROUPS {
            let rows = properties_of(ours.get(DEPENDENCY_GROUPS[group])).unwrap_or_default();
            for row in rows {
                let name = row.key.slice();
                let Some(ours_range) = row.value.as_str() else {
                    continue;
                };
                let mut declared =
                    (0..PLACED_GROUPS).filter(|&other| range_in(theirs, other, name).is_some());
                let (Some(theirs_group), None) = (declared.next(), declared.next()) else {
                    continue;
                };
                if theirs_group == group
                    || (0..PLACED_GROUPS)
                        .any(|other| other != group && range_in(ours, other, name).is_some())
                {
                    continue;
                }
                let Some(theirs_range) = range_in(theirs, theirs_group, name) else {
                    continue;
                };
                left_out.push(
                    if self.keeps_theirs(name, ours_range, theirs_range, packages) {
                        LeftOut {
                            name,
                            group,
                            side: Side::Ours,
                        }
                    } else {
                        LeftOut {
                            name,
                            group: theirs_group,
                            side: Side::Theirs,
                        }
                    },
                );
            }
        }
        left_out
    }

    fn write_dependencies(
        &self,
        out: &mut Vec<u8>,
        group: usize,
        ours: &[PropertyJSON],
        theirs: &[PropertyJSON],
        left_out: &[LeftOut<'a>],
        packages: &Packages<'a>,
    ) {
        out.push(b'{');
        let mut first = true;
        let mut written: StringHashMap<()> = StringHashMap::default();
        for (property, side) in both(ours, theirs) {
            let name = property.key.slice();
            if written.contains_key(name)
                || left_out
                    .iter()
                    .any(|row| row.group == group && row.side == side && row.name == name)
            {
                continue;
            }
            written.put(name, ()).unwrap_or_oom();
            write_separator(out, &mut first);
            write_string(out, name);
            out.push(b':');
            let other = theirs
                .iter()
                .find(|row| side == Side::Ours && row.key.slice() == name);
            match (&property.value, other.map(|row| &row.value)) {
                (JsonValue::String(ours), Some(JsonValue::String(theirs)))
                    if ours.slice() != theirs.slice() =>
                {
                    write_string(
                        out,
                        if self.keeps_theirs(name, ours.slice(), theirs.slice(), packages) {
                            theirs.slice()
                        } else {
                            ours.slice()
                        },
                    );
                }
                (value, _) => write_value(out, value),
            }
        }
        out.push(b'}');
    }
}

struct Row<'a> {
    text: Vec<u8>,
    /// `name@resolution`
    id: &'a [u8],
    name: &'a [u8],
    resolution: &'a [u8],
    /// `Some` for an npm row.
    version: Option<Semver::Version>,
    workspace: bool,
}

impl<'a> Row<'a> {
    fn parse(value: &'a JsonValue) -> Option<Row<'a>> {
        let items = value.as_array()?.items();
        let id = items.first()?.as_str()?;
        let (name, resolution) = if strings::has_prefix_comptime(id, b"@root:") {
            (&id[..0], &id[1..])
        } else {
            dependency::split_name_and_version(id).ok()?
        };
        // `name@1.2.3` followed by the tarball. Every other kind of row starts its resolution with a protocol or a path.
        let version = if resolution.first().is_some_and(u8::is_ascii_digit)
            && items.get(1).is_some_and(|item| item.as_str().is_some())
        {
            let parsed = Semver::Version::parse_utf8(resolution);
            (parsed.valid && parsed.len as usize == resolution.len()).then(|| parsed.version.min())
        } else {
            None
        };
        Some(Row {
            text: canonical(value),
            id,
            name,
            resolution,
            version,
            workspace: strings::has_prefix_comptime(resolution, b"workspace:"),
        })
    }

    fn workspace_path(&self) -> &'a [u8] {
        &self.resolution[b"workspace:".len()..]
    }

    /// What has to be the same wherever one package is listed: the row without the package's
    /// name and without what its package.json says. That leaves where it comes from and its hash.
    fn source(value: &JsonValue) -> Vec<u8> {
        let mut source = Vec::new();
        let items = value.as_array().map(|array| array.items());
        for item in items.unwrap_or_default().iter().skip(1) {
            if !matches!(item, JsonValue::Object(_)) {
                write_value(&mut source, item);
                source.push(b',');
            }
        }
        source
    }

    fn satisfies(&self, range: &[u8]) -> bool {
        let Some(version) = self.version else {
            return false;
        };
        if strings::contains_char(range, b':')
            || (!range.is_empty()
                && dependency::VersionTag::infer(range) != DependencyVersionTag::Npm)
        {
            return false;
        }
        Semver::query::parse(range, SlicedString::init(range, range))
            .is_ok_and(|group| group.satisfies(version, range, self.resolution))
    }
}

#[derive(Default)]
struct Counters {
    rekeyed: u32,
    folded: u32,
    dropped: u32,
}

/// The path that `key` is below: `a/@b/c` for `a/@b/c/d` and for `a/@b/c/@d/e`.
fn parent_of(key: &[u8]) -> Option<&[u8]> {
    let slash = strings::last_index_of_char(key, b'/')?;
    let above = &key[..slash];
    // The `/` of a scoped name is not a step of the path.
    let last = strings::last_index_of_char(above, b'/').map_or(0, |slash| slash + 1);
    if above[last..].first() == Some(&b'@') {
        return last.checked_sub(1).map(|end| &key[..end]);
    }
    Some(above)
}

/// One key of "packages" and the row each document has for it.
struct PackagePath<'a> {
    key: &'a [u8],
    /// The packages that the documents list at `key`, each with the documents that list it, by [`Side`].
    listed: Vec<(Row<'a>, [bool; 2])>,
    /// By [`Side`]: the row of the document, as an index of `listed`.
    rows: [Option<usize>; 2],
    /// By [`Side`]: the rows of the document keep every path above `key`, so its row can keep `key`.
    fills: [bool; 2],
    /// The document whose row keeps `key`.
    keeps: Option<Side>,
}

impl<'a> PackagePath<'a> {
    fn list(&mut self, row: Row<'a>, side: Side) -> bool {
        match self.listed.iter_mut().find(|(known, _)| known.id == row.id) {
            // One package, and its source is the same: the rows say the same.
            Some((_, by)) => {
                by[side as usize] = true;
                false
            }
            None => {
                let mut by = [false; 2];
                by[side as usize] = true;
                self.listed.push((row, by));
                true
            }
        }
    }

    /// A document is the lines outside the hunks and the lines of its side. Where a side has a
    /// row in a hunk and git took the row of the other side for the same key outside of it, the
    /// document has two rows. Its own is the one that the other document does not have.
    fn assign(&mut self) -> Result<(), Declined> {
        const TWO_ROWS: &str = "one side has two packages at one path";
        for side in SIDES {
            let (side, other) = (side as usize, 1 - side as usize);
            let mut own = (0..self.listed.len()).filter(|&at| {
                let (_, by) = &self.listed[at];
                by[side] && !by[other]
            });
            self.rows[side] = match (own.next(), own.next()) {
                (Some(at), None) => Some(at),
                (None, _) => self.listed.iter().position(|(_, by)| by[side]),
                (Some(_), Some(_)) => return Err(Declined::at(TWO_ROWS, self.key)),
            };
        }
        if (0..self.listed.len()).any(|at| !self.rows.contains(&Some(at))) {
            return Err(Declined::at(TWO_ROWS, self.key));
        }
        Ok(())
    }

    fn row_of(&self, side: Side) -> Option<&Row<'a>> {
        Some(&self.listed[self.rows[side as usize]?].0)
    }

    /// Both documents have the same row here.
    fn common(&self) -> bool {
        self.rows[0].is_some() && self.rows[0] == self.rows[1]
    }

    fn kept(&self) -> Option<&Row<'a>> {
        self.row_of(self.keeps?)
    }

    /// Whether the row of this document is the row at `key`.
    fn is_kept(&self, side: Side) -> bool {
        self.fills[side as usize] && self.keeps.is_some_and(|kept| kept == side || self.common())
    }

    fn decide(&self, workspaces: &Workspaces<'a>) -> Result<Option<Side>, Declined> {
        let candidate = |side: Side| self.row_of(side).filter(|_| self.fills[side as usize]);
        // The loader puts the workspace at this path.
        if workspaces.names.contains_key(self.key) {
            return Ok(SIDES
                .into_iter()
                .find(|&side| candidate(side).is_some_and(|row| row.workspace)));
        }
        Ok(match (candidate(Side::Ours), candidate(Side::Theirs)) {
            (None, None) => None,
            (Some(_), None) => Some(Side::Ours),
            (None, Some(_)) => Some(Side::Theirs),
            (Some(_), Some(_)) if self.common() => Some(Side::Ours),
            (Some(ours), Some(theirs)) => match (ours.version, theirs.version) {
                (Some(ours_version), Some(theirs_version)) => {
                    let later = ours.name == theirs.name
                        && theirs_version.order(ours_version, theirs.resolution, ours.resolution)
                            == Ordering::Greater;
                    Some(if later { Side::Theirs } else { Side::Ours })
                }
                // A tarball, a repository or a folder has no version that says which one is later.
                _ => {
                    return Err(Declined::at(
                        "the sides have two packages at one path, and one of them is not from the registry",
                        self.key,
                    ));
                }
            },
        })
    }
}

/// A package that lost its path to another version of itself.
struct Spare {
    kept: Box<[u8]>,
    lost: Box<[u8]>,
}

#[derive(Default)]
struct Packages<'a> {
    paths: Vec<PackagePath<'a>>,
    index: StringHashMap<usize>,
}

impl<'a> Packages<'a> {
    fn collect(
        ours: Option<&'a JsonValue>,
        theirs: Option<&'a JsonValue>,
        workspaces: &Workspaces<'a>,
        counters: &mut Counters,
    ) -> Result<Packages<'a>, Declined> {
        let mut packages = Packages::default();
        let mut sources: StringHashMap<Vec<u8>> = StringHashMap::default();

        let documents = [
            properties_of(ours).ok_or(NOT_A_LOCKFILE)?,
            properties_of(theirs).ok_or(NOT_A_LOCKFILE)?,
        ];
        for side in SIDES {
            for property in documents[side as usize] {
                let key = property.key.slice();
                let row = Row::parse(&property.value).ok_or(NOT_A_LOCKFILE)?;
                if row.workspace {
                    if !workspaces.paths.contains_key(row.workspace_path()) {
                        counters.dropped += 1;
                        continue;
                    }
                } else {
                    let source = Row::source(&property.value);
                    match sources.get(row.id) {
                        // Which side is right is not for bun to say.
                        Some(known) if *known != source => {
                            return Err(Declined::at(
                                "one package has two tarballs or two integrity hashes",
                                row.id,
                            ));
                        }
                        Some(_) => {}
                        None => sources.put(row.id, source).unwrap_or_oom(),
                    }
                }
                let at = match packages.index.get(key) {
                    Some(&at) => at,
                    None => {
                        packages
                            .index
                            .put(key, packages.paths.len())
                            .unwrap_or_oom();
                        packages.paths.push(PackagePath {
                            key,
                            listed: Vec::new(),
                            rows: [None; 2],
                            fills: [true; 2],
                            keeps: None,
                        });
                        packages.paths.len() - 1
                    }
                };
                if !packages.paths[at].list(row, side) {
                    counters.folded += 1;
                }
            }
        }

        // A path is shorter than every path below it.
        let mut order: Vec<usize> = (0..packages.paths.len()).collect();
        order.sort_by_key(|&at| packages.paths[at].key.len());
        for at in order {
            packages.paths[at].assign()?;
            let above = parent_of(packages.paths[at].key)
                .and_then(|parent| packages.index.get(parent).copied());
            let fills = match above {
                Some(parent) => SIDES.map(|side| packages.paths[parent].is_kept(side)),
                None => [true; 2],
            };
            let path = &mut packages.paths[at];
            path.fills = fills;
            path.keeps = path.decide(workspaces)?;
        }
        Ok(packages)
    }

    /// The row the loader binds a dependency of a workspace to.
    fn at(&self, workspace: Option<&[u8]>, name: &[u8]) -> Option<&Row<'a>> {
        let kept = |key: &[u8]| self.paths[*self.index.get(key)?].kept();
        workspace
            .and_then(|workspace| kept(&[workspace, b"/", name].concat()))
            .or_else(|| kept(name))
    }

    /// A row that does not keep its path moves below the prefix of its side,
    /// and so does every row that its side has below that path.
    fn write(&self, out: &mut Vec<u8>, counters: &mut Counters) {
        let mut kept: Vec<u8> = Vec::new();
        let mut first_kept = true;
        let mut first_moved = true;
        out.push(b'{');
        for path in &self.paths {
            for side in SIDES {
                // The workspace itself is at this path.
                let moved = path
                    .row_of(side)
                    .filter(|row| !row.workspace && !path.is_kept(side));
                let Some(row) = moved else {
                    continue;
                };
                counters.rekeyed += 1;
                write_separator(out, &mut first_moved);
                let prefix = match side {
                    Side::Ours => OURS_PREFIX,
                    Side::Theirs => THEIRS_PREFIX,
                };
                write_string(out, &[prefix, path.key].concat());
                out.push(b':');
                out.extend_from_slice(&row.text);
            }
            if let Some(row) = path.kept() {
                write_separator(&mut kept, &mut first_kept);
                write_string(&mut kept, path.key);
                kept.push(b':');
                kept.extend_from_slice(&row.text);
            }
        }
        // The loader binds the edges of a package from the last of its rows, so the rows at real paths go last.
        if !first_kept {
            if !first_moved {
                out.push(b',');
            }
            out.extend_from_slice(&kept);
        }
        out.push(b'}');
    }

    fn spares(&self) -> Vec<Spare> {
        let mut spares = Vec::new();
        for path in &self.paths {
            let Some(kept) = path.kept().filter(|row| row.version.is_some()) else {
                continue;
            };
            for side in SIDES {
                let lost = path.row_of(side).filter(|row| {
                    !path.is_kept(side)
                        && row.version.is_some()
                        && row.name == kept.name
                        && row.id != kept.id
                });
                if let Some(row) = lost {
                    spares.push(Spare {
                        kept: Box::from(kept.id),
                        lost: Box::from(row.id),
                    });
                }
            }
        }
        spares
    }
}

struct Union {
    /// Everything after `{"lockfileVersion":N,`.
    rest: Vec<u8>,
    /// The higher `lockfileVersion` first. A later version rejects rows that an earlier one takes.
    versions: [Option<f64>; 2],
    spares: Vec<Spare>,
    counters: Counters,
}

impl Union {
    fn text(&self, version: f64) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.rest.len() + 32);
        let _ = write!(out, "{{\"lockfileVersion\":{version},");
        out.extend_from_slice(&self.rest);
        out
    }
}

fn root_object(parsed: &JSON::ParsedJson) -> Result<&ObjectJSON, Declined> {
    match &parsed.root.data {
        ExprData::EObjectJSON(object)
            if !object
                .get()
                .properties()
                .iter()
                .any(|property| nests_deeper_than(&property.value, DEEPEST)) =>
        {
            Ok(object.get())
        }
        _ => Err(NOT_A_LOCKFILE.into()),
    }
}

/// A `lockfileVersion` that the loader of this build reads.
fn lockfile_version_of(side: &ObjectJSON) -> Result<Option<f64>, Declined> {
    match side.get(b"lockfileVersion") {
        None => Ok(None),
        Some(JsonValue::Number(number))
            if number.value().fract() == 0.0
                && (0.0..=f64::from(u32::MAX)).contains(&number.value())
                && TextLockfile::Version::from_int(number.value() as u32).is_some() =>
        {
            Ok(Some(number.value()))
        }
        Some(_) => {
            Err("one side has a lockfileVersion that this version of bun does not read".into())
        }
    }
}

fn build_union(ours: &ObjectJSON, theirs: &ObjectJSON) -> Result<Union, Declined> {
    let mut out = Vec::new();
    let mut counters = Counters::default();

    let (ours_version, theirs_version) = (lockfile_version_of(ours)?, lockfile_version_of(theirs)?);
    let workspaces = Workspaces::collect(ours.get(b"workspaces"), theirs.get(b"workspaces"))?;
    let packages = Packages::collect(
        ours.get(b"packages"),
        theirs.get(b"packages"),
        &workspaces,
        &mut counters,
    )?;

    if let Some(version) = pick(
        number_of(ours, b"configVersion"),
        number_of(theirs, b"configVersion"),
        true,
    ) {
        let _ = write!(out, "\"configVersion\":{version},");
    }

    out.extend_from_slice(b"\"workspaces\":");
    workspaces.write(&mut out, &packages);

    let mut written: StringHashMap<()> = StringHashMap::default();
    for (property, side) in both(ours.properties(), theirs.properties()) {
        let key = property.key.slice();
        if matches!(
            key,
            b"lockfileVersion" | b"configVersion" | b"workspaces" | b"packages"
        ) || written.contains_key(key)
        {
            continue;
        }
        written.put(key, ()).unwrap_or_oom();
        out.push(b',');
        write_string(&mut out, key);
        out.push(b':');
        match theirs.get(key) {
            Some(other) if side == Side::Ours => write_merged(&mut out, &property.value, other),
            _ => write_value(&mut out, &property.value),
        }
    }

    out.extend_from_slice(b",\"packages\":");
    packages.write(&mut out, &mut counters);
    out.extend_from_slice(b"}\n");

    let higher = pick(ours_version, theirs_version, true);
    let lower = pick(ours_version, theirs_version, false);
    Ok(Union {
        rest: out,
        versions: [higher, lower.filter(|_| lower != higher)],
        spares: packages.spares(),
        counters,
    })
}

fn parse_union(text: &[u8]) -> Result<Union, Declined> {
    const NOT_JSON: &str = "one side is not JSON";
    let sides = split_sides(text).ok_or("the markers do not pair up")?;
    let mut log = bun_ast::Log::init();
    let ours_source = bun_ast::Source::init_path_string(b"bun.lock", sides.ours.as_slice());
    let theirs_source = bun_ast::Source::init_path_string(b"bun.lock", sides.theirs.as_slice());
    initialize_store();
    let ours =
        JSON::ParsedJson::parse_package_json(&ours_source, &mut log).map_err(|_| NOT_JSON)?;
    let theirs =
        JSON::ParsedJson::parse_package_json(&theirs_source, &mut log).map_err(|_| NOT_JSON)?;
    build_union(root_object(&ours)?, root_object(&theirs)?)
}

/// The errors go to a log of their own: their lines are lines of a text that is on no disk.
fn load(
    lockfile: &mut Lockfile,
    text: &[u8],
    manager: &mut PackageManager,
    mode: LoadMode,
) -> Option<()> {
    let mut log = bun_ast::Log::init();
    let source = bun_ast::Source::init_path_string(b"bun.lock", text);
    initialize_store();
    let loaded = JSON::ParsedJson::parse_package_json(&source, &mut log)
        .ok()
        .and_then(|parsed| {
            TextLockfile::parse_into_binary_lockfile(
                lockfile,
                parsed.root,
                &source,
                &mut log,
                Some(manager),
                mode,
            )
            .ok()
        });
    if loaded.is_none() {
        for msg in &log.msgs {
            bun_core::scoped_log!(lockfile_merge, "{}", bstr::BStr::new(&msg.data.text));
        }
    }
    loaded
}

/// The range of an edge that a version can answer, after overrides and catalogs.
fn range_of(
    lockfile: &Lockfile,
    dep_id: DependencyID,
    dep: &Dependency,
) -> Option<DependencyVersion> {
    // A bundled package comes with its parent. A peer is bound by version when the lockfile loads.
    if dep.behavior.is_bundled() || dep.behavior.is_peer() {
        return None;
    }
    // `alias: npm:name@tag`: the resolver looks for its override under `name`, and
    // `effective_npm_range` under `alias`.
    if dep.version.tag != DependencyVersionTag::Npm
        && lockfile.str(&dep.realname()) != lockfile.str(&dep.name)
    {
        return None;
    }
    crate::dedupe::effective_npm_range(lockfile, dep_id, dep)
}

fn takes(lockfile: &Lockfile, range: &DependencyVersion, package: PackageID) -> bool {
    let resolution = &lockfile.packages.items_resolution()[package as usize];
    let buf = lockfile.buffers.string_bytes.as_slice();
    resolution.tag == ResolutionTag::Npm
        && range
            .npm()
            .version
            .satisfies(resolution.npm().version, buf, buf)
}

fn is_named(lockfile: &Lockfile, package: PackageID, range: &DependencyVersion) -> bool {
    let buf = lockfile.buffers.string_bytes.as_slice();
    lockfile.packages.items_name()[package as usize].slice(buf) == range.npm().name.slice(buf)
}

/// Whether the package an edge is bound to is one its range takes. `None`
/// where a range and a version cannot answer that: the edge is left alone.
fn accepts(
    lockfile: &Lockfile,
    dep_id: DependencyID,
    dep: &Dependency,
    target: PackageID,
) -> Option<bool> {
    let range = range_of(lockfile, dep_id, dep)?;
    match lockfile.packages.items_resolution()[target as usize].tag {
        ResolutionTag::Npm => {
            Some(is_named(lockfile, target, &range) && takes(lockfile, &range, target))
        }
        // A workspace serves the dependencies on its name.
        ResolutionTag::Workspace | ResolutionTag::Root => None,
        // The resolver gives no tarball, repository or folder to a range.
        _ => Some(false),
    }
}

/// The `npm:` aliases of the lockfile, by the name they install under.
type Aliases = HashMap<PackageNameHash, Vec<DependencyVersion>>;

/// The resolver records an alias from each place that can declare one for every dependency of its
/// name: a dependency, an override without a scope, a catalog.
fn aliases_of(lockfile: &Lockfile) -> Aliases {
    let mut aliases = Aliases::default();
    let mut record = |dep: &Dependency| {
        if dep.version.tag == DependencyVersionTag::Npm && dep.version.npm().is_alias {
            aliases
                .entry(dep.name_hash)
                .or_default()
                .push(dep.version.clone());
        }
    };
    for slice in lockfile.packages.items_dependencies() {
        slice
            .get(&lockfile.buffers.dependencies)
            .iter()
            .for_each(&mut record);
    }
    lockfile.overrides.map.values().iter().for_each(&mut record);
    let catalogs = &lockfile.catalogs;
    for catalog in core::iter::once(&catalogs.default).chain(catalogs.groups.values()) {
        catalog.values().iter().for_each(&mut record);
    }
    aliases
}

/// The aliases that the resolver gives to this dependency in the place of its own range
/// (`follows_npm_alias`). It looks at them before it looks at the overrides.
fn followed<'a>(
    lockfile: &'a Lockfile,
    aliases: &'a Aliases,
    dep: &'a Dependency,
) -> impl Iterator<Item = &'a DependencyVersion> {
    let buf = lockfile.buffers.string_bytes.as_slice();
    let plain = dep.version.tag == DependencyVersionTag::Npm && !dep.version.npm().is_alias;
    aliases
        .get(&dep.name_hash)
        .filter(|_| plain && !dep.behavior.is_bundled() && !dep.behavior.is_peer())
        .into_iter()
        .flatten()
        .filter(move |alias| {
            follows_npm_alias(&dep.version.npm().version, &alias.npm().version, buf)
        })
}

/// For a package that keeps a path, the versions of it that lost the path there.
type Spares = HashMap<PackageID, Vec<PackageID>>;

fn spares_of(lockfile: &Lockfile, spares: &[Spare]) -> Spares {
    let mut by_package = Spares::default();
    if spares.is_empty() {
        return by_package;
    }
    let buf = lockfile.buffers.string_bytes.as_slice();
    let names = lockfile.packages.items_name();
    let mut packages: HashMap<Vec<u8>, PackageID> = HashMap::default();
    for (package, resolution) in lockfile.packages.items_resolution().iter().enumerate() {
        if resolution.tag == ResolutionTag::Npm {
            let mut id = names[package].slice(buf).to_vec();
            let _ = write!(id, "@{}", resolution.npm().version.fmt(buf));
            packages.insert(id, package as PackageID);
        }
    }
    for spare in spares {
        if let (Some(&kept), Some(&lost)) =
            (packages.get(&spare.kept[..]), packages.get(&spare.lost[..]))
        {
            by_package.entry(kept).or_default().push(lost);
        }
    }
    by_package
}

/// The package of the merged graph for an edge that `target` does not serve: a version that lost
/// its path to `target`, which is what the side of the edge locked, else the highest version that
/// the range takes. `None` also for a dependency that follows an alias: which alias is for the
/// resolver to say.
fn accepting_package(
    lockfile: &Lockfile,
    aliases: &Aliases,
    spares: &Spares,
    dep_id: DependencyID,
    dep: &Dependency,
    target: Option<PackageID>,
) -> Option<PackageID> {
    if followed(lockfile, aliases, dep).next().is_some() {
        return None;
    }
    let range = range_of(lockfile, dep_id, dep)?;
    let buf = lockfile.buffers.string_bytes.as_slice();
    let resolutions = lockfile.packages.items_resolution();
    let highest = |packages: &[PackageID]| {
        packages
            .iter()
            .copied()
            .filter(|&package| {
                is_named(lockfile, package, &range) && takes(lockfile, &range, package)
            })
            .max_by(|&a, &b| {
                resolutions[a as usize].npm().version.order(
                    resolutions[b as usize].npm().version,
                    buf,
                    buf,
                )
            })
    };
    target
        .and_then(|target| highest(spares.get(&target)?))
        .or_else(|| {
            let name_hash = Semver::string::Builder::string_hash(range.npm().name.slice(buf));
            highest(lockfile.package_index.get(&name_hash)?.as_slice())
        })
}

#[derive(Default)]
struct Rebind {
    checked: u32,
    moved: u32,
    open: u32,
    open_workspaces: u32,
}

/// One visit per edge. Moving an edge changes which packages are reached, never what another edge accepts.
fn rebind(lockfile: &mut Lockfile, spares: &[Spare]) -> Rebind {
    let mut stats = Rebind::default();
    let package_count = lockfile.packages.len();
    let mut resolutions = lockfile.buffers.resolutions.clone();
    let aliases = aliases_of(lockfile);
    let spares = spares_of(lockfile, spares);

    for owner in 0..package_count {
        let slice = lockfile.packages.items_dependencies()[owner];
        for dep_id in slice.begin()..slice.end() {
            let dep = &lockfile.buffers.dependencies[dep_id as usize];
            let target = resolutions[dep_id as usize];
            let bound = (target as usize) < package_count;
            if bound {
                let Some(accepted) = accepts(lockfile, dep_id, dep, target) else {
                    continue;
                };
                stats.checked += 1;
                if accepted
                    || followed(lockfile, &aliases, dep).any(|alias| {
                        is_named(lockfile, target, alias) && takes(lockfile, alias, target)
                    })
                {
                    continue;
                }
                // Rows of one owner and one name share a folder: the package one of them takes serves all.
                // A peer has no say in that: it goes where another row put the package.
                let shared = (slice.begin()..slice.end()).any(|sibling| {
                    let other = &lockfile.buffers.dependencies[sibling as usize];
                    sibling != dep_id
                        && other.name_hash == dep.name_hash
                        && resolutions[sibling as usize] == target
                        && range_of(lockfile, sibling, other)
                            .is_some_and(|range| takes(lockfile, &range, target))
                });
                if shared {
                    continue;
                }
            } else if may_stay_unbound(dep) {
                continue;
            }
            match accepting_package(
                lockfile,
                &aliases,
                &spares,
                dep_id,
                dep,
                bound.then_some(target),
            ) {
                Some(package) => {
                    resolutions[dep_id as usize] = package;
                    stats.moved += 1;
                }
                // An optional dependency keeps the package it has: without it the install skips the dependency.
                None if dep.behavior.is_optional() => {}
                None => resolutions[dep_id as usize] = invalid_package_id,
            }
        }
    }

    lockfile.buffers.resolutions = resolutions;
    let reached = reachable::packages(
        lockfile,
        &lockfile.buffers.resolutions,
        reachable::Options::all(0),
    );
    for dep_id in open_edges(lockfile, &reached) {
        let dep = &lockfile.buffers.dependencies[dep_id as usize];
        bun_core::scoped_log!(
            lockfile_merge,
            "open: {}@{}",
            bstr::BStr::new(lockfile.str(&dep.name)),
            bstr::BStr::new(lockfile.str(&dep.version.literal))
        );
        stats.open += 1;
        if dep.behavior.is_workspace() {
            stats.open_workspaces += 1;
        }
    }
    stats
}

/// The required dependencies of reached packages that no package of the graph serves.
fn open_edges<'a>(
    lockfile: &'a Lockfile,
    reached: &'a DynamicBitSet,
) -> impl Iterator<Item = DependencyID> + 'a {
    let package_count = lockfile.packages.len();
    (0..package_count)
        .filter(|&owner| reached.is_set(owner))
        .flat_map(move |owner| {
            let slice = lockfile.packages.items_dependencies()[owner];
            slice.begin()..slice.end()
        })
        .filter(move |&dep_id| {
            (lockfile.buffers.resolutions[dep_id as usize] as usize) >= package_count
                && !may_stay_unbound(&lockfile.buffers.dependencies[dep_id as usize])
        })
}

/// The edges a lockfile that bun wrote can hold without a package.
fn may_stay_unbound(dep: &Dependency) -> bool {
    dep.behavior.is_optional()
        || dep.behavior.is_peer()
        || dep.version.tag == DependencyVersionTag::Uninitialized
}

/// The open edges of a lockfile that was merged for [`Purpose::Install`]. The resolver takes a
/// package of the lockfile as it is, so a package that it reached since the last call can add to them.
pub fn open_edges_of(lockfile: &Lockfile) -> Vec<DependencyID> {
    let reached = reachable::packages(
        lockfile,
        &lockfile.buffers.resolutions,
        reachable::Options::all(0),
    );
    open_edges(lockfile, &reached).collect()
}

/// Prints the merged graph and loads that text with the strict loader.
fn reload(lockfile: &mut Lockfile, manager: &mut PackageManager) -> Option<()> {
    // `save_from_binary` only asks this whether the lockfile came from `bun.lockb`.
    let loaded_from_text = LoadResult::Err(LoadResultErr {
        step: LoadStep::ParseFile,
        value: crate::Error::DebugTextLockfileRoundTrip,
        lockfile_path: zstr!("bun.lock"),
        format: LockfileFormat::Text,
    });
    // The printer writes the `configVersion` of the options, which no command has chosen yet.
    let config_version = lockfile.saved_config_version;
    let mut text = Vec::new();
    TextLockfile::Stringifier::save_from_binary(
        lockfile,
        &loaded_from_text,
        &manager.options,
        &mut text,
    )
    .ok()?;
    load(lockfile, &text, manager, LoadMode::Strict)?;
    lockfile.saved_config_version = config_version;
    Some(())
}

fn recover(
    lockfile: &mut Lockfile,
    text: &[u8],
    manager: &mut PackageManager,
    purpose: Purpose,
) -> Result<(), Declined> {
    const DOES_NOT_LOAD: &str = "the merge of both sides does not load";
    let union = parse_union(text)?;
    union
        .versions
        .iter()
        .flatten()
        .find_map(|&version| load(lockfile, &union.text(version), manager, LoadMode::Recover))
        .ok_or(DOES_NOT_LOAD)?;
    let stats = rebind(lockfile, &union.spares);
    bun_core::scoped_log!(
        lockfile_merge,
        "rows moved {} folded {} dropped {}, edges checked {} moved {} open {}",
        union.counters.rekeyed,
        union.counters.folded,
        union.counters.dropped,
        stats.checked,
        stats.moved,
        stats.open
    );
    // The comparison with package.json reads the package of every workspace that the root lists.
    if stats.open_workspaces > 0 {
        return Err("a workspace has no package on either side".into());
    }
    if stats.open > 0 && purpose == Purpose::Read {
        return Err(Declined::NeedsInstall);
    }
    lockfile
        .resolve(&mut bun_ast::Log::init())
        .map_err(|_| "the packages of both sides do not fit one node_modules")?;
    match purpose {
        // A range that package.json kept can be the range of a package that lost its path,
        // so those packages stay until the resolver has seen package.json.
        Purpose::Install => Ok(()),
        Purpose::Read => reload(lockfile, manager).ok_or(DOES_NOT_LOAD.into()),
    }
}

/// Loads the conflicted `text` into `lockfile`, or says why not. On `false`
/// the lockfile is empty and the caller reports the parse error it came here with.
#[cold]
#[inline(never)]
pub(crate) fn load_conflicted(
    lockfile: &mut Lockfile,
    text: &[u8],
    manager: &mut PackageManager,
    purpose: Purpose,
) -> bool {
    // The loader records aliases as positions in the text it reads. A load that fails leaves them behind.
    let known = core::mem::take(&mut manager.known_npm_aliases);
    let recovered = recover(lockfile, text, manager, purpose);
    let recorded = core::mem::replace(&mut manager.known_npm_aliases, known);
    match recovered {
        Ok(()) => {
            for (&name_hash, alias) in recorded.iter() {
                manager.known_npm_aliases.insert(name_hash, alias.clone());
            }
            true
        }
        Err(declined) => {
            lockfile.init_empty();
            note_declined(&declined, manager.options.log_level);
            false
        }
    }
}

/// Drops what the parse that found the markers logged.
pub(crate) fn forget_parse_error(log: &mut bun_ast::Log, mark: usize) {
    for msg in log.msgs.drain(mark..) {
        match msg.kind {
            bun_ast::Kind::Err => log.errors = log.errors.saturating_sub(1),
            bun_ast::Kind::Warn => log.warnings = log.warnings.saturating_sub(1),
            _ => {}
        }
    }
}

/// Some commands load the lockfile more than once.
static NOTED: AtomicBool = AtomicBool::new(false);

fn note_declined(declined: &Declined, log_level: LogLevel) {
    match declined {
        Declined::NeedsInstall => {
            bun_core::scoped_log!(lockfile_merge, "not merged: needs install")
        }
        Declined::Unmergeable(reason, subject) => bun_core::scoped_log!(
            lockfile_merge,
            "not merged: {} ({})",
            reason,
            bstr::BStr::new(subject.as_deref().unwrap_or_default())
        ),
    }
    if log_level == LogLevel::Silent || NOTED.swap(true, AtomicOrdering::Relaxed) {
        return;
    }
    match declined {
        Declined::NeedsInstall => bun_core::note!(
            "bun.lock contains git merge conflict markers. Run <b>bun install<r> to merge both sides"
        ),
        Declined::Unmergeable(reason, None) => bun_core::note!(
            "bun.lock contains git merge conflict markers that bun cannot merge: {}",
            reason
        ),
        Declined::Unmergeable(reason, Some(subject)) => bun_core::note!(
            "bun.lock contains git merge conflict markers that bun cannot merge: {} ({})",
            reason,
            bstr::BStr::new(subject)
        ),
    }
}

/// For the commands that read a lockfile that [`load_conflicted`] loaded.
#[cold]
#[inline(never)]
pub fn note_merged_for_reading(log_level: LogLevel) {
    if log_level != LogLevel::Silent && !NOTED.swap(true, AtomicOrdering::Relaxed) {
        bun_core::note!(
            "bun.lock contains git merge conflict markers, reading the merge of both sides. Run <b>bun install<r> to save it"
        );
    }
}

/// Ends a command that changes the lockfile without comparing it with package.json first.
#[cold]
#[inline(never)]
pub fn exit_if_merged(load_result: &LoadResult<'_>, log_level: LogLevel) {
    if !matches!(load_result, LoadResult::Ok(ok) if ok.merged_conflict) {
        return;
    }
    if log_level != LogLevel::Silent {
        bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> bun.lock contains git merge conflict markers"
        );
        bun_core::note!("run 'bun install' first");
    }
    bun_core::Global::exit(1);
}
