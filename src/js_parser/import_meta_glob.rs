#![warn(unused_must_use)]
//! `import.meta.glob(patterns, options?)`, Vite's glob import.
//!
//! The call is replaced during the visit pass with an object literal that maps
//! each matched file to `() => import("./file")`, or with `eager: true` to a
//! binding of a generated `import` statement. Everything after that (resolving,
//! bundling, code splitting, tree shaking) sees ordinary imports.

use bun_alloc::ArenaVecExt as _;
use bun_ast::{self as js_ast, E, Expr, G, ImportKind, LocRef, S, Stmt};
use bun_collections::VecExt;
use bun_core::strings;
use bun_paths::resolve_path::{self, platform};

use crate::p::P;
use crate::parser::{Ref, TransposeState};

struct Pattern<'a> {
    text: &'a [u8],
    loc: bun_ast::Loc,
}

struct Options<'a> {
    eager: bool,
    exhaustive: bool,
    /// `import: "name"`. `None` gives the module namespace.
    import: Option<&'a [u8]>,
    /// Appended to every specifier. Empty, or starts with `?`.
    query: &'a [u8],
    base: Option<&'a [u8]>,
    /// `{ with: { ... } }`, the second argument of each generated `import()`.
    import_options: Expr,
    loader: Option<bun_ast::Loader>,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Self {
            eager: false,
            exhaustive: false,
            import: None,
            query: b"",
            base: None,
            import_options: Expr::EMPTY,
            loader: None,
        }
    }
}

/// Where a pattern is anchored, which also decides the shape of the keys.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Anchor {
    /// `./` or `../`: relative to the importing file (or to `base`).
    Importer,
    /// `/` or `**`: relative to the project root.
    Root,
}

fn skip_node_modules(entry_name: &[u8]) -> bool {
    entry_name == b"node_modules"
}

fn has_dot_prefix(path: &[u8]) -> bool {
    path.starts_with(b"./") || path.starts_with(b"../")
}

/// `./` + `path`, unless it already starts with `./` or `../`.
fn with_dot_prefix<'a>(arena: &'a bun_alloc::Arena, path: &[u8]) -> &'a [u8] {
    if has_dot_prefix(path) {
        return arena.alloc_slice_copy(path);
    }
    let mut out = bun_alloc::ArenaVec::<u8>::with_capacity_in(path.len() + 2, arena);
    out.extend_from_slice(b"./");
    out.extend_from_slice(path);
    out.into_bump_slice()
}

/// `relative(from, to)` with `/` separators, copied out of the thread-local
/// buffer `relative` returns.
fn relative_posix<'a>(arena: &'a bun_alloc::Arena, from: &[u8], to: &[u8]) -> &'a [u8] {
    let out = arena.alloc_slice_copy(resolve_path::relative(from, to));
    if cfg!(windows) {
        resolve_path::platform_to_posix_in_place::<u8>(out);
    }
    out
}

struct ScanError {
    loc: bun_ast::Loc,
    message: String,
}

/// The directory `base` names: against the project root when it starts with
/// `/`, otherwise against the importing file's directory.
fn base_dir<'a>(
    arena: &'a bun_alloc::Arena,
    importer_dir: &[u8],
    root: &[u8],
    base: &[u8],
) -> &'a [u8] {
    let mut buf = bun_paths::path_buffer_pool::get();
    let joined = match base.strip_prefix(b"/") {
        Some(from_root) => {
            resolve_path::join_abs_string_buf::<platform::Auto>(root, &mut *buf, &[from_root])
        }
        None => {
            resolve_path::join_abs_string_buf::<platform::Auto>(importer_dir, &mut *buf, &[base])
        }
    };
    arena.alloc_slice_copy(joined)
}

/// Runs every pattern that is not negated and filters the result through the
/// negated ones. Returns the absolute, `/`-separated paths of the matches in
/// sorted order, and whether the keys are written from the project root
/// (`/src/a.ts`) or from the importing file (`./a.ts`).
fn scan<'a>(
    arena: &'a bun_alloc::Arena,
    importer: &[u8],
    patterns: &[Pattern<'_>],
    importer_dir: &[u8],
    root: &[u8],
    exhaustive: bool,
) -> Result<(Vec<&'a [u8]>, bool), ScanError> {
    let anchor_of = |text: &[u8]| {
        if has_dot_prefix(text) {
            Anchor::Importer
        } else {
            Anchor::Root
        }
    };
    let keys_from_root = patterns
        .iter()
        .any(|p| !p.text.starts_with(b"!") && anchor_of(p.text) == Anchor::Root);

    let mut seen: bun_collections::StringHashMap<()> = Default::default();
    let mut matches: Vec<&'a [u8]> = Vec::new();

    for pattern in patterns {
        if pattern.text.starts_with(b"!") {
            continue;
        }
        let (cwd, glob): (&[u8], &[u8]) = match anchor_of(pattern.text) {
            Anchor::Importer => (importer_dir, pattern.text),
            Anchor::Root => (root, strings::trim_left(pattern.text, b"/")),
        };

        let mut walker = match bun_glob::BunGlobWalker::init_with_cwd(
            glob,
            cwd,
            exhaustive,
            false,
            true,
            false,
            true,
            (!exhaustive).then_some(skip_node_modules as fn(&[u8]) -> bool),
        ) {
            Ok(Ok(walker)) => walker,
            Ok(Err(err)) => {
                return Err(ScanError {
                    loc: pattern.loc,
                    message: format!(
                        "import.meta.glob() could not read pattern \"{}\": {}",
                        bstr::BStr::new(pattern.text),
                        bstr::BStr::new(err.name())
                    ),
                });
            }
            Err(_) => bun_core::out_of_memory(),
        };

        let mut iter = bun_glob::walk::Iterator::new(&mut walker);
        match iter.init() {
            Ok(Ok(())) => {}
            // The directory the pattern starts in does not exist: no matches.
            Ok(Err(_)) => continue,
            Err(_) => bun_core::out_of_memory(),
        }

        loop {
            let matched = match iter.next() {
                Ok(Ok(Some(path))) => path,
                Ok(Ok(None)) => break,
                Ok(Err(err)) => {
                    return Err(ScanError {
                        loc: pattern.loc,
                        message: format!(
                            "import.meta.glob() could not read \"{}\": {}",
                            bstr::BStr::new(&err.path),
                            bstr::BStr::new(err.name())
                        ),
                    });
                }
                Err(_) => bun_core::out_of_memory(),
            };

            let mut buf = bun_paths::path_buffer_pool::get();
            let joined = resolve_path::join_abs_string_buf::<platform::Auto>(
                cwd,
                &mut *buf,
                &[&matched[..]],
            );
            // A module that globs its own directory does not import itself.
            if joined == importer || seen.contains_key(joined) {
                continue;
            }
            let abs: &'a mut [u8] = arena.alloc_slice_copy(joined);
            bun_core::handle_oom(seen.put(abs, ()));
            if cfg!(windows) {
                resolve_path::platform_to_posix_in_place::<u8>(abs);
            }
            matches.push(abs);
        }
    }

    let negated: Vec<(&[u8], &[u8])> = patterns
        .iter()
        .filter_map(|p| p.text.strip_prefix(b"!"))
        .map(|text| match anchor_of(text) {
            Anchor::Importer => (importer_dir, text.strip_prefix(b"./").unwrap_or(text)),
            Anchor::Root => (root, strings::trim_left(text, b"/")),
        })
        .collect();
    if !negated.is_empty() {
        matches.retain(|abs| {
            !negated.iter().any(|(dir, glob)| {
                bun_glob::r#match(glob, relative_posix(arena, dir, abs)).matches()
            })
        });
    }

    matches.sort_unstable();
    Ok((matches, keys_from_root))
}

impl<'a, const TYPESCRIPT: bool, const SCAN_ONLY: bool> P<'a, TYPESCRIPT, SCAN_ONLY> {
    /// Globs are matched on disk next to the importing file, so the file has
    /// to be a real one: not `Bun.Transpiler` input, not a plugin's virtual
    /// module.
    pub(crate) fn can_expand_import_meta_glob(&self) -> bool {
        self.source.path.is_file() && bun_paths::is_absolute(self.source.path.text)
    }

    fn import_meta_glob_error(&mut self, loc: bun_ast::Loc, args: core::fmt::Arguments<'_>) {
        let range = self.source.range_of_string(loc);
        self.log()
            .add_range_error_fmt(Some(self.source), range, args);
    }

    // Kept out of `e_call`, whose frame is paid for at every level of nested calls.
    #[cold]
    #[inline(never)]
    pub(crate) fn expand_import_meta_glob(&mut self, call: &E::Call, loc: bun_ast::Loc) -> Expr {
        // An unexpanded call never runs, so there is nothing to match.
        if self.is_control_flow_dead {
            return self.new_expr(E::Object::default(), loc);
        }

        self.import_meta_glob_count += 1;

        let expanded = self.expand_import_meta_glob_impl(call, loc);
        expanded.unwrap_or_else(|| self.new_expr(E::Object::default(), loc))
    }

    /// `None` after logging an error.
    fn expand_import_meta_glob_impl(&mut self, call: &E::Call, loc: bun_ast::Loc) -> Option<Expr> {
        let args = call.args.slice();
        if args.is_empty() || args.len() > 2 {
            self.import_meta_glob_error(
                loc,
                format_args!("import.meta.glob() expects a pattern and an optional options object"),
            );
            return None;
        }

        let patterns = self.import_meta_glob_patterns(args[0])?;
        let options = match args.get(1) {
            Some(arg) => self.import_meta_glob_options(*arg)?,
            None => Options::default(),
        };

        let arena = self.arena;
        let first_loc = patterns.first().map(|p| p.loc).unwrap_or(loc);
        let importer_dir = self.source.path.name().dir;
        let root = bun_paths::fs::FileSystem::instance().top_level_dir();
        // `base` moves where relative patterns match and what the keys are
        // relative to. The specifiers stay relative to this file.
        let match_dir: &[u8] = match options.base {
            Some(base) => base_dir(arena, importer_dir, root, base),
            None => importer_dir,
        };
        let scanned = scan(
            arena,
            self.source.path.text,
            &patterns,
            match_dir,
            root,
            options.exhaustive,
        );
        let (matches, keys_from_root) = match scanned {
            Ok(scanned) => scanned,
            Err(err) => {
                self.import_meta_glob_error(err.loc, format_args!("{}", err.message));
                return None;
            }
        };

        let mut properties = G::PropertyList::init_capacity(matches.len());
        for (i, &abs) in matches.iter().enumerate() {
            let specifier_path = with_dot_prefix(arena, relative_posix(arena, importer_dir, abs));
            let key: &[u8] = if options.base.is_some() {
                with_dot_prefix(arena, relative_posix(arena, match_dir, abs))
            } else if keys_from_root {
                let from_root = relative_posix(arena, root, abs);
                if has_dot_prefix(from_root) {
                    from_root
                } else {
                    let mut out =
                        bun_alloc::ArenaVec::<u8>::with_capacity_in(from_root.len() + 1, arena);
                    out.push(b'/');
                    out.extend_from_slice(from_root);
                    out.into_bump_slice()
                }
            } else {
                specifier_path
            };

            let specifier: &'a [u8] = if options.query.is_empty() {
                specifier_path
            } else {
                let mut out = bun_alloc::ArenaVec::<u8>::with_capacity_in(
                    specifier_path.len() + options.query.len(),
                    arena,
                );
                out.extend_from_slice(specifier_path);
                out.extend_from_slice(options.query);
                out.into_bump_slice()
            };

            let value = if options.eager {
                self.import_meta_glob_eager_value(specifier, &options, first_loc, loc, i)
            } else {
                self.import_meta_glob_lazy_value(specifier, &options, first_loc, loc)
            };

            properties.append_assume_capacity(G::Property {
                key: Some(self.new_expr(E::String::init_re_encode_utf8(key, arena), loc)),
                value: Some(value),
                ..Default::default()
            });
        }

        Some(self.new_expr(
            E::Object {
                properties,
                is_single_line: matches.is_empty(),
                ..Default::default()
            },
            loc,
        ))
    }

    fn import_meta_glob_patterns(&mut self, arg: Expr) -> Option<Vec<Pattern<'a>>> {
        let arena = self.arena;
        let mut patterns: Vec<Pattern<'a>> = Vec::new();
        match arg.data {
            js_ast::ExprData::EString(mut str_) => patterns.push(Pattern {
                text: str_.slice(arena),
                loc: arg.loc,
            }),
            js_ast::ExprData::EArray(arr) => {
                for item in arr.items.slice() {
                    let js_ast::ExprData::EString(mut str_) = item.data else {
                        self.import_meta_glob_error(
                            item.loc,
                            format_args!("import.meta.glob() patterns must be string literals"),
                        );
                        return None;
                    };
                    patterns.push(Pattern {
                        text: str_.slice(arena),
                        loc: item.loc,
                    });
                }
            }
            _ => {
                self.import_meta_glob_error(
                    arg.loc,
                    format_args!(
                        "import.meta.glob() patterns must be a string literal or an array of string literals, because they are matched when the file is transpiled"
                    ),
                );
                return None;
            }
        }

        for pattern in &patterns {
            let text = pattern.text.strip_prefix(b"!").unwrap_or(pattern.text);
            if !(has_dot_prefix(text) || text.starts_with(b"/") || text.starts_with(b"**")) {
                self.import_meta_glob_error(
                    pattern.loc,
                    format_args!(
                        "import.meta.glob() pattern \"{}\" must start with \"./\", \"../\" or \"/\"",
                        bstr::BStr::new(pattern.text)
                    ),
                );
                return None;
            }
        }

        if !patterns.iter().any(|p| !p.text.starts_with(b"!")) {
            self.import_meta_glob_error(
                arg.loc,
                format_args!("import.meta.glob() needs at least one pattern that is not negated"),
            );
            return None;
        }

        Some(patterns)
    }

    fn import_meta_glob_options(&mut self, arg: Expr) -> Option<Options<'a>> {
        let arena = self.arena;
        let js_ast::ExprData::EObject(obj) = arg.data else {
            self.import_meta_glob_error(
                arg.loc,
                format_args!("import.meta.glob() options must be an object literal"),
            );
            return None;
        };

        let mut options = Options::default();

        for prop in obj.properties.slice() {
            let (Some(key_expr), Some(value)) = (prop.key, prop.value) else {
                self.import_meta_glob_error(
                    arg.loc,
                    format_args!("import.meta.glob() options must be written out as literals"),
                );
                return None;
            };
            let js_ast::ExprData::EString(mut key_str) = key_expr.data else {
                self.import_meta_glob_error(
                    key_expr.loc,
                    format_args!("import.meta.glob() options must be written out as literals"),
                );
                return None;
            };
            if prop.kind != G::PropertyKind::Normal
                || prop.flags.contains(js_ast::flags::Property::IsComputed)
                || prop.flags.contains(js_ast::flags::Property::IsMethod)
            {
                self.import_meta_glob_error(
                    key_expr.loc,
                    format_args!("import.meta.glob() options must be written out as literals"),
                );
                return None;
            }

            let key = key_str.slice(arena);
            match key {
                b"eager" | b"exhaustive" => {
                    let js_ast::ExprData::EBoolean(b) = value.data else {
                        self.import_meta_glob_error(
                            value.loc,
                            format_args!(
                                "import.meta.glob() option \"{}\" must be `true` or `false`",
                                bstr::BStr::new(key)
                            ),
                        );
                        return None;
                    };
                    if key == b"eager" {
                        options.eager = b.value;
                    } else {
                        options.exhaustive = b.value;
                    }
                }
                b"import" | b"base" => {
                    let js_ast::ExprData::EString(mut s) = value.data else {
                        self.import_meta_glob_error(
                            value.loc,
                            format_args!(
                                "import.meta.glob() option \"{}\" must be a string literal",
                                bstr::BStr::new(key)
                            ),
                        );
                        return None;
                    };
                    let text = s.slice(arena);
                    if key == b"import" {
                        // `import: "*"` is the namespace, the default.
                        options.import = (text != b"*").then_some(text);
                    } else if has_dot_prefix(text)
                        || text.starts_with(b"/")
                        || text == b"."
                        || text == b".."
                    {
                        options.base = Some(text);
                    } else {
                        self.import_meta_glob_error(
                            value.loc,
                            format_args!(
                                "import.meta.glob() option \"base\" must start with \"./\", \"../\" or \"/\""
                            ),
                        );
                        return None;
                    }
                }
                b"query" => options.query = self.import_meta_glob_query(value)?,
                b"with" => {
                    if !matches!(value.data, js_ast::ExprData::EObject(_))
                        || !self.expr_can_be_removed_if_unused(&value)
                    {
                        self.import_meta_glob_error(
                            value.loc,
                            format_args!(
                                "import.meta.glob() option \"with\" must be an object literal of import attributes"
                            ),
                        );
                        return None;
                    }
                    let mut properties = G::PropertyList::init_capacity(1);
                    properties.append_assume_capacity(G::Property {
                        key: Some(self.new_expr(E::String::init(b"with"), key_expr.loc)),
                        value: Some(value),
                        ..Default::default()
                    });
                    options.import_options = self.new_expr(
                        E::Object {
                            properties,
                            is_single_line: true,
                            ..Default::default()
                        },
                        value.loc,
                    );
                    options.loader = E::Import {
                        expr: Expr::EMPTY,
                        options: options.import_options,
                        import_record_index: u32::MAX,
                        namespace_ref: Ref::NONE,
                    }
                    .import_record_loader();
                }
                b"as" => {
                    self.import_meta_glob_error(
                        key_expr.loc,
                        format_args!(
                            "import.meta.glob() does not support the deprecated \"as\" option. Use `with: {{ type: \"text\" }}` with `import: \"default\"` instead of `as: \"raw\"`"
                        ),
                    );
                    return None;
                }
                _ => {
                    self.import_meta_glob_error(
                        key_expr.loc,
                        format_args!(
                            "import.meta.glob() does not have an option named \"{}\"",
                            bstr::BStr::new(key)
                        ),
                    );
                    return None;
                }
            }
        }

        Some(options)
    }

    /// `query: "?raw"`, `query: "raw"` or `query: { a: "b", c: true }`.
    fn import_meta_glob_query(&mut self, value: Expr) -> Option<&'a [u8]> {
        let arena = self.arena;
        match value.data {
            js_ast::ExprData::EString(mut s) => {
                let text = s.slice(arena);
                if text.is_empty() || text.starts_with(b"?") {
                    return Some(text);
                }
                let mut out = bun_alloc::ArenaVec::<u8>::with_capacity_in(text.len() + 1, arena);
                out.push(b'?');
                out.extend_from_slice(text);
                Some(out.into_bump_slice())
            }
            js_ast::ExprData::EObject(obj) => {
                use std::io::Write as _;
                let mut out: Vec<u8> = Vec::new();
                for prop in obj.properties.slice() {
                    let (Some(key_expr), Some(item)) = (prop.key, prop.value) else {
                        self.import_meta_glob_error(
                            value.loc,
                            format_args!(
                                "import.meta.glob() option \"query\" must be written out as literals"
                            ),
                        );
                        return None;
                    };
                    let js_ast::ExprData::EString(mut key_str) = key_expr.data else {
                        self.import_meta_glob_error(
                            key_expr.loc,
                            format_args!(
                                "import.meta.glob() option \"query\" must be written out as literals"
                            ),
                        );
                        return None;
                    };
                    out.push(if out.is_empty() { b'?' } else { b'&' });
                    out.extend_from_slice(key_str.slice(arena));
                    out.push(b'=');
                    match item.data {
                        js_ast::ExprData::EString(mut s) => out.extend_from_slice(s.slice(arena)),
                        js_ast::ExprData::EBoolean(b) => {
                            out.extend_from_slice(if b.value { b"true" } else { b"false" })
                        }
                        js_ast::ExprData::ENumber(n) => {
                            let _ = write!(&mut out, "{}", n.value());
                        }
                        _ => {
                            self.import_meta_glob_error(
                                item.loc,
                                format_args!(
                                    "import.meta.glob() query values must be string, number or boolean literals"
                                ),
                            );
                            return None;
                        }
                    }
                }
                Some(arena.alloc_slice_copy(&out))
            }
            _ => {
                self.import_meta_glob_error(
                    value.loc,
                    format_args!(
                        "import.meta.glob() option \"query\" must be a string literal or an object literal"
                    ),
                );
                None
            }
        }
    }

    /// `() => import(specifier)`, or with `import: "name"`,
    /// `async () => (await import(specifier)).name`.
    fn import_meta_glob_lazy_value(
        &mut self,
        specifier: &'a [u8],
        options: &Options<'a>,
        specifier_loc: bun_ast::Loc,
        loc: bun_ast::Loc,
    ) -> Expr {
        let arena = self.arena;
        let specifier_expr = self.new_expr(
            E::String::init_re_encode_utf8(specifier, arena),
            specifier_loc,
        );
        let import = self.transpose_import(
            specifier_expr,
            &TransposeState {
                import_options: options.import_options,
                import_loader: options.loader,
                loc,
                ..Default::default()
            },
        );

        let value = match options.import {
            None => import,
            Some(name) => {
                // The same bookkeeping a hand-written `(await import(x)).name`
                // gets, so the bundler keeps only that export of the module.
                if let js_ast::ExprData::EImport(im) = import.data
                    && im.namespace_ref.is_valid()
                    && let Some(items) = self.import_items_for_namespace.get_mut(&im.namespace_ref)
                {
                    bun_core::handle_oom(items.put(
                        name,
                        LocRef {
                            loc,
                            ref_: Ref::NONE,
                        },
                    ));
                    self.note_tracked_namespace_use(im.namespace_ref);
                }
                let awaited = self.new_expr(E::Await { value: import }, loc);
                self.new_expr(
                    E::Dot {
                        target: awaited,
                        name: name.into(),
                        name_loc: loc,
                        ..Default::default()
                    },
                    loc,
                )
            }
        };

        let ret = self.s(S::Return { value: Some(value) }, loc);
        self.new_expr(
            E::Arrow {
                body: G::FnBody {
                    stmts: bun_ast::StoreSlice::new_mut(arena.alloc_slice_copy(&[ret])),
                    loc,
                },
                is_async: options.import.is_some(),
                prefer_expr: true,
                ..Default::default()
            },
            loc,
        )
    }

    /// Queues `import * as ns from specifier` (or `import { name as local }`)
    /// for the part `generate_import_meta_glob_part` builds, and returns the
    /// reference to the binding.
    fn import_meta_glob_eager_value(
        &mut self,
        specifier: &'a [u8],
        options: &Options<'a>,
        specifier_loc: bun_ast::Loc,
        loc: bun_ast::Loc,
        index: usize,
    ) -> Expr {
        let arena = self.arena;
        let import_record_index =
            self.add_import_record(ImportKind::Stmt, specifier_loc, specifier);
        if let Some(loader) = options.loader {
            self.import_records.items_mut()[import_record_index as usize].loader = Some(loader);
        }

        // Without a renamer the name is printed as is, so the prefix has to be
        // one nobody writes by hand.
        let local_name: &'a [u8] = bun_alloc::arena_format!(
            in arena,
            "__bun_glob_{}_{}",
            self.import_meta_glob_count - 1,
            index,
        )
        .into_bump_str()
        .as_bytes();

        let Some(name) = options.import else {
            let namespace_ref = self.new_symbol(js_ast::symbol::Kind::Import, local_name);
            VecExt::append(&mut self.module_scope_mut().generated, namespace_ref);
            self.import_meta_glob_stmts.push(self.s(
                S::Import {
                    namespace_ref,
                    star_name_loc: loc,
                    import_record_index,
                    is_single_line: true,
                    ..Default::default()
                },
                loc,
            ));
            self.record_usage(namespace_ref);
            return Expr::init_identifier(namespace_ref, loc);
        };

        let path_name = bun_paths::fs::PathName::init(specifier);
        let namespace_name: &'a [u8] = bun_alloc::arena_format!(
            in arena,
            "import_{}",
            bun_core::fmt::fmt_identifier(path_name.non_unique_name_string_base())
        )
        .into_bump_str()
        .as_bytes();
        let namespace_ref = self.new_symbol(js_ast::symbol::Kind::Other, namespace_name);
        VecExt::append(&mut self.module_scope_mut().generated, namespace_ref);

        let local_ref = self.new_symbol(js_ast::symbol::Kind::Import, local_name);
        VecExt::append(&mut self.module_scope_mut().generated, local_ref);
        self.is_import_item.insert(local_ref, ());
        if self.options.features.hot_module_reloading {
            self.symbols[local_ref.inner_index() as usize].namespace_alias =
                Some(bun_alloc::ast_box(js_ast::NamespaceAlias {
                    namespace_ref,
                    alias: js_ast::StoreStr::new(name),
                    import_record_index,
                    was_originally_property_access: false,
                }));
        }

        let items =
            arena.alloc_slice_fill_with::<js_ast::ClauseItem, _>(1, |_| js_ast::ClauseItem {
                alias: js_ast::StoreStr::new(name),
                original_name: js_ast::StoreStr::new(local_name),
                alias_loc: loc,
                name: LocRef {
                    ref_: local_ref,
                    loc,
                },
            });
        self.import_meta_glob_stmts.push(self.s(
            S::Import {
                namespace_ref,
                items: items.into(),
                import_record_index,
                is_single_line: true,
                ..Default::default()
            },
            loc,
        ));
        self.record_usage(local_ref);
        self.new_expr(E::ImportIdentifier::new(local_ref, false), loc)
    }

    /// The part that holds the `import` statements of every
    /// `import.meta.glob(..., { eager: true })` in the file.
    pub(crate) fn generate_import_meta_glob_part(
        &mut self,
        parts: &mut bun_alloc::ArenaVec<'a, js_ast::Part>,
    ) -> Result<(), crate::Error> {
        let stmts: &'a mut [Stmt] = self.arena.alloc_slice_copy(&self.import_meta_glob_stmts);
        let mut declared_symbols = bun_ast::DeclaredSymbolList::default();
        let mut import_record_indices: js_ast::PartImportRecordIndices = bun_alloc::AstAlloc::vec();
        for stmt in stmts.iter() {
            let js_ast::StmtData::SImport(import) = &stmt.data else {
                continue;
            };
            import_record_indices.push(import.import_record_index);
            declared_symbols.append(js_ast::DeclaredSymbol {
                ref_: import.namespace_ref,
                is_top_level: true,
            })?;
            for item in import.items.iter() {
                declared_symbols.append(js_ast::DeclaredSymbol {
                    ref_: item.name.ref_,
                    is_top_level: true,
                })?;
                self.named_imports.put(
                    item.name.ref_,
                    js_ast::NamedImport {
                        alias: Some(item.alias),
                        alias_loc: item.alias_loc,
                        namespace_ref: import.namespace_ref,
                        import_record_index: import.import_record_index,
                        local_parts_with_uses: bun_alloc::AstAlloc::vec(),
                        alias_is_star: false,
                        is_exported: false,
                    },
                )?;
            }
        }
        parts.push(js_ast::Part {
            stmts: stmts.into(),
            declared_symbols,
            import_record_indices,
            ..Default::default()
        });
        Ok(())
    }
}
