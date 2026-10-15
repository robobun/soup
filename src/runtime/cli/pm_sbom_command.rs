//! `bun pm sbom`: the packages of bun.lock as a bill of materials, CycloneDX 1.6 or SPDX 2.3.

use std::io::Write as _;

use bun_collections::StringHashMap;
use bun_core::fmt::PathSep;
use bun_core::{Global, Output, strings};
use bun_install::dependency::Behavior;
use bun_install::lockfile::{Lockfile, package::PackageColumns as _, reachable};
use bun_install::package_manager::LogLevel;
use bun_install::{PackageID, PackageManager, Repository, RepositoryExt as _, ResolutionTag};
use bun_install_types::NodeLinker::NodeLinker;

use crate::cli::package_manager_command::PackageManagerCommand;
use crate::cli::pm_licenses_command::{InstalledPackages, PackageInfo, UNKNOWN_LICENSE};

/// SPDX license list 3.29.0, the `id`s of CycloneDX 1.6: licenses, an empty line, exceptions.
static SPDX_LICENSE_IDS: &[u8] = include_bytes!("spdx-license-ids.txt");

#[derive(Clone, Copy)]
enum Format {
    CycloneDx,
    Spdx,
}

/// `--sbom-type`: the type of the root component in CycloneDX, its purpose in SPDX.
#[derive(Clone, Copy)]
enum ProjectType {
    Library,
    Application,
    Framework,
}

impl ProjectType {
    fn cyclonedx(self) -> &'static str {
        match self {
            ProjectType::Library => "library",
            ProjectType::Application => "application",
            ProjectType::Framework => "framework",
        }
    }

    fn spdx(self) -> &'static str {
        match self {
            ProjectType::Library => "LIBRARY",
            ProjectType::Application => "APPLICATION",
            ProjectType::Framework => "FRAMEWORK",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SbomFlags {
    pub(crate) format: Option<&'static [u8]>,
    pub(crate) project_type: Option<&'static [u8]>,
}

/// Where a package comes from, which decides its package URL and its download location.
enum Origin {
    /// The project itself, a workspace, a `file:` folder or tarball, a `link:`.
    Local,
    /// The URL of the tarball.
    Registry(Box<[u8]>),
    RemoteTarball(Box<[u8]>),
    /// `url` is the one that `bun install` clones from first.
    Git {
        url: Box<[u8]>,
        commit: Box<[u8]>,
    },
    Github {
        owner: Box<[u8]>,
        repo: Box<[u8]>,
        commit: Box<[u8]>,
    },
}

struct Component {
    package_id: PackageID,
    /// Unique in the document. The dependency graph names a component by it.
    bom_ref: Vec<u8>,
    name: Box<[u8]>,
    version: Option<Box<[u8]>>,
    origin: Origin,
    /// The algorithm as an SRI string names it (`sha512`), and the digest.
    hash: Option<(&'static str, Box<[u8]>)>,
    /// Only devDependencies lead to it.
    dev: bool,
    /// Has the scope `optional` of CycloneDX.
    optional: bool,
    /// What its package.json says, when the package is installed.
    info: Option<PackageInfo>,
    /// The index of each component it depends on.
    depends_on: Vec<(usize, EdgeKind)>,
}

/// Why a package depends on another. Of two edges to one package, the lesser one stands.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum EdgeKind {
    Required,
    Peer,
    Optional,
    Dev,
}

impl EdgeKind {
    fn of(behavior: Behavior) -> EdgeKind {
        if behavior.is_dev() {
            EdgeKind::Dev
        } else if behavior.contains(Behavior::OPTIONAL) {
            EdgeKind::Optional
        } else if behavior.is_peer() {
            EdgeKind::Peer
        } else {
            EdgeKind::Required
        }
    }
}

impl Component {
    /// `@scope` and `name` of `@scope/name`.
    fn group_and_name(&self) -> (Option<&[u8]>, &[u8]) {
        if self.name.starts_with(b"@")
            && let Some(slash) = strings::index_of_char_usize(&self.name, b'/')
        {
            return (Some(&self.name[..slash]), &self.name[slash + 1..]);
        }
        (None, &self.name)
    }

    /// https://github.com/package-url/purl-spec. `None` for a package that only this project has.
    fn purl(&self) -> Option<Vec<u8>> {
        let mut purl: Vec<u8> = b"pkg:npm/".to_vec();
        let (group, name) = self.group_and_name();
        if let Some(group) = group {
            percent_encode(&mut purl, group, b"");
            purl.push(b'/');
        }
        percent_encode(&mut purl, name, b"");
        if let Some(version) = &self.version {
            purl.push(b'@');
            percent_encode(&mut purl, version, b"");
        }

        match &self.origin {
            Origin::Local => {
                // A workspace that can be published is the npm package of its name.
                let info = self.info.as_ref()?;
                if info.private || self.version.is_none() {
                    return None;
                }
            }
            Origin::Registry(_) => {}
            Origin::RemoteTarball(url) => {
                purl.extend_from_slice(b"?download_url=");
                percent_encode(&mut purl, url, b"/");
            }
            Origin::Git { .. } | Origin::Github { .. } => {
                purl.extend_from_slice(b"?vcs_url=");
                percent_encode(&mut purl, &self.vcs_url()?, b"/");
            }
        }
        Some(purl)
    }

    /// `git+https://host/owner/repo.git@<commit>`, the form SPDX and the package URL take.
    fn vcs_url(&self) -> Option<Vec<u8>> {
        let (repository, commit) = match &self.origin {
            Origin::Git { url, commit } => (url.to_vec(), commit),
            Origin::Github {
                owner,
                repo,
                commit,
            } => {
                let parts: [&[u8]; 5] = [b"https://github.com/", owner, b"/", repo, b".git"];
                (parts.concat(), commit)
            }
            _ => return None,
        };
        let mut vcs_url: Vec<u8> = b"git+".to_vec();
        vcs_url.extend_from_slice(&repository);
        if !commit.is_empty() {
            vcs_url.push(b'@');
            vcs_url.extend_from_slice(commit);
        }
        Some(vcs_url).filter(|url| is_url(url))
    }

    /// Where the package can be downloaded, for the origins that have one place.
    fn download_url(&self) -> Option<&[u8]> {
        match &self.origin {
            Origin::Registry(url) | Origin::RemoteTarball(url) => {
                Some(&url[..]).filter(|url| is_url(url))
            }
            _ => None,
        }
    }

    /// The repository: of the resolution for a git dependency, else what package.json names.
    fn repository_url(&self) -> Option<Vec<u8>> {
        match &self.origin {
            Origin::Git { url, .. } => Some(url.to_vec()).filter(|url| is_url(url)),
            Origin::Github { owner, repo, .. } => {
                let parts: [&[u8]; 4] = [b"https://github.com/", owner, b"/", repo];
                Some(parts.concat()).filter(|url| is_url(url))
            }
            _ => repository_url(self.info.as_ref()?.repository.as_ref()?),
        }
    }

    fn info_url(&self, field: fn(&PackageInfo) -> &Option<Box<[u8]>>) -> Option<&[u8]> {
        field(self.info.as_ref()?)
            .as_deref()
            .filter(|url| is_url(url))
    }

    /// The directory of the package below the project, with `/`. Empty for the project itself.
    fn path(&self, top_level_dir: &[u8]) -> Option<Vec<u8>> {
        let dir = &self.info.as_ref()?.path;
        let top_level_dir = strings::without_trailing_slash(top_level_dir);
        let relative = dir.strip_prefix(top_level_dir)?;
        let mut relative = relative.to_vec();
        bun_paths::resolve_path::platform_to_posix_in_place(&mut relative[..]);
        let start = relative.iter().take_while(|&&c| c == b'/').count();
        Some(relative.split_off(start))
    }
}

/// Escapes all but letters, digits, `-._~:` and the bytes of `keep`, as a package URL has it.
fn percent_encode(out: &mut Vec<u8>, text: &[u8], keep: &[u8]) {
    for &byte in text {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~' | b':')
            || strings::contains_char(keep, byte)
        {
            out.push(byte);
        } else {
            let [high, low] = bun_core::fmt::hex_byte_upper(byte);
            out.extend_from_slice(&[b'%', high, low]);
        }
    }
}

/// Whether `text` is a `scheme://` URL that the `iri-reference` format of both schemas takes.
fn is_url(text: &[u8]) -> bool {
    let Some(scheme_len) = strings::index_of(text, b"://") else {
        return false;
    };
    let (scheme, rest) = (&text[..scheme_len], &text[scheme_len + 3..]);
    let authority = &rest[..strings::index_of_any(rest, b"/?#").unwrap_or(rest.len())];
    let host = &authority[strings::last_index_of_char(authority, b'@').map_or(0, |at| at + 1)..];
    let port = strings::index_of_char_usize(host, b':').map_or(&b""[..], |at| &host[at + 1..]);
    !rest.is_empty()
        && scheme.first().is_some_and(u8::is_ascii_alphabetic)
        && (scheme.iter())
            .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
        && port.iter().all(u8::is_ascii_digit)
        && strings::count_char(rest, b'#') <= 1
        && rest.iter().enumerate().all(|(at, &byte)| match byte {
            b'%' => {
                (rest.get(at + 1..at + 3)).is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            }
            0..=b' ' | 0x7f | b'"' | b'<' | b'>' | b'[' | b'\\' | b']' | b'^' | b'`' => false,
            b'{' | b'|' | b'}' => false,
            _ => true,
        })
}

/// `url` without the user and password of its host. A lockfile can have them.
fn without_credentials(url: &[u8]) -> Vec<u8> {
    let Some(scheme_len) = strings::index_of(url, b"://") else {
        return url.to_vec();
    };
    let rest = &url[scheme_len + 3..];
    let authority = &rest[..strings::index_of_any(rest, b"/?#").unwrap_or(rest.len())];
    match strings::last_index_of_char(authority, b'@') {
        Some(at) => [&url[..scheme_len + 3], &rest[at + 1..]].concat(),
        None => url.to_vec(),
    }
}

/// The `repository` of a package.json as a URL. It can be `owner/repo` or `git@host:path`.
fn repository_url(repository: &[u8]) -> Option<Vec<u8>> {
    let url = if strings::contains(repository, b"://") {
        repository.to_vec()
    } else if let Some(colon) = strings::index_of_char_usize(repository, b':') {
        let host = &repository[..colon];
        if !strings::contains_char(host, b'.')
            && !matches!(host, b"github" | b"gitlab" | b"bitbucket")
        {
            return None;
        }
        Repository::try_https(repository)?
    } else {
        // `owner/repo` is a repository on GitHub.
        let slash = strings::index_of_char_usize(repository, b'/')?;
        if slash == 0 || strings::contains_char(&repository[slash + 1..], b'/') {
            return None;
        }
        [b"https://github.com/", repository].concat()
    };
    Some(without_credentials(&url)).filter(|url| is_url(url))
}

/// What the license of a package.json is to the formats.
enum License {
    /// One identifier of the SPDX list, in the spelling of the list.
    Id(&'static [u8]),
    /// A valid SPDX expression of more than one identifier.
    Expression(Vec<u8>),
    /// Any other text: `SEE LICENSE IN LICENSE.md`, `UNLICENSED`, a misspelt identifier.
    Name(Box<[u8]>),
}

/// The SPDX identifiers by their lowercase spelling. The list matches without regard to case.
struct SpdxIds {
    licenses: StringHashMap<&'static [u8]>,
    exceptions: StringHashMap<&'static [u8]>,
}

impl SpdxIds {
    fn load() -> SpdxIds {
        let mut ids = SpdxIds {
            licenses: StringHashMap::default(),
            exceptions: StringHashMap::default(),
        };
        let mut in_exceptions = false;
        for line in strings::split(SPDX_LICENSE_IDS, b"\n") {
            if line.is_empty() {
                in_exceptions = true;
                continue;
            }
            let map = if in_exceptions {
                &mut ids.exceptions
            } else {
                &mut ids.licenses
            };
            let _ = map.put(&line.to_ascii_lowercase(), line);
        }
        ids
    }

    fn classify(&self, text: &[u8]) -> License {
        let mut parser = ExpressionParser {
            ids: self,
            tokens: tokenize(text),
            at: 0,
            out: Vec::new(),
            licenses: 0,
            only: None,
            depth: 0,
        };
        if parser.expression().is_none() || parser.at != parser.tokens.len() {
            return License::Name(text.into());
        }
        match (parser.licenses, parser.only) {
            (1, Some(id)) => License::Id(id),
            _ => License::Expression(parser.out),
        }
    }
}

/// Words, `(` and `)`.
fn tokenize(text: &[u8]) -> Vec<&[u8]> {
    let mut tokens: Vec<&[u8]> = Vec::new();
    for word in text.split(|byte| byte.is_ascii_whitespace()) {
        let mut rest = word;
        while !rest.is_empty() {
            let len = if matches!(rest[0], b'(' | b')') {
                1
            } else {
                strings::index_of_any(rest, b"()").unwrap_or(rest.len())
            };
            tokens.push(&rest[..len]);
            rest = &rest[len..];
        }
    }
    tokens
}

/// SPDX 2.3 Annex D: `WITH` binds tighter than `AND`, then `OR`. `out` has the list's spelling.
struct ExpressionParser<'a> {
    ids: &'a SpdxIds,
    tokens: Vec<&'a [u8]>,
    at: usize,
    out: Vec<u8>,
    licenses: usize,
    /// The one identifier of an expression that is nothing else, parentheses aside.
    only: Option<&'static [u8]>,
    depth: usize,
}

impl ExpressionParser<'_> {
    fn take(&mut self, word: &[u8]) -> bool {
        let found = self.tokens.get(self.at).is_some_and(|token| *token == word);
        if found {
            self.at += 1;
        }
        found
    }

    fn expression(&mut self) -> Option<()> {
        self.operands(b"OR", Self::conjunction)
    }

    fn conjunction(&mut self) -> Option<()> {
        self.operands(b"AND", Self::with_exception)
    }

    fn operands(&mut self, operator: &[u8], operand: fn(&mut Self) -> Option<()>) -> Option<()> {
        operand(self)?;
        while self.take(operator) {
            self.only = None;
            self.out.push(b' ');
            self.out.extend_from_slice(operator);
            self.out.push(b' ');
            operand(self)?;
        }
        Some(())
    }

    fn with_exception(&mut self) -> Option<()> {
        if self.take(b"(") {
            // The text is of any installed package, and each `(` is a stack frame.
            self.depth += 1;
            if self.depth > 32 {
                return None;
            }
            self.out.push(b'(');
            self.expression()?;
            if !self.take(b")") {
                return None;
            }
            self.depth -= 1;
            self.out.push(b')');
            return Some(());
        }
        self.license()?;
        if self.take(b"WITH") {
            let exception = *self.tokens.get(self.at)?;
            let id = *(self.ids.exceptions).get(&exception.to_ascii_lowercase()[..])?;
            self.at += 1;
            self.only = None;
            self.out.extend_from_slice(b" WITH ");
            self.out.extend_from_slice(id);
        }
        Some(())
    }

    fn license(&mut self) -> Option<()> {
        let word = *self.tokens.get(self.at)?;
        self.at += 1;
        self.licenses += 1;
        self.only = None;
        if let Some(&id) = self.ids.licenses.get(&word.to_ascii_lowercase()[..]) {
            self.out.extend_from_slice(id);
            self.only = Some(id);
            return Some(());
        }
        // `GPL-2.0+` is on the list. `MIT+` is not: "this version or a later one".
        if let Some(&id) = word
            .strip_suffix(b"+")
            .and_then(|word| self.ids.licenses.get(&word.to_ascii_lowercase()[..]))
        {
            self.out.extend_from_slice(id);
            self.out.push(b'+');
            return Some(());
        }
        // A license that the document itself would have to define.
        let reference = match strings::index_of_char_usize(word, b':') {
            Some(colon) if is_reference(&word[..colon], b"DocumentRef-") => &word[colon + 1..],
            Some(_) => return None,
            None => word,
        };
        if !is_reference(reference, b"LicenseRef-") {
            return None;
        }
        self.out.extend_from_slice(word);
        Some(())
    }
}

fn is_reference(word: &[u8], prefix: &[u8]) -> bool {
    word.strip_prefix(prefix).is_some_and(|id| {
        !id.is_empty()
            && (id.iter()).all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    })
}

/// The parts of `Name <email> (url)`. A site between the `<>` is not an email.
fn author_name_and_email(author: &[u8]) -> (&[u8], Option<&[u8]>) {
    let name_end = strings::index_of_any(author, b"<(").unwrap_or(author.len());
    let name = strings::trim(&author[..name_end], &strings::WHITESPACE_CHARS);
    let email = strings::index_of_char_usize(author, b'<').and_then(|open| {
        let rest = &author[open + 1..];
        let email = &rest[..strings::index_of_char_usize(rest, b'>')?];
        let at = strings::index_of_char_usize(email, b'@')?;
        let plain = strings::count_char(email, b'@') == 1
            && (email.iter()).all(|&byte| {
                byte > b' ' && byte != 0x7f && !matches!(byte, b':' | b'/' | b'(' | b')')
            });
        (plain && at > 0 && at + 1 < email.len()).then_some(email)
    });
    (name, email)
}

/// Pretty-printed JSON, two spaces deep. Keeps track of the commas.
struct Json {
    out: Vec<u8>,
    /// For each open object or array, whether it has a member.
    has_member: Vec<bool>,
    after_key: bool,
}

impl Json {
    fn new() -> Json {
        Json {
            out: Vec::new(),
            has_member: Vec::new(),
            after_key: false,
        }
    }

    fn line(&mut self) {
        self.out.push(b'\n');
        for _ in 0..self.has_member.len() {
            self.out.extend_from_slice(b"  ");
        }
    }

    fn before_value(&mut self) {
        if core::mem::take(&mut self.after_key) {
            return;
        }
        if let Some(has_member) = self.has_member.last_mut() {
            if core::mem::replace(has_member, true) {
                self.out.push(b',');
            }
            self.line();
        }
    }

    fn key(&mut self, key: &str) -> &mut Json {
        self.before_value();
        let _ = write!(self.out, "\"{key}\": ");
        self.after_key = true;
        self
    }

    fn string(&mut self, text: &[u8]) -> &mut Json {
        self.before_value();
        let _ = write!(
            self.out,
            "{}",
            bun_core::fmt::format_json_string_utf8(text, Default::default())
        );
        self
    }

    /// A number, `true` or `false`.
    fn literal(&mut self, text: &str) -> &mut Json {
        self.before_value();
        self.out.extend_from_slice(text.as_bytes());
        self
    }

    fn open(&mut self, bracket: u8) -> &mut Json {
        self.before_value();
        self.out.push(bracket);
        self.has_member.push(false);
        self
    }

    fn close(&mut self, bracket: u8) -> &mut Json {
        if self.has_member.pop() == Some(true) {
            self.line();
        }
        self.out.push(bracket);
        self
    }

    fn field(&mut self, key: &str, text: &[u8]) -> &mut Json {
        self.key(key).string(text)
    }
}

/// The commit of a git dependency. A lockfile from yarn or pnpm has only the committish.
fn revision<'a>(repository: &'a Repository, buf: &'a [u8]) -> &'a [u8] {
    match repository.resolved_commit(buf) {
        b"" => repository.committish.slice(buf),
        commit => commit,
    }
}

pub(crate) struct PmSbomCommand;

impl PmSbomCommand {
    pub(crate) fn exec(
        pm: &mut PackageManager,
        positionals: &[&[u8]],
        flags: SbomFlags,
    ) -> crate::Result<()> {
        let log_level = pm.options.log_level;
        let not_silent = log_level != LogLevel::Silent;

        if positionals.len() > 1 {
            if not_silent {
                Output::err_generic("bun pm sbom does not take arguments", ());
                bun_core::note!("--production and --omit choose what is listed");
            }
            Global::exit(1);
        }
        let format = match flags.format {
            None | Some(b"cyclonedx") => Format::CycloneDx,
            Some(b"spdx") => Format::Spdx,
            Some(other) => {
                if not_silent {
                    Output::err_generic(
                        "--sbom-format must be \"cyclonedx\" or \"spdx\", not \"{}\"",
                        (bun_core::fmt::escape_control_chars(other),),
                    );
                }
                Global::exit(1);
            }
        };
        let project_type = match flags.project_type {
            None | Some(b"library") => ProjectType::Library,
            Some(b"application") => ProjectType::Application,
            Some(b"framework") => ProjectType::Framework,
            Some(other) => {
                if not_silent {
                    Output::err_generic(
                        "--sbom-type must be \"library\", \"application\" or \"framework\", not \"{}\"",
                        (bun_core::fmt::escape_control_chars(other),),
                    );
                }
                Global::exit(1);
            }
        };

        let configured_linker = pm.options.node_linker;
        let load = pm.load_lockfile_from_cwd::<true>();
        PackageManagerCommand::handle_load_lockfile_errors_for(&load, log_level, "list");
        let isolated = load.node_linker(&pm.lockfile, configured_linker) == NodeLinker::Isolated;

        let features = pm.options.local_package_features;
        let lockfile: &Lockfile = &pm.lockfile;
        let root = pm.root_package_id.get(lockfile, pm.workspace_name_hash);
        // A workspace that the lockfile does not have comes back as the root.
        let workspace_is_missing = root == 0 && pm.workspace_name_hash.is_some();
        if (root as usize) >= lockfile.packages.len() || workspace_is_missing {
            if not_silent {
                Output::err_generic(
                    "the package.json of this directory is not in the lockfile",
                    (),
                );
                bun_core::note!("run 'bun install' first");
            }
            Global::exit(1);
        }

        // What `bun install` links with the same `--production`, `--omit`, `--cpu` and `--os`.
        let options = reachable::Options {
            root: 0,
            dev: features.dev_dependencies,
            optional: features.optional_dependencies,
            peer: features.peer_dependencies,
            optional_peer: features.peer_dependencies,
            bundled: true,
            platform: Some((pm.options.cpu, pm.options.os, pm.options.libc)),
        };
        let resolutions = lockfile.buffers.resolutions.as_slice();
        let reach = |dev: bool, optional: bool| {
            let options = reachable::Options {
                dev: options.dev && dev,
                optional: options.optional && optional,
                optional_peer: options.optional_peer && optional,
                ..options
            };
            reachable::packages_from(lockfile, resolutions, &[root], true, options)
        };
        let wanted = reach(true, true);
        let without_dev = reach(false, true);
        let without_optional = reach(true, false);
        let without_both = reach(false, false);

        let packages = lockfile.packages.slice();
        let pkg_names = packages.items_name();
        let pkg_resolutions = packages.items_resolution();
        let pkg_metas = packages.items_meta();
        let buf = lockfile.buffers.string_bytes.as_slice();

        let mut installed = InstalledPackages::init(isolated);
        let has_node_modules = installed.has_node_modules();
        let mut components: Vec<Component> = Vec::new();
        let mut missing: usize = 0;

        for package_id in 0..packages.len() {
            if !wanted.is_set(package_id) {
                continue;
            }
            let resolution = &pkg_resolutions[package_id];
            let mut resolved: Vec<u8> = Vec::new();
            let _ = write!(&mut resolved, "{}", resolution.fmt(buf, PathSep::Posix));

            let origin = match resolution.tag {
                ResolutionTag::Npm => {
                    Origin::Registry(without_credentials(resolution.npm().url.slice(buf)).into())
                }
                ResolutionTag::RemoteTarball => Origin::RemoteTarball(
                    without_credentials(resolution.remote_tarball().slice(buf)).into(),
                ),
                ResolutionTag::Git => {
                    let repository = resolution.git();
                    let repo = repository.repo.slice(buf);
                    // bun.lock has `git@host:path` as `ssh://git@host:path`, which `try_ssh` mends.
                    let mended = Repository::try_ssh(repo).unwrap_or_else(|| repo.to_vec());
                    let url = Repository::try_https(&mended).unwrap_or(mended);
                    Origin::Git {
                        url: without_credentials(&url).into(),
                        commit: revision(repository, buf).into(),
                    }
                }
                ResolutionTag::Github => {
                    let repository = resolution.github();
                    Origin::Github {
                        owner: repository.owner.slice(buf).into(),
                        repo: repository.repo.slice(buf).into(),
                        commit: revision(repository, buf).into(),
                    }
                }
                _ => Origin::Local,
            };
            let info = match resolution.tag {
                ResolutionTag::Root => installed.read_at(b""),
                ResolutionTag::Workspace => installed.read_at(resolution.workspace().slice(buf)),
                _ => {
                    let info = installed.read(lockfile, package_id, &resolved);
                    missing += usize::from(info.is_none());
                    info
                }
            };

            let mut name: &[u8] = pkg_names[package_id].slice(buf);
            if name.is_empty() && package_id == root as usize {
                // A project without a name is called after its directory, as npm has it.
                name = bun_paths::basename(strings::without_trailing_slash(
                    bun_resolver::fs::FileSystem::get().top_level_dir(),
                ));
            }
            if name.is_empty() {
                name = b"unnamed";
            }
            let name: Box<[u8]> = name.into();
            let version: Option<Box<[u8]>> = if resolution.tag == ResolutionTag::Npm {
                Some(resolved.as_slice().into())
            } else {
                info.as_ref().and_then(|info| info.version.clone())
            };

            let mut bom_ref = name.to_vec();
            match resolution.tag {
                ResolutionTag::Root => {
                    if let Some(version) = &version {
                        bom_ref.push(b'@');
                        bom_ref.extend_from_slice(version);
                    }
                }
                _ => {
                    bom_ref.push(b'@');
                    bom_ref.extend_from_slice(&without_credentials(&resolved));
                }
            }

            let integrity = pkg_metas[package_id].integrity();
            let dev = !without_dev.is_set(package_id);
            components.push(Component {
                package_id: package_id as PackageID,
                bom_ref,
                name,
                version,
                origin,
                hash: (integrity.tag.name()).map(|algorithm| (algorithm, integrity.slice().into())),
                dev,
                // As in `npm sbom`, optional too when a dev path and an optional path lead to it.
                optional: !without_optional.is_set(package_id)
                    || (!dev && !without_both.is_set(package_id)),
                info,
                depends_on: Vec::new(),
            });
        }

        // The project first, then by name and version, so that two runs give the same order.
        components.sort_by(|a, b| {
            (b.package_id == root)
                .cmp(&(a.package_id == root))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.bom_ref.cmp(&b.bom_ref))
        });
        let mut index_of: Vec<usize> = vec![usize::MAX; packages.len()];
        let mut seen_refs: StringHashMap<()> = StringHashMap::default();
        for (index, component) in components.iter_mut().enumerate() {
            index_of[component.package_id as usize] = index;
            // Two resolutions print the same only for a project that is named like a dependency.
            while seen_refs.contains_key(&component.bom_ref[..]) {
                component.bom_ref.extend_from_slice(b"#");
            }
            let _ = seen_refs.put(&component.bom_ref, ());
        }
        for index in 0..components.len() {
            let mut depends_on: Vec<(usize, EdgeKind)> = Vec::new();
            for (target, behavior) in reachable::edges_from(
                lockfile,
                resolutions,
                components[index].package_id,
                true,
                options,
            ) {
                let Some(&target) = index_of
                    .get(target as usize)
                    .filter(|&&at| at != usize::MAX)
                else {
                    continue;
                };
                if target == index {
                    continue;
                }
                let kind = EdgeKind::of(behavior);
                match depends_on.iter_mut().find(|(seen, _)| *seen == target) {
                    Some((_, kept)) => *kept = kind.min(*kept),
                    None => depends_on.push((target, kind)),
                }
            }
            depends_on.sort_by_key(|&(target, _)| target);
            components[index].depends_on = depends_on;
        }

        let document = Document {
            components: &components,
            project_type,
            has_node_modules,
            top_level_dir: bun_resolver::fs::FileSystem::get().top_level_dir(),
            spdx_ids: SpdxIds::load(),
        };
        let mut json = Json::new();
        match format {
            Format::CycloneDx => document.write_cyclonedx(&mut json),
            Format::Spdx => document.write_spdx(&mut json),
        }
        json.out.push(b'\n');
        let _ = Output::writer().write_all(&json.out);
        Output::flush();

        if missing > 0 && not_silent {
            bun_core::warn!(
                "{} package{} in the lockfile {} not installed, so the document has no license, author or description for {}",
                missing,
                if missing == 1 { "" } else { "s" },
                if missing == 1 { "is" } else { "are" },
                if missing == 1 { "it" } else { "them" },
            );
            bun_core::note!("run 'bun install' first");
            Output::flush();
        }
        Ok(())
    }
}

struct Document<'a> {
    /// The project is the first one.
    components: &'a [Component],
    project_type: ProjectType,
    has_node_modules: bool,
    top_level_dir: &'a [u8],
    spdx_ids: SpdxIds,
}

/// `2026-10-15T12:00:00Z`, the form both formats take.
fn timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (year, month, day) = crate::shell::builtins::ls::civil_from_days((seconds / 86_400) as i64);
    let second_of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second_of_day / 3600,
        (second_of_day / 60) % 60,
        second_of_day % 60,
    )
}

impl Document<'_> {
    fn license_of(&self, component: &Component) -> Option<License> {
        let license = &component.info.as_ref()?.license;
        (license[..] != *UNKNOWN_LICENSE).then(|| self.spdx_ids.classify(license))
    }

    // ── CycloneDX 1.6: https://cyclonedx.org/docs/1.6/json/ ─────────────────────────

    fn write_cyclonedx(&self, json: &mut Json) {
        let project = &self.components[0];

        json.open(b'{');
        json.field(
            "$schema",
            b"http://cyclonedx.org/schema/bom-1.6.schema.json",
        );
        json.field("bomFormat", b"CycloneDX");
        json.field("specVersion", b"1.6");
        let serial_number = format!("urn:uuid:{}", bun_jsc::uuid::UUID::init());
        json.field("serialNumber", serial_number.as_bytes());
        json.key("version").literal("1");

        json.key("metadata").open(b'{');
        json.field("timestamp", timestamp().as_bytes());
        // A document that was made from the lockfile alone says so.
        json.key("lifecycles").open(b'[').open(b'{');
        json.field(
            "phase",
            if self.has_node_modules {
                b"build".as_slice()
            } else {
                b"pre-build"
            },
        );
        json.close(b'}').close(b']');
        json.key("tools").open(b'{');
        json.key("components").open(b'[').open(b'{');
        json.field("type", b"application");
        json.field("name", b"bun");
        json.field("version", Global::package_json_version.as_bytes());
        json.close(b'}').close(b']');
        json.close(b'}');
        json.key("component");
        self.write_cyclonedx_component(json, project, self.project_type.cyclonedx());
        json.close(b'}');

        json.key("components").open(b'[');
        for component in &self.components[1..] {
            self.write_cyclonedx_component(json, component, "library");
        }
        json.close(b']');

        json.key("dependencies").open(b'[');
        for component in self.components {
            json.open(b'{');
            json.field("ref", &component.bom_ref);
            json.key("dependsOn").open(b'[');
            for &(target, _) in &component.depends_on {
                json.string(&self.components[target].bom_ref);
            }
            json.close(b']');
            json.close(b'}');
        }
        json.close(b']');
        json.close(b'}');
    }

    fn write_cyclonedx_component(&self, json: &mut Json, component: &Component, kind: &str) {
        let info = component.info.as_ref();
        let (group, name) = component.group_and_name();

        json.open(b'{');
        json.field("bom-ref", &component.bom_ref);
        json.field("type", kind.as_bytes());
        if let Some(group) = group {
            json.field("group", group);
        }
        json.field("name", name);
        if let Some(version) = &component.version {
            json.field("version", version);
        }
        json.field(
            "scope",
            if component.optional {
                b"optional".as_slice()
            } else {
                b"required"
            },
        );
        if let Some(description) = info.and_then(|info| info.description.as_ref()) {
            json.field("description", description);
        }
        let (author, email) = info
            .and_then(|info| info.author.as_ref())
            .map_or((&b""[..], None), |author| author_name_and_email(author));
        if !author.is_empty() || email.is_some() {
            json.key("authors").open(b'[').open(b'{');
            if !author.is_empty() {
                json.field("name", author);
            }
            if let Some(email) = email {
                json.field("email", email);
            }
            json.close(b'}').close(b']');
        }
        if let Some(license) = self.license_of(component) {
            json.key("licenses").open(b'[').open(b'{');
            match &license {
                License::Id(id) => {
                    json.key("license").open(b'{').field("id", id).close(b'}');
                }
                License::Expression(expression) => {
                    json.field("expression", expression);
                }
                License::Name(name) => {
                    json.key("license")
                        .open(b'{')
                        .field("name", name)
                        .close(b'}');
                }
            }
            json.close(b'}').close(b']');
        }
        if let Some(purl) = component.purl() {
            json.field("purl", &purl);
        }
        if let Some((algorithm, digest)) = &component.hash {
            json.key("hashes").open(b'[').open(b'{');
            json.field(
                "alg",
                match *algorithm {
                    "sha1" => b"SHA-1".as_slice(),
                    "sha256" => b"SHA-256",
                    "sha384" => b"SHA-384",
                    _ => b"SHA-512",
                },
            );
            json.field("content", hex(digest).as_bytes());
            json.close(b'}').close(b']');
        }

        let references: [(&str, Option<Vec<u8>>); 4] = [
            ("distribution", component.download_url().map(<[u8]>::to_vec)),
            ("vcs", component.repository_url()),
            (
                "website",
                (component.info_url(|info| &info.homepage)).map(<[u8]>::to_vec),
            ),
            (
                "issue-tracker",
                (component.info_url(|info| &info.bugs)).map(<[u8]>::to_vec),
            ),
        ];
        if references.iter().any(|(_, url)| url.is_some()) {
            json.key("externalReferences").open(b'[');
            for (kind, url) in &references {
                if let Some(url) = url {
                    json.open(b'{');
                    json.field("type", kind.as_bytes());
                    json.field("url", url);
                    json.close(b'}');
                }
            }
            json.close(b']');
        }

        // https://github.com/CycloneDX/cyclonedx-property-taxonomy/blob/main/cdx/npm.md
        let path = component.path(self.top_level_dir);
        let properties: [(&str, Option<&[u8]>); 3] = [
            ("cdx:npm:package:path", path.as_deref()),
            (
                "cdx:npm:package:development",
                component.dev.then_some(b"true".as_slice()),
            ),
            (
                "cdx:npm:package:private",
                (info.is_some_and(|info| info.private)).then_some(b"true".as_slice()),
            ),
        ];
        if properties.iter().any(|(_, value)| value.is_some()) {
            json.key("properties").open(b'[');
            for (name, value) in properties {
                if let Some(value) = value {
                    json.open(b'{');
                    json.field("name", name.as_bytes());
                    json.field("value", value);
                    json.close(b'}');
                }
            }
            json.close(b']');
        }
        json.close(b'}');
    }

    // ── SPDX 2.3: https://spdx.github.io/spdx-spec/v2.3/ ────────────────────────────

    fn write_spdx(&self, json: &mut Json) {
        let project = &self.components[0];
        let ids = self.spdx_element_ids();

        json.open(b'{');
        json.field("spdxVersion", b"SPDX-2.3");
        json.field("dataLicense", b"CC0-1.0");
        json.field("SPDXID", b"SPDXRef-DOCUMENT");
        json.field("name", &project.bom_ref);
        let mut namespace = b"http://spdx.org/spdxdocs/".to_vec();
        spdx_id_characters(&mut namespace, &project.bom_ref);
        let _ = write!(namespace, "-{}", bun_jsc::uuid::UUID::init());
        json.field("documentNamespace", &namespace);
        json.key("creationInfo").open(b'{');
        json.field("created", timestamp().as_bytes());
        json.key("creators").open(b'[');
        let creator = format!("Tool: bun-{}", Global::package_json_version);
        json.string(creator.as_bytes());
        json.close(b']');
        json.close(b'}');
        json.key("documentDescribes")
            .open(b'[')
            .string(&ids[0])
            .close(b']');

        json.key("packages").open(b'[');
        for (index, component) in self.components.iter().enumerate() {
            let info = component.info.as_ref();
            json.open(b'{');
            json.field("name", &component.name);
            json.field("SPDXID", &ids[index]);
            if let Some(version) = &component.version {
                json.field("versionInfo", version);
            }
            if let Some(path) = component
                .path(self.top_level_dir)
                .filter(|path| !path.is_empty())
            {
                json.field("packageFileName", &path);
            }
            if let Some(description) = info.and_then(|info| info.description.as_ref()) {
                json.field("description", description);
            }
            if let Some(author) = info.and_then(|info| info.author.as_ref()) {
                let (name, email) = author_name_and_email(author);
                if !name.is_empty() {
                    let mut originator = b"Person: ".to_vec();
                    originator.extend_from_slice(name);
                    if let Some(email) = email {
                        originator.extend_from_slice(b" (");
                        originator.extend_from_slice(email);
                        originator.push(b')');
                    }
                    json.field("originator", &originator);
                }
            }
            if index == 0 {
                json.field("primaryPackagePurpose", self.project_type.spdx().as_bytes());
            }
            // A URL, or the `git+<url>@<commit>` that SPDX has for a repository.
            let location = (component.download_url().map(<[u8]>::to_vec))
                .or_else(|| component.vcs_url().filter(|url| is_url(url)));
            json.field(
                "downloadLocation",
                location.as_deref().unwrap_or(b"NOASSERTION"),
            );
            json.key("filesAnalyzed").literal("false");
            json.field(
                "homepage",
                (component.info_url(|info| &info.homepage)).unwrap_or(b"NOASSERTION"),
            );
            match self.license_of(component) {
                Some(License::Id(id)) => {
                    json.field("licenseDeclared", id);
                }
                // A `LicenseRef-` has to be defined in the document, and this one defines none.
                Some(License::Expression(expression))
                    if !strings::contains(&expression, b"LicenseRef-") =>
                {
                    json.field("licenseDeclared", &expression);
                }
                // SPDX takes an expression or nothing here. The text is kept as a comment.
                Some(License::Expression(text)) => {
                    json.field("licenseDeclared", b"NOASSERTION");
                    json.field("licenseComments", &text);
                }
                Some(License::Name(text)) => {
                    json.field("licenseDeclared", b"NOASSERTION");
                    json.field("licenseComments", &text);
                }
                None => {
                    json.field("licenseDeclared", b"NOASSERTION");
                }
            }
            if let Some(purl) = component.purl() {
                json.key("externalRefs").open(b'[').open(b'{');
                json.field("referenceCategory", b"PACKAGE-MANAGER");
                json.field("referenceType", b"purl");
                json.field("referenceLocator", &purl);
                json.close(b'}').close(b']');
            }
            // bun.lock has the hash of the GitHub API tarball, which the git location does not give.
            if let Some((algorithm, digest)) = &component.hash
                && !matches!(component.origin, Origin::Github { .. })
            {
                json.key("checksums").open(b'[').open(b'{');
                json.field("algorithm", algorithm.to_ascii_uppercase().as_bytes());
                json.field("checksumValue", hex(digest).as_bytes());
                json.close(b'}').close(b']');
            }
            json.close(b'}');
        }
        json.close(b']');

        json.key("relationships").open(b'[');
        let relationship = |json: &mut Json, from: &[u8], kind: &str, to: &[u8]| {
            json.open(b'{');
            json.field("spdxElementId", from);
            json.field("relatedSpdxElement", to);
            json.field("relationshipType", kind.as_bytes());
            json.close(b'}');
        };
        relationship(json, b"SPDXRef-DOCUMENT", "DESCRIBES", &ids[0]);
        for (index, component) in self.components.iter().enumerate() {
            for &(target, kind) in &component.depends_on {
                let (parent, dependency) = (&ids[index], &ids[target]);
                match kind {
                    EdgeKind::Required => relationship(json, parent, "DEPENDS_ON", dependency),
                    EdgeKind::Peer => relationship(json, parent, "HAS_PREREQUISITE", dependency),
                    EdgeKind::Optional => {
                        relationship(json, dependency, "OPTIONAL_DEPENDENCY_OF", parent);
                    }
                    EdgeKind::Dev => relationship(json, dependency, "DEV_DEPENDENCY_OF", parent),
                }
            }
        }
        json.close(b']');
        json.close(b'}');
    }

    /// `SPDXRef-Package-<name>-<version>` for each component. Two names can come out the same.
    fn spdx_element_ids(&self) -> Vec<Vec<u8>> {
        let mut seen: StringHashMap<()> = StringHashMap::default();
        let mut ids: Vec<Vec<u8>> = Vec::with_capacity(self.components.len());
        for component in self.components {
            let mut id = b"SPDXRef-Package-".to_vec();
            spdx_id_characters(&mut id, &component.bom_ref);
            let len = id.len();
            let mut copy = 1;
            while seen.contains_key(&id[..]) {
                copy += 1;
                id.truncate(len);
                let _ = write!(id, "-{copy}");
            }
            let _ = seen.put(&id, ());
            ids.push(id);
        }
        ids
    }
}

/// `@scope/name@1.0.0` as `scope-name-1.0.0`.
fn spdx_id_characters(out: &mut Vec<u8>, text: &[u8]) {
    let start = out.len();
    for &byte in text {
        if byte.is_ascii_alphanumeric() || byte == b'.' {
            out.push(byte);
        } else if out.len() > start && out[out.len() - 1] != b'-' {
            out.push(b'-');
        }
    }
    if out.len() > start && out[out.len() - 1] == b'-' {
        out.pop();
    }
}

fn hex(bytes: &[u8]) -> String {
    bun_core::fmt::hex_lower(bytes).to_string()
}
