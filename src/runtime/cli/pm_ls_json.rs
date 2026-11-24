//! `bun pm ls --json`: a document with the shape of `pnpm ls --json`, an array that holds the root package.

use std::io::Write as _;

use bun_ast::Log;
use bun_collections::{DynamicBitSet, StringHashMap, index_sort};
use bun_core::fmt::{PathSep, redacted, redacted_npm_url};
use bun_core::printer::json_stringify;
use bun_core::{Output, handle_oom, strings};
use bun_install::lockfile::package::{DependencyGroup, PackageColumns as _};
use bun_install::lockfile::{Lockfile, tree};
use bun_install::{
    Behavior, DependencyID, Features, INVALID_DEPENDENCY_ID, PackageID, PackageNameHash,
    ResolutionTag,
};
use bun_paths::Path;
use bun_resolver::fs::FileSystem;
use bun_sys::{Dir, E};

use crate::cli::pm_licenses_command::{BunStore, read_package_info};

/// The sections of the root package, in the order of the document.
const SECTIONS: [DependencyGroup; 5] = [
    DependencyGroup::DEPENDENCIES,
    DependencyGroup::DEV,
    DependencyGroup::OPTIONAL,
    DependencyGroup::PEER,
    DependencyGroup::WORKSPACES,
];

/// The index in `SECTIONS` of a dependency of the root. In bun.lock every workspace is one.
fn section_of(behavior: Behavior) -> usize {
    let key = if behavior.is_workspace() {
        DependencyGroup::WORKSPACES.prop
    } else {
        DependencyGroup::prop_for_behavior(behavior)
    };
    (SECTIONS.iter())
        .position(|section| section.prop == key)
        .unwrap_or(0)
}

/// The rows of `buffers.dependencies` that the document lists for each package, by name, and for the root by section.
type Rows = Vec<Box<[DependencyID]>>;

pub(crate) struct Listing<'a> {
    pub(crate) lockfile: &'a Lockfile,
    /// `--production` and `--omit`.
    pub(crate) features: Features,
    /// The packages that `features` leave.
    pub(crate) wanted: &'a DynamicBitSet,
    /// The test of the text list for a row of the `node_modules` at a path. With `true` the isolated store counts.
    pub(crate) is_installed: &'a mut dyn FnMut(&[u8], DependencyID, bool) -> bool,
    /// Package names and `--trusted`.
    pub(crate) selected: Option<&'a dyn Fn(DependencyID) -> bool>,
    /// `--trusted`: an entry says that it is trusted, because the entries that lead to it are listed too.
    pub(crate) trusted: Option<&'a dyn Fn(DependencyID) -> bool>,
    /// `--all`, or package names without `--depth=0`: an entry has the dependencies of its package.
    pub(crate) all: bool,
}

impl<'a> Listing<'a> {
    /// Returns whether the document lists a package.
    pub(crate) fn print(mut self) -> bool {
        let lockfile = self.lockfile;
        let mut paths = Paths::init(lockfile);
        let (rows, on_disk) = self.rows(&mut paths);
        let nesting = Nesting::of(lockfile, &rows, self.all);
        let trusted = |row: DependencyID| {
            self.trusted.is_some_and(|trusted| trusted(row))
                && on_disk.as_ref().is_none_or(|on_disk| on_disk.has(row))
        };

        let mut out = Document::begin(paths.top_level_dir, &paths.root);
        let dependencies = lockfile.buffers.dependencies.as_slice();
        let section_of_row = |row: DependencyID| section_of(dependencies[row as usize].behavior);
        for section in rows[0].chunk_by(|&a, &b| section_of_row(a) == section_of_row(b)) {
            out.comma_key(2, SECTIONS[section_of_row(section[0])].prop);
            out.entries(&mut paths, &rows, &nesting, section, &trusted);
        }
        out.end();
        !rows[0].is_empty()
    }

    /// Returns the rows, and with `--all` what is on disk. Without it `rows_of` has tested the rows of the root.
    fn rows(&mut self, paths: &mut Paths<'_>) -> (Rows, Option<OnDisk<'a>>) {
        let lockfile = self.lockfile;
        let resolutions = lockfile.buffers.resolutions.as_slice();
        let package_of = |row: DependencyID| resolutions[row as usize] as usize;
        let mut rows: Rows = vec![Box::default(); lockfile.packages.len()];
        if !self.all {
            rows[0] = self.rows_of(0, true);
            if let Some(selected) = self.selected {
                retain(&mut rows, selected);
            }
            return (rows, None);
        }

        let on_disk = self.on_disk(paths);
        let mut seen = handle_oom(DynamicBitSet::init_empty(rows.len()));
        seen.set(0);
        let mut unvisited: Vec<PackageID> = vec![0];
        while let Some(dependent) = unvisited.pop() {
            rows[dependent as usize] = self.rows_of(dependent as usize, false);
            for &row in rows[dependent as usize].iter() {
                if !seen.is_set(package_of(row)) {
                    seen.set(package_of(row));
                    unvisited.push(package_of(row) as PackageID);
                }
            }
        }

        // What is on disk under a name that nothing on disk depends on needs the rows that lead to it.
        let reached = on_disk.reached(&rows);
        let stranded = |row: DependencyID| on_disk.has(row) && !reached.has(row);
        let leads = leading_to(lockfile, &rows, &stranded);
        retain(&mut rows, &|row| {
            on_disk.has(row) || leads.is_set(package_of(row))
        });
        if let Some(selected) = self.selected {
            let is_selected = |row: DependencyID| selected(row) && on_disk.has(row);
            let leads = leading_to(lockfile, &rows, &is_selected);
            retain(&mut rows, &|row| {
                is_selected(row) || leads.is_set(package_of(row))
            });
        }
        (rows, Some(on_disk))
    }

    /// What `bun pm ls --all` lists: the rows of the hoisted tree whose `node_modules` folder has them, or the store.
    fn on_disk(&mut self, paths: &mut Paths<'_>) -> OnDisk<'a> {
        let lockfile = self.lockfile;
        let resolutions = lockfile.buffers.resolutions.as_slice();
        let dependencies = lockfile.buffers.dependencies.as_slice();
        let buf = lockfile.buffers.string_bytes.as_slice();

        let mut names: Vec<(PackageID, PackageNameHash)> = Vec::new();
        let mut folders =
            tree::Iterator::<{ tree::IteratorPathStyle::NodeModules }>::init(lockfile);
        while let Some(folder) = folders.next(None) {
            let dir = folder.relative_path.as_bytes();
            for &row in folder.dependencies {
                let package = resolutions[row as usize] as usize;
                if package < lockfile.packages.len()
                    && self.wanted.is_set(package)
                    && (self.is_installed)(dir, row, true)
                {
                    let dependency = &dependencies[row as usize];
                    names.push((package as PackageID, dependency.name_hash));
                    let folder = Path::from_parts(&[dir, dependency.name.slice(buf)]);
                    paths.in_tree[package].push(folder.as_bytes().into());
                }
            }
        }
        index_sort::sort_slice_unstable(&mut names);
        OnDisk { lockfile, names }
    }

    /// `direct`: the test of the text list for a direct dependency, which has to be in the `node_modules` of the root.
    fn rows_of(&mut self, dependent: usize, direct: bool) -> Box<[DependencyID]> {
        let lockfile = self.lockfile;
        let resolutions = lockfile.buffers.resolutions.as_slice();
        let dependencies = lockfile.buffers.dependencies.as_slice();
        let buf = lockfile.buffers.string_bytes.as_slice();

        let list = lockfile.packages.items_dependencies()[dependent];
        let mut rows: Vec<DependencyID> = (list.begin()..list.end())
            .filter(|&row| {
                let package = resolutions[row as usize] as usize;
                package < lockfile.packages.len()
                    && dependencies[row as usize]
                        .behavior
                        .is_enabled(self.features)
                    && if direct {
                        (self.is_installed)(b"node_modules", row, false)
                    } else {
                        self.wanted.is_set(package)
                    }
            })
            .collect();

        let key = |row: DependencyID| {
            let dependency = &dependencies[row as usize];
            let section = if dependent == 0 {
                section_of(dependency.behavior)
            } else {
                0
            };
            (section, dependency.name.slice(buf))
        };
        index_sort::sort_indices(&mut rows, &mut |a, b| key(a).cmp(&key(b)));
        // A JSON object has a key once.
        rows.dedup_by(|a, b| key(*a) == key(*b));
        rows.into_boxed_slice()
    }
}

/// Rows as the package and the name that it is installed under. Sorted.
struct OnDisk<'a> {
    lockfile: &'a Lockfile,
    names: Vec<(PackageID, PackageNameHash)>,
}

impl<'a> OnDisk<'a> {
    fn name_of(&self, row: DependencyID) -> (PackageID, PackageNameHash) {
        let package = self.lockfile.buffers.resolutions[row as usize];
        (
            package,
            self.lockfile.buffers.dependencies[row as usize].name_hash,
        )
    }

    /// Whether the package of `row` is there under the name of `row`. The root is.
    fn has(&self, row: DependencyID) -> bool {
        let name = self.name_of(row);
        name.0 == 0 || self.names.binary_search(&name).is_ok()
    }

    /// What the rows that are on disk lead to from the root.
    fn reached(&self, rows: &Rows) -> OnDisk<'a> {
        let mut names: Vec<(PackageID, PackageNameHash)> = Vec::new();
        let mut seen = handle_oom(DynamicBitSet::init_empty(rows.len()));
        seen.set(0);
        let mut unvisited: Vec<PackageID> = vec![0];
        while let Some(dependent) = unvisited.pop() {
            for &row in rows[dependent as usize]
                .iter()
                .filter(|&&row| self.has(row))
            {
                let name = self.name_of(row);
                names.push(name);
                if !seen.is_set(name.0 as usize) {
                    seen.set(name.0 as usize);
                    unvisited.push(name.0);
                }
            }
        }
        index_sort::sort_slice_unstable(&mut names);
        OnDisk {
            lockfile: self.lockfile,
            names,
        }
    }
}

/// The packages that have a row below them that `is_goal` takes. The root is below no package.
fn leading_to(
    lockfile: &Lockfile,
    rows: &Rows,
    is_goal: &dyn Fn(DependencyID) -> bool,
) -> DynamicBitSet {
    let resolutions = lockfile.buffers.resolutions.as_slice();
    let mut leads = handle_oom(DynamicBitSet::init_empty(rows.len()));
    let mut dependents: Vec<Vec<PackageID>> = vec![Vec::new(); rows.len()];
    let mut unvisited: Vec<PackageID> = Vec::new();
    for (dependent, of_dependent) in rows.iter().enumerate().skip(1) {
        for &row in of_dependent.iter() {
            dependents[resolutions[row as usize] as usize].push(dependent as PackageID);
            if is_goal(row) && !leads.is_set(dependent) {
                leads.set(dependent);
                unvisited.push(dependent as PackageID);
            }
        }
    }
    while let Some(package) = unvisited.pop() {
        for &dependent in &dependents[package as usize] {
            if !leads.is_set(dependent as usize) {
                leads.set(dependent as usize);
                unvisited.push(dependent);
            }
        }
    }
    leads
}

fn retain(rows: &mut Rows, stays: &dyn Fn(DependencyID) -> bool) {
    for of_dependent in rows.iter_mut() {
        *of_dependent = of_dependent
            .iter()
            .copied()
            .filter(|&row| stays(row))
            .collect();
    }
}

/// The document of `bun pm ls -g --json` when nothing is installed globally.
pub(crate) fn print_without_lockfile() {
    Document::begin(FileSystem::get().top_level_dir(), &project_root()).end();
}

/// Where a package that is in the document more than once has its dependencies.
struct Nesting {
    /// The row that a package has its dependencies under: the first that a breadth-first walk from the root reaches.
    expanded_by: Vec<DependencyID>,
    /// How many entries a package has below it there, which is what its other entries leave out.
    below: Vec<u32>,
}

impl Nesting {
    /// Without `all` no entry has dependencies.
    fn of(lockfile: &Lockfile, rows: &Rows, all: bool) -> Self {
        let resolutions = lockfile.buffers.resolutions.as_slice();
        let mut nesting = Self {
            expanded_by: vec![INVALID_DEPENDENCY_ID; rows.len()],
            below: vec![0; rows.len()],
        };
        if !all {
            return nesting;
        }

        let mut seen = handle_oom(DynamicBitSet::init_empty(rows.len()));
        seen.set(0);
        let mut order: Vec<PackageID> = vec![0];
        let mut next = 0;
        while next < order.len() {
            for &row in rows[order[next] as usize].iter() {
                let package = resolutions[row as usize];
                if !seen.is_set(package as usize) {
                    seen.set(package as usize);
                    nesting.expanded_by[package as usize] = row;
                    order.push(package);
                }
            }
            next += 1;
        }
        // A package comes after the one that it is expanded in. The root is no entry.
        for &dependent in order[1..].iter().rev() {
            nesting.below[dependent as usize] = (rows[dependent as usize].iter())
                .map(|&row| {
                    let package = resolutions[row as usize] as usize;
                    let expanded = nesting.expanded_by[package] == row;
                    1 + if expanded { nesting.below[package] } else { 0 }
                })
                .sum();
        }
        nesting
    }
}

/// One `open` and one read of the path of the descriptor, where `realpath()` reads every component.
fn real_path(path: &Path) -> Option<Box<[u8]>> {
    let mut buf = bun_paths::path_buffer_pool::get();
    match Dir::open(path) {
        Ok(dir) => {
            if let Ok(real) = dir.get_fd_path(&mut buf) {
                return Some((&*real).into());
            }
        }
        Err(err) if matches!(err.get_errno(), E::ENOENT | E::ENOTDIR) => return None,
        // A folder that can be entered and not listed.
        Err(_) => {}
    }
    bun_sys::realpath(path, &mut buf).ok().map(Into::into)
}

fn project_root() -> Box<[u8]> {
    let fs = FileSystem::get();
    real_path(&Path::from(fs.top_level_dir()))
        .unwrap_or_else(|| fs.top_level_dir_without_trailing_slash().into())
}

/// Where the packages are on disk, as real paths.
struct Paths<'a> {
    lockfile: &'a Lockfile,
    top_level_dir: &'static [u8],
    root: Box<[u8]>,
    store: BunStore,
    /// Where `bun pm ls --all` found each package, relative to the top-level directory.
    in_tree: Vec<Vec<Box<[u8]>>>,
    /// What `anywhere` found for each package.
    found: Vec<Option<Option<Box<[u8]>>>>,
    /// Whether a directory has a `node_modules`.
    node_modules: StringHashMap<bool>,
    /// The name and the version in the package.json of a folder.
    manifests: StringHashMap<Option<[Option<Box<[u8]>>; 2]>>,
    log: Log,
}

impl<'a> Paths<'a> {
    fn init(lockfile: &'a Lockfile) -> Self {
        let len = lockfile.packages.len();
        Self {
            lockfile,
            top_level_dir: FileSystem::get().top_level_dir(),
            root: project_root(),
            store: BunStore::init(),
            in_tree: vec![Vec::new(); len],
            found: vec![None; len],
            node_modules: StringHashMap::default(),
            manifests: StringHashMap::default(),
            log: Log::init(),
        }
    }

    /// A folder that has the package of `row`: the one that `dependent` loads, or else where `anywhere` finds it.
    fn of(&mut self, row: DependencyID, dependent: Option<&[u8]>) -> Option<Box<[u8]>> {
        let lockfile = self.lockfile;
        let buf = lockfile.buffers.string_bytes.as_slice();
        let package = lockfile.buffers.resolutions[row as usize] as usize;
        let resolution = &lockfile.packages.items_resolution()[package];
        match resolution.tag {
            ResolutionTag::Root => return Some(self.root.clone()),
            ResolutionTag::Workspace => {
                let workspace = resolution.workspace().slice(buf);
                return real_path(&Path::resolve(&[self.top_level_dir, workspace]));
            }
            ResolutionTag::Symlink => {
                // A name is a `bun link` registration, which `node_modules` leads to.
                let target = resolution.symlink().slice(buf);
                if !target.is_empty() && !strings::is_npm_package_name(target) {
                    return real_path(&Path::resolve(&[self.top_level_dir, target]));
                }
            }
            _ => {}
        }

        dependent
            .and_then(|dependent| self.loaded(dependent, row))
            .or_else(|| self.anywhere(package))
    }

    /// The nearest `node_modules` folder that has the package of `row`, in `dependent` or above it, as Node.js looks.
    fn loaded(&mut self, dependent: &[u8], row: DependencyID) -> Option<Box<[u8]>> {
        let lockfile = self.lockfile;
        let package = lockfile.buffers.resolutions[row as usize] as usize;
        let dependency = &lockfile.buffers.dependencies[row as usize];
        let alias = dependency
            .name
            .slice(lockfile.buffers.string_bytes.as_slice());
        let in_project = bun_paths::strip_prefix(dependent, &self.root).is_some();
        for dir in bun_paths::ancestors(dependent) {
            if bun_paths::basename(dir) != b"node_modules" && self.has_node_modules(dir) {
                // A tarball brings the version of a bundled dependency with it.
                let any_version = dependency.behavior.is_bundled() && dir == dependent;
                let found = real_path(&Path::from_parts(&[dir, b"node_modules", alias]))
                    .filter(|folder| self.holds(folder, package, any_version));
                // A package of a store outside of the project has its dependencies beside it.
                if found.is_some() || !in_project {
                    return found;
                }
            }
            if dir == &*self.root {
                break;
            }
        }
        None
    }

    fn has_node_modules(&mut self, dir: &[u8]) -> bool {
        if let Some(&known) = self.node_modules.get(dir) {
            return known;
        }
        let exists = bun_sys::exists_z(&Path::from_parts(&[dir, b"node_modules"]));
        handle_oom(self.node_modules.put(dir, exists));
        exists
    }

    /// A folder that has `package`: where the text list found it, or its folder in the store of the isolated linker.
    fn anywhere(&mut self, package: usize) -> Option<Box<[u8]>> {
        if let Some(found) = &self.found[package] {
            return found.clone();
        }
        let lockfile = self.lockfile;
        let top_level_dir = self.top_level_dir;
        let buf = lockfile.buffers.string_bytes.as_slice();
        let name = lockfile.packages.items_name()[package];
        let resolution = &lockfile.packages.items_resolution()[package];

        let in_store = (self.store.lookup(top_level_dir, name, resolution, buf)).map(|entry| {
            let in_store: [&[u8]; 5] = [
                top_level_dir,
                b"node_modules/.bun",
                entry,
                b"node_modules",
                name.slice(buf),
            ];
            Path::from_parts(&in_store)
        });
        let in_tree = core::mem::take(&mut self.in_tree[package]);
        let found = (in_tree.iter())
            .map(|in_tree| Path::from_parts(&[top_level_dir, in_tree]))
            .chain(in_store)
            .find_map(|path| real_path(&path).filter(|folder| self.holds(folder, package, false)));
        self.found[package] = Some(found.clone());
        found
    }

    /// Whether the package.json of `folder` is the one of `package`: the name, and for an npm package the version.
    fn holds(&mut self, folder: &[u8], package: usize, any_version: bool) -> bool {
        if !self.manifests.contains_key(folder) {
            let manifest = read_package_info(folder, &mut self.log)
                .map(|manifest| [manifest.name, manifest.version]);
            handle_oom(self.manifests.put(folder, manifest));
        }
        let Some(Some([name, version])) = self.manifests.get(folder) else {
            return false;
        };
        let lockfile = self.lockfile;
        let buf = lockfile.buffers.string_bytes.as_slice();
        let resolution = &lockfile.packages.items_resolution()[package];
        if resolution.tag != ResolutionTag::Npm {
            // bun.lock makes up a name for a folder or a repository whose package.json has none.
            return (name.as_deref())
                .is_none_or(|name| name == lockfile.packages.items_name()[package].slice(buf));
        }
        name.as_deref() == Some(lockfile.packages.items_name()[package].slice(buf))
            && (any_version
                || version.as_deref().is_some_and(|version| {
                    resolution.fmt(buf, PathSep::Posix).to_string().as_bytes() == version
                }))
    }
}

/// An object of entries that is not closed yet.
struct Open<'a> {
    /// The ones that are still to print.
    rows: &'a [DependencyID],
    indent: usize,
    /// Where the package that depends on them is.
    dependent: Option<Box<[u8]>>,
}

struct Document {
    bytes: Vec<u8>,
}

impl Document {
    /// The root package up to its dependencies: what its package.json says it is, and where it is.
    fn begin(top_level_dir: &[u8], root: &[u8]) -> Self {
        let mut out = Self {
            bytes: b"[\n  {".to_vec(),
        };
        let manifest = read_package_info(top_level_dir, &mut Log::init());
        let (name, version, private) = match &manifest {
            Some(it) => (it.name.as_deref(), it.version.as_deref(), it.private),
            None => (None, None, false),
        };
        let named: [(&[u8], Option<&[u8]>); 2] = [(b"name", name), (b"version", version)];
        for (key, value) in named {
            if let Some(value) = value {
                out.key(2, key);
                out.string(value);
                out.bytes.push(b',');
            }
        }
        out.key(2, b"path");
        out.string(root);
        out.comma_key(2, b"private");
        let _ = write!(out.bytes, "{private}");
        out
    }

    fn line(&mut self, indent: usize) {
        self.bytes.push(b'\n');
        for _ in 0..indent {
            self.bytes.extend_from_slice(b"  ");
        }
    }

    fn key(&mut self, indent: usize, key: &[u8]) {
        self.line(indent);
        json_stringify(key, &mut self.bytes);
        self.bytes.extend_from_slice(b": ");
    }

    fn comma_key(&mut self, indent: usize, key: &[u8]) {
        self.bytes.push(b',');
        self.key(indent, key);
    }

    fn string(&mut self, text: &[u8]) {
        json_stringify(text, &mut self.bytes);
    }

    /// The object of a section of the root, after its key. No recursion: a chain of dependencies can be long.
    fn entries(
        &mut self,
        paths: &mut Paths<'_>,
        rows: &Rows,
        nesting: &Nesting,
        section: &[DependencyID],
        trusted: &dyn Fn(DependencyID) -> bool,
    ) {
        let lockfile = paths.lockfile;
        let resolutions = lockfile.buffers.resolutions.as_slice();
        self.bytes.push(b'{');
        let mut open: Vec<Open<'_>> = vec![Open {
            rows: section,
            indent: 3,
            dependent: Some(paths.root.clone()),
        }];
        let mut first = true;
        while let Some(top) = open.last_mut() {
            let indent = top.indent;
            let Some((&row, rest)) = top.rows.split_first() else {
                open.pop();
                self.line(indent - 1);
                self.bytes.push(b'}');
                // The entry that these were the dependencies of.
                if !open.is_empty() {
                    self.line(indent - 2);
                    self.bytes.push(b'}');
                }
                first = false;
                continue;
            };
            top.rows = rest;
            if !first {
                self.bytes.push(b',');
            }
            let folder = self.entry(paths, row, indent, top.dependent.as_deref());
            if trusted(row) {
                self.comma_key(indent + 1, b"trusted");
                self.bytes.extend_from_slice(b"true");
            }

            let package = resolutions[row as usize] as usize;
            if nesting.expanded_by[package] == row && !rows[package].is_empty() {
                self.comma_key(indent + 1, b"dependencies");
                self.bytes.push(b'{');
                open.push(Open {
                    rows: &rows[package],
                    indent: indent + 2,
                    dependent: folder,
                });
                first = true;
                continue;
            }
            if nesting.below[package] > 0 {
                self.comma_key(indent + 1, b"deduped");
                self.bytes.extend_from_slice(b"true");
                self.comma_key(indent + 1, b"dedupedDependenciesCount");
                let _ = write!(self.bytes, "{}", nesting.below[package]);
            }
            self.line(indent);
            self.bytes.push(b'}');
            first = false;
        }
    }

    /// `"<name>": {` and what the package of `row` is. The caller closes the object. Returns where the package is.
    fn entry(
        &mut self,
        paths: &mut Paths<'_>,
        row: DependencyID,
        indent: usize,
        dependent: Option<&[u8]>,
    ) -> Option<Box<[u8]>> {
        let lockfile = paths.lockfile;
        let buf = lockfile.buffers.string_bytes.as_slice();
        let package = lockfile.buffers.resolutions[row as usize] as usize;
        let resolution = &lockfile.packages.items_resolution()[package];
        let alias = lockfile.buffers.dependencies[row as usize].name.slice(buf);
        let version = redacted(resolution.fmt(buf, PathSep::Posix)).to_string();

        self.key(indent, alias);
        self.bytes.push(b'{');
        self.key(indent + 1, b"from");
        self.string(lockfile.packages.items_name()[package].slice(buf));
        self.comma_key(indent + 1, b"version");
        self.string(version.as_bytes());
        if resolution.tag == ResolutionTag::Npm {
            let tarball = redacted_npm_url(resolution.npm().url.slice(buf)).to_string();
            if !tarball.is_empty() {
                self.comma_key(indent + 1, b"resolved");
                self.string(tarball.as_bytes());
            }
        }
        let path = paths.of(row, dependent);
        if let Some(path) = &path {
            self.comma_key(indent + 1, b"path");
            self.string(path);
        }
        path
    }

    fn end(mut self) {
        self.bytes.extend_from_slice(b"\n  }\n]\n");
        Output::flush();
        let _ = Output::writer().write_all(&self.bytes);
        Output::flush();
    }
}
