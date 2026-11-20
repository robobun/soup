use crate::mal_prelude::*;
use std::io::Write as _;

use crate::Error;
use bun_ast::Loc;
use bun_core::fmt::quote;
use bun_core::{String as BunString, strings};
use bun_paths as paths;
use bun_wyhash::hash;

use crate::LinkerContext;
use crate::chunk::{Content, Flags as ChunkFlags, ReferencePathStyle, SourceMapShiftTracking};
use crate::linker_context::legal_comments;
use crate::linker_context::output_file_list_builder::OutputFileList;
use crate::linker_context_mod::debug;
use crate::options::{self, Loader, OutputFile, SourceMapOption};
use crate::output_file::{
    BakeExtra, Index as OutputFileIndex, IndexOptional, Options as OutputFileInit,
    OptionsData as OutputFileData, SavedFile, Value as OutputFileValue,
};
use crate::{Chunk, cheap_prefix_normalizer};

use bun_sys::{
    FdDirExt, PathOrFileDescriptor, WriteFileArgs, WriteFileData, WriteFileEncoding,
    write_file_with_path_buffer,
};

use crate::bytecode_sidecar::EXTENSION as BYTECODE_EXTENSION;

pub(crate) fn write_output_files_to_disk(
    c: &mut LinkerContext,
    log: &mut bun_ast::Log,
    root_path: &[u8],
    chunks: &mut [Chunk],
    output_files: &mut OutputFileList,
    standalone_chunk_contents: Option<&[Option<Box<[u8]>>]>,
    standalone_sourcemaps: &mut [Option<Box<[u8]>>],
) -> Result<(), Error> {
    let _trace = bun_core::perf::trace("Bundler.writeOutputFilesToDisk");

    let root_dir = match bun_sys::Dir::cwd().make_open_path(root_path, Default::default()) {
        Ok(dir) => dir,
        Err(e) => {
            if bun_errno::SystemErrno::from(e.clone()) == bun_errno::SystemErrno::ENOTDIR {
                log
                    .add_error_fmt(
                        None,
                        Loc::EMPTY,
                        format_args!(
                            "Failed to create output directory {} is a file. Please choose a different outdir or delete {}",
                            quote(root_path),
                            quote(root_path),
                        ),
                    );
            } else {
                log.add_error_fmt(
                    None,
                    Loc::EMPTY,
                    format_args!(
                        "Failed to create output directory {} {}",
                        bstr::BStr::new(e.name()),
                        quote(root_path),
                    ),
                );
            }
            return Err(e.into());
        }
    };

    // With `clean`, what the build does not write is found before the first write and removed after the last one.
    let bundle = c.bundle;
    let stale = match bundle.clean.as_deref() {
        Some(clean) => Some(find_stale_outputs(
            c,
            clean,
            log,
            &root_dir,
            root_path,
            chunks,
            standalone_chunk_contents.is_some(),
            standalone_sourcemaps,
        )?),
        None => None,
    };

    let mut pathbuf = bun_paths::path_buffer_pool::get();

    // `code()`/`code_standalone()` take both `chunk` (an element of `chunks`)
    // and `chunks` as
    // `&Chunk` / `&[Chunk]` (read-only), so iterate by index and reborrow
    // shared; the only per-chunk mutation is the `intermediate_output`
    // take/restore done via `chunks[i]`.
    let chunks_len = chunks.len();

    for chunk_index_in_chunks_list in 0..chunks_len {
        let chunk: &Chunk = &chunks[chunk_index_in_chunks_list];
        // In standalone mode, only write HTML chunks to disk.
        // Insert placeholder output files for non-HTML chunks to keep indices aligned.
        if standalone_chunk_contents.is_some() && !matches!(chunk.content, Content::Html) {
            // The chunk itself is inlined into the HTML document, but its .map
            // file (linked/external sourcemaps) is still written to disk.
            let source_map_index: Option<u32> = if let Some(output_source_map) =
                standalone_sourcemaps
                    .get_mut(chunk_index_in_chunks_list)
                    .and_then(Option::take)
            {
                let source_map_final_rel_path = strings::concat(&[&chunk.final_rel_path, b".map"]);

                let rel_parent = paths::resolve_path::dirname::<paths::platform::Posix>(
                    &source_map_final_rel_path,
                );
                if !rel_parent.is_empty() {
                    if let Err(e) = root_dir.make_path(rel_parent) {
                        log.add_error_fmt(
                            None,
                            Loc::EMPTY,
                            format_args!(
                                "{} creating outdir {} while saving sourcemap {}",
                                bstr::BStr::new(e.name()),
                                quote(rel_parent),
                                quote(&*source_map_final_rel_path),
                            ),
                        );
                        return Err(e.into());
                    }
                }

                if let Err(e) = bun_sys::File::write_file(
                    bun_sys::Fd::from_std_dir(&root_dir),
                    paths::resolve_path::z(&source_map_final_rel_path, &mut pathbuf),
                    &output_source_map,
                ) {
                    log.add_sys_error(
                        &e,
                        format_args!(
                            "writing sourcemap for chunk {}",
                            quote(&chunk.final_rel_path)
                        ),
                    );
                    return Err(crate::Error::WriteFailed);
                }

                let input_path: &[u8] = if chunk.entry_point.is_entry_point() {
                    c.parse_graph().input_files.items_source()
                        [chunk.entry_point.source_index() as usize]
                        .path
                        .text
                } else {
                    &chunk.final_rel_path
                };

                Some(
                    output_files.insert_for_sourcemap_or_bytecode(OutputFile::init(
                        OutputFileInit {
                            output_path: source_map_final_rel_path,
                            input_path: strings::concat(&[input_path, b".map"]),
                            loader: Loader::Json,
                            input_loader: Loader::File,
                            output_kind: options::OutputKind::Sourcemap,
                            size: Some(output_source_map.len()),
                            data: OutputFileData::Saved(0),
                            side: Some(options::Side::Client),
                            entry_point_index: None,
                            is_executable: false,
                            hash: None,
                            source_map_index: None,
                            bytecode_index: None,
                            module_info_index: None,
                            display_size: 0,
                            referenced_css_chunks: Box::default(),
                            source_index: IndexOptional::NONE,
                            bake_extra: BakeExtra::default(),
                        },
                    ))?,
                )
            } else {
                None
            };

            let _ = output_files.insert_for_chunk(OutputFile::init(OutputFileInit {
                data: OutputFileData::Saved(0),
                hash: None,
                loader: chunk.content.loader(),
                input_path: Box::default(),
                display_size: 0,
                output_kind: options::OutputKind::Chunk,
                input_loader: Loader::Js,
                output_path: Box::default(),
                is_executable: false,
                source_map_index,
                bytecode_index: None,
                module_info_index: None,
                side: Some(options::Side::Client),
                entry_point_index: None,
                referenced_css_chunks: Box::default(),
                size: None,
                source_index: IndexOptional::NONE,
                bake_extra: BakeExtra::default(),
            }));
            continue;
        }

        let _trace2 = bun_core::perf::trace("Bundler.writeChunkToDisk");

        let rel_parent =
            paths::resolve_path::dirname::<paths::platform::Posix>(&chunk.final_rel_path);
        if !rel_parent.is_empty() {
            if let Err(e) = root_dir.make_path(rel_parent) {
                log.add_error_fmt(
                    None,
                    Loc::EMPTY,
                    format_args!(
                        "{} creating outdir {} while saving chunk {}",
                        bstr::BStr::new(e.name()),
                        quote(rel_parent),
                        quote(&chunk.final_rel_path),
                    ),
                );
                return Err(e.into());
            }
        }
        let mut display_size: usize = 0;
        let resolver_opts = &c.resolver.opts;
        let public_path: &[u8] = &c.options_for_chunk(chunk).public_path;

        // Take `intermediate_output` by value so its `&mut self` is
        // disjoint from the `&chunks[i]` / `&[Chunk]` reads below.
        let mut intermediate_output =
            core::mem::take(&mut chunks[chunk_index_in_chunks_list].intermediate_output);
        let chunk: &Chunk = &chunks[chunk_index_in_chunks_list];
        let parse_graph = c.parse_graph();

        let mut code_result = if let Some(scc) = standalone_chunk_contents {
            match intermediate_output.code_standalone(
                None,
                c.bundle,
                &c.graph,
                public_path,
                chunk,
                chunks,
                Some(&mut display_size),
                ReferencePathStyle::ImporterRelative,
                SourceMapShiftTracking::Disabled,
                scc,
            ) {
                Ok(r) => r,
                Err(_e) => bun_core::Output::panic(format_args!(
                    "Failed to create output chunk: OutOfMemory"
                )),
            }
        } else {
            match intermediate_output.code(
                None,
                c.bundle,
                &c.graph,
                public_path,
                chunk,
                chunks,
                Some(&mut display_size),
                ReferencePathStyle::for_chunk(chunk, resolver_opts.compile),
                SourceMapShiftTracking::for_source_map(
                    chunk.content.sourcemap(c.options.source_maps),
                ),
            ) {
                Ok(r) => r,
                Err(_e) => bun_core::Output::panic(format_args!(
                    "Failed to create output chunk: OutOfMemory"
                )),
            }
        };
        // Tail of the loop body needs `&mut chunk` (`output_source_map.finalize()`);
        // no `&[Chunk]` is needed past this point so an exclusive reborrow is fine.
        let chunk: &mut Chunk = &mut chunks[chunk_index_in_chunks_list];
        chunk.intermediate_output = intermediate_output;

        let mut source_map_output_file: Option<OutputFile> = None;

        let input_path: Box<[u8]> = Box::from(if chunk.entry_point.is_entry_point() {
            parse_graph.input_files.items_source()[chunk.entry_point.source_index() as usize]
                .path
                .text
        } else {
            &chunk.final_rel_path
        });

        let legal_comments_output_file: Option<OutputFile> =
            if chunk.external_legal_comments.is_empty() {
                None
            } else {
                let output_path =
                    strings::concat(&[&chunk.final_rel_path, legal_comments::FILE_EXTENSION]);
                if c.options.legal_comments == options::LegalComments::Linked {
                    code_result.buffer =
                        legal_comments::append_link(&code_result.buffer, public_path, &output_path);
                }

                if let Err(e) = bun_sys::File::write_file(
                    bun_sys::Fd::from_std_dir(&root_dir),
                    paths::resolve_path::z(&output_path, &mut pathbuf),
                    &chunk.external_legal_comments,
                ) {
                    log.add_sys_error(
                        &e,
                        format_args!(
                            "writing legal comments for chunk {}",
                            quote(&chunk.final_rel_path)
                        ),
                    );
                    return Err(crate::Error::WriteFailed);
                }

                Some(OutputFile::init(OutputFileInit {
                    output_path,
                    input_path: strings::concat(&[&input_path, legal_comments::FILE_EXTENSION]),
                    loader: Loader::File,
                    input_loader: Loader::File,
                    output_kind: options::OutputKind::Asset,
                    size: Some(chunk.external_legal_comments.len()),
                    data: OutputFileData::Saved(0),
                    side: None,
                    entry_point_index: None,
                    is_executable: false,
                    hash: chunk.template.placeholder.hash.map(|_| {
                        chunk
                            .template
                            .content_hash(hash(&chunk.external_legal_comments))
                    }),
                    source_map_index: None,
                    bytecode_index: None,
                    module_info_index: None,
                    display_size: 0,
                    referenced_css_chunks: Box::default(),
                    source_index: IndexOptional::NONE,
                    bake_extra: BakeExtra::default(),
                }))
            };

        match chunk.content.sourcemap(c.options.source_maps) {
            tag @ (SourceMapOption::External | SourceMapOption::Linked) => {
                let output_source_map = chunk
                    .output_source_map
                    .finalize(&code_result.shifts)
                    .unwrap_or_else(|_| {
                        panic!("Failed to allocate memory for external source map")
                    });
                let source_map_final_rel_path = strings::concat(&[&chunk.final_rel_path, b".map"]);

                if tag == SourceMapOption::Linked {
                    let [a, b] = if !public_path.is_empty() {
                        cheap_prefix_normalizer(public_path, &source_map_final_rel_path)
                    } else {
                        [b"" as &[u8], paths::basename(&source_map_final_rel_path)]
                    };

                    let source_map_start = b"//# sourceMappingURL=";
                    let total_len = code_result.buffer.len()
                        + source_map_start.len()
                        + a.len()
                        + b.len()
                        + b"\n".len();
                    let mut buf: Vec<u8> = Vec::with_capacity(total_len);
                    buf.extend_from_slice(&code_result.buffer);
                    buf.extend_from_slice(source_map_start);
                    buf.extend_from_slice(a);
                    buf.extend_from_slice(b);
                    buf.push(b'\n');
                    code_result.buffer = buf.into_boxed_slice();
                }

                match bun_sys::File::write_file(
                    bun_sys::Fd::from_std_dir(&root_dir),
                    paths::resolve_path::z(&source_map_final_rel_path, &mut pathbuf),
                    &output_source_map,
                ) {
                    Err(e) => {
                        log.add_sys_error(
                            &e,
                            format_args!(
                                "writing sourcemap for chunk {}",
                                quote(&chunk.final_rel_path)
                            ),
                        );
                        return Err(crate::Error::WriteFailed);
                    }
                    Ok(_) => {}
                }

                source_map_output_file = Some(OutputFile::init(OutputFileInit {
                    output_path: source_map_final_rel_path,
                    input_path: strings::concat(&[&input_path, b".map"]),
                    loader: Loader::Json,
                    input_loader: Loader::File,
                    output_kind: options::OutputKind::Sourcemap,
                    size: Some(output_source_map.len()),
                    data: OutputFileData::Saved(0),
                    side: Some(options::Side::Client),
                    entry_point_index: None,
                    is_executable: false,
                    hash: None,
                    source_map_index: None,
                    bytecode_index: None,
                    module_info_index: None,
                    display_size: 0,
                    referenced_css_chunks: Box::default(),
                    source_index: IndexOptional::NONE,
                    bake_extra: BakeExtra::default(),
                }));
            }
            SourceMapOption::Inline => {
                let output_source_map = chunk
                    .output_source_map
                    .finalize(&code_result.shifts)
                    .unwrap_or_else(|_| {
                        panic!("Failed to allocate memory for external source map")
                    });
                let encode_len = bun_base64::encode_len(&output_source_map);

                let source_map_start = b"//# sourceMappingURL=data:application/json;base64,";
                let total_len = code_result.buffer.len() + source_map_start.len() + encode_len + 1;
                let mut buf: Vec<u8> = Vec::with_capacity(total_len);

                buf.extend_from_slice(&code_result.buffer);
                buf.extend_from_slice(source_map_start);
                bun_base64::encode_append(&mut buf, &output_source_map);
                buf.push(b'\n');
                code_result.buffer = buf.into_boxed_slice();
            }
            SourceMapOption::None => {}
        }

        let bytecode_output_file: Option<OutputFile> = 'brk: {
            if c.options.generate_bytecode_cache {
                if c.chunk_gets_bytecode(chunk) {
                    let mut fdpath = bun_paths::path_buffer_pool::get();
                    let source_provider_url = BunString::create_format(format_args!(
                        "{}{}",
                        bstr::BStr::new(&chunk.final_rel_path),
                        BYTECODE_EXTENSION,
                    ));

                    if let Some(bytecode) = crate::bundle_v2::dispatch::generate_cached_bytecode(
                        c.options.output_format,
                        &code_result.buffer,
                        &source_provider_url,
                        c.options.bytecode_depth,
                        c.options.optimize_bytecode,
                        None,
                    ) {
                        let bytecode = crate::bytecode_sidecar::frame(bytecode);
                        let source_provider_url_str = source_provider_url.to_utf8();
                        debug!(
                            "Bytecode cache generated {}: {}",
                            bstr::BStr::new(source_provider_url_str.slice()),
                            bun_core::fmt::size(
                                bytecode.len(),
                                bun_core::fmt::SizeFormatterOptions {
                                    space_between_number_and_unit: true,
                                }
                            ),
                        );
                        let frp: &[u8] = &chunk.final_rel_path;
                        fdpath[..frp.len()].copy_from_slice(frp);
                        fdpath[frp.len()..frp.len() + BYTECODE_EXTENSION.len()]
                            .copy_from_slice(BYTECODE_EXTENSION.as_bytes());
                        match write_file_with_path_buffer(
                            &mut pathbuf,
                            &WriteFileArgs {
                                data: WriteFileData::Buffer { buffer: &bytecode },
                                encoding: WriteFileEncoding::Buffer,
                                mode: if chunk.flags.contains(ChunkFlags::IS_EXECUTABLE) {
                                    0o755
                                } else {
                                    0o644
                                },
                                dirfd: bun_sys::Fd::from_std_dir(&root_dir),
                                file: PathOrFileDescriptor::Path(
                                    &fdpath[..frp.len() + BYTECODE_EXTENSION.len()],
                                ),
                            },
                        ) {
                            Ok(_) => {}
                            Err(e) => {
                                log.add_error_fmt(
                                    None,
                                    Loc::EMPTY,
                                    format_args!(
                                        "{} writing bytecode for chunk {}",
                                        e,
                                        quote(&chunk.final_rel_path),
                                    ),
                                );
                                return Err(crate::Error::WriteFailed);
                            }
                        }

                        let mut input_path_buf: Vec<u8> = Vec::new();
                        write!(
                            &mut input_path_buf,
                            "{}{}",
                            bstr::BStr::new(&chunk.final_rel_path),
                            BYTECODE_EXTENSION
                        )
                        .expect("unreachable");

                        break 'brk Some(OutputFile::init(OutputFileInit {
                            output_path: Box::<[u8]>::from(source_provider_url_str.slice()),
                            input_path: input_path_buf.into_boxed_slice(),
                            input_loader: Loader::File,
                            hash: chunk
                                .template
                                .placeholder
                                .hash
                                .map(|_| chunk.template.content_hash(hash(&bytecode))),
                            output_kind: options::OutputKind::Bytecode,
                            loader: Loader::File,
                            size: Some(bytecode.len()),
                            display_size: bytecode.len() as u32,
                            data: OutputFileData::Saved(0),
                            side: None,
                            entry_point_index: None,
                            is_executable: false,
                            source_map_index: None,
                            bytecode_index: None,
                            module_info_index: None,
                            referenced_css_chunks: Box::default(),
                            source_index: IndexOptional::NONE,
                            bake_extra: BakeExtra::default(),
                        }));
                    }
                }
            }

            break 'brk None;
        };

        match write_file_with_path_buffer(
            &mut pathbuf,
            &WriteFileArgs {
                data: WriteFileData::Buffer {
                    buffer: &code_result.buffer,
                },
                encoding: WriteFileEncoding::Buffer,
                mode: if chunk.flags.contains(ChunkFlags::IS_EXECUTABLE) {
                    0o755
                } else {
                    0o644
                },
                dirfd: bun_sys::Fd::from_std_dir(&root_dir),
                file: PathOrFileDescriptor::Path(&chunk.final_rel_path),
            },
        ) {
            Err(e) => {
                log.add_sys_error(
                    &e,
                    format_args!("writing chunk {}", quote(&chunk.final_rel_path)),
                );
                return Err(crate::Error::WriteFailed);
            }
            Ok(_) => {}
        }

        let source_map_index: Option<u32> = if let Some(f) = source_map_output_file {
            Some(output_files.insert_for_sourcemap_or_bytecode(f)?)
        } else {
            None
        };

        let bytecode_index: Option<u32> = if let Some(f) = bytecode_output_file {
            Some(output_files.insert_for_sourcemap_or_bytecode(f)?)
        } else {
            None
        };

        if let Some(f) = legal_comments_output_file {
            output_files.insert_for_sourcemap_or_bytecode(f)?;
        }

        let output_kind = c.chunk_output_kind(chunk);

        chunk.final_output_size = code_result.buffer.len();
        let chunk_index = output_files.insert_for_chunk(OutputFile::init(OutputFileInit {
            output_path: chunk.final_rel_path.clone(),
            input_path,
            input_loader: if chunk.entry_point.is_entry_point() {
                parse_graph.input_files.items_loader()[chunk.entry_point.source_index() as usize]
            } else {
                Loader::Js
            },
            hash: chunk.template.placeholder.hash,
            output_kind,
            loader: chunk.content.loader(),
            source_map_index,
            bytecode_index,
            module_info_index: None,
            size: Some(code_result.buffer.len()),
            display_size: display_size as u32,
            is_executable: chunk.flags.contains(ChunkFlags::IS_EXECUTABLE),
            data: OutputFileData::Saved(0),
            side: Some(c.chunk_side(chunk)),
            entry_point_index: if output_kind == options::OutputKind::EntryPoint {
                // Server-components builds insert 2 extra synthetic sources
                // before user entry points, so the source-index offset is 3.
                let offset: u32 = if c.framework.is_some_and(|fw| fw.server_components.is_some()) {
                    3
                } else {
                    1
                };
                Some(chunk.entry_point.source_index() - offset)
            } else {
                None
            },
            referenced_css_chunks: match &chunk.content {
                Content::Javascript(js) => {
                    // `Index` is `#[repr(transparent)]` over u32.
                    js.css_chunks
                        .iter()
                        .map(|&i| OutputFileIndex::init(i))
                        .collect()
                }
                Content::Css(_) => Box::default(),
                Content::Html => Box::default(),
            },
            source_index: IndexOptional::NONE,
            bake_extra: BakeExtra::default(),
        }));

        // We want the chunk index to remain the same in `output_files` so the indices in `OutputFile.referenced_css_chunks` work.
        // In standalone mode, non-HTML chunks are skipped so this invariant doesn't apply.
        if standalone_chunk_contents.is_none() {
            debug_assert!(
                chunk_index as usize == chunk_index_in_chunks_list,
                "chunk_index ({}) != chunk_index_in_chunks_list ({})",
                chunk_index,
                chunk_index_in_chunks_list,
            );
        }
    }

    // In standalone mode, additional output files (assets) are inlined into the HTML.
    if standalone_chunk_contents.is_some() {
        return remove_stale_outputs(log, &root_dir, root_path, stale);
    }

    {
        // Reshaped for borrowck — compute len before mut borrow,
        // bump `total_insertions`, then take the slice.
        let additional_start = output_files.additional_output_files_start as usize;
        let additional_len = output_files.output_files.len() - additional_start;
        output_files.total_insertions += u32::try_from(additional_len).expect("int cast");
        let additional_output_files = &mut output_files.output_files[additional_start..];
        debug_assert_eq!(
            c.graph.additional_output_files.len(),
            additional_output_files.len()
        );
        for (src, dest) in c
            .graph
            .additional_output_files
            .iter_mut()
            .zip(additional_output_files.iter_mut())
        {
            let bytes = if let OutputFileValue::Buffer { bytes } = &mut src.value {
                core::mem::take(bytes)
            } else {
                Box::default()
            };
            // `defer src.value.buffer.arena.free(bytes)` — `bytes` is now an
            // owned Box that drops at end of scope.

            let rel_parent = paths::resolve_path::dirname::<paths::platform::Auto>(&src.dest_path);
            if !rel_parent.is_empty() {
                if let Err(e) = root_dir.make_path(rel_parent) {
                    log.add_error_fmt(
                        None,
                        Loc::EMPTY,
                        format_args!(
                            "{} creating outdir {} while saving file {}",
                            bstr::BStr::new(e.name()),
                            quote(rel_parent),
                            quote(&*src.dest_path),
                        ),
                    );
                    return Err(e.into());
                }
            }

            match bun_sys::File::write_file(
                bun_sys::Fd::from_std_dir(&root_dir),
                paths::resolve_path::z(&src.dest_path, &mut pathbuf),
                &bytes,
            ) {
                Err(e) => {
                    log.add_sys_error(&e, format_args!("writing file {}", quote(&src.src_path)));
                    return Err(crate::Error::WriteFailed);
                }
                Ok(_) => {}
            }

            let bytes_len = bytes.len();
            drop(bytes);
            *dest = core::mem::replace(src, OutputFile::zero_value());
            dest.value = OutputFileValue::Saved(SavedFile::default());
            dest.size = bytes_len;
        }
    }

    remove_stale_outputs(log, &root_dir, root_path, stale)
}

#[derive(Clone, Copy)]
enum Kept {
    /// The build writes over it.
    File,
    /// A kept file is below it.
    Directory,
    /// The bytecode of a chunk. Whether the build writes it is known only once it is made, and a stale one must not
    /// stay beside new code.
    RemovedFirst,
}

/// What `clean` leaves in the output directory: the files that `write_output_files_to_disk` is about to write, those
/// that the caller writes afterwards, and the directories they are in.
#[derive(Default)]
struct KeptOutputs {
    /// By path in the output directory, with `/` between its parts.
    paths: bun_collections::StringHashMap<Kept>,
    /// The kept names of each directory, by its path. The output directory is `b""`.
    children: bun_collections::StringHashMap<Vec<Box<[u8]>>>,
}

impl KeptOutputs {
    const SEPARATORS: &[u8] = if cfg!(windows) { b"/\\" } else { b"/" };

    fn keep(
        &mut self,
        rel_path: &[u8],
        suffix: &[u8],
        kind: Kept,
    ) -> Result<(), bun_alloc::AllocError> {
        let mut path: Vec<u8> = Vec::with_capacity(rel_path.len() + suffix.len());
        for part in strings::tokenize_any(rel_path, Self::SEPARATORS) {
            match part {
                b"." => {}
                b".." => {
                    // A path that leaves the output directory names none of its files.
                    if path.is_empty() {
                        return Ok(());
                    }
                    path.truncate(strings::last_index_of_char(&path, b'/').unwrap_or(0));
                }
                _ => {
                    if !path.is_empty() {
                        path.push(b'/');
                    }
                    path.extend_from_slice(part);
                }
            }
        }
        if path.is_empty() {
            return Ok(());
        }
        path.extend_from_slice(suffix);
        let mut from = 0;
        loop {
            let end = strings::index_of_char_pos(&path, b'/', from).unwrap_or(path.len());
            if !self.paths.contains_key(&path[..end]) {
                let kind = if end == path.len() {
                    kind
                } else {
                    Kept::Directory
                };
                self.paths.put(&path[..end], kind)?;
                let siblings = self.children.get_or_put(&path[..from.saturating_sub(1)])?;
                siblings.value_ptr.push(Box::from(&path[from..end]));
            }
            if end == path.len() {
                return Ok(());
            }
            from = end + 1;
        }
    }
}

/// What `clean` removes once the build has written its files.
struct StaleOutput {
    /// In the output directory, with `/` between its parts.
    path: Box<[u8]>,
    is_directory: bool,
}

type RemovalFailure = Option<(bun_sys::Error, Vec<u8>)>;

/// `clean`: finds what is in the output directory and is not written by this build, for `remove_stale_outputs`.
/// Nothing is written yet, so a refusal leaves the directory as it was.
///
/// A file that the build writes stays and is written over, so it is never absent. What is in the way of a write is
/// removed here: a link at the name of an output, which the write would follow, and a directory at the name of a file.
#[cold]
#[inline(never)]
fn find_stale_outputs(
    c: &LinkerContext,
    clean: &options::CleanOutputs,
    log: &mut bun_ast::Log,
    root_dir: &bun_sys::Dir,
    root_path: &[u8],
    chunks: &[Chunk],
    is_standalone: bool,
    standalone_sourcemaps: &[Option<Box<[u8]>>],
) -> Result<Vec<StaleOutput>, Error> {
    use paths::resolve_path::{ParentEqual, is_parent_or_equal};

    let mut real_buf = bun_paths::path_buffer_pool::get();
    let real: &[u8] = match root_dir.get_fd_path(&mut real_buf) {
        Ok(real) => real,
        Err(e) => {
            log.add_sys_error(
                &e,
                format_args!(
                    "finding the real path of outdir {} to clean it",
                    quote(root_path)
                ),
            );
            return Err(Error::WriteFailed);
        }
    };
    let mut cwd_buf = bun_paths::path_buffer_pool::get();
    let cwd: Option<&[u8]> = bun_sys::getcwd_z(&mut cwd_buf)
        .ok()
        .map(|cwd| cwd.as_bytes());
    let top_level_dir = bun_resolver::fs::FileSystem::get().top_level_dir();
    let refuse = |log: &mut bun_ast::Log, reason: core::fmt::Arguments<'_>| {
        let mut written_buf = bun_paths::path_buffer_pool::get();
        let written: &[u8] = paths::resolve_path::join_abs_string_buf::<paths::platform::Auto>(
            cwd.unwrap_or(top_level_dir),
            &mut written_buf[..],
            &[root_path],
        );
        let note = "clean removes everything in outdir that the build does not write. Use a directory that holds only the output of the build";
        let notes = Box::new([bun_ast::range_data(None, bun_ast::Range::NONE, note)]);
        let outdir = quote(root_path);
        if strings::without_trailing_slash(written) == real {
            log.add_range_error_fmt_with_notes(
                None,
                bun_ast::Range::NONE,
                notes,
                format_args!("refusing to clean outdir {outdir}: {reason}"),
            );
        } else {
            log.add_range_error_fmt_with_notes(
                None,
                bun_ast::Range::NONE,
                notes,
                format_args!(
                    "refusing to clean outdir {outdir}: resolves to {}, which {reason}",
                    quote(real)
                ),
            );
        }
        Error::WriteFailed
    };

    let mut caller_buf = bun_paths::path_buffer_pool::get();
    let caller: Option<&[u8]> = (!clean.caller.is_empty()).then(|| {
        let path = bun_core::ZBox::from_bytes(&clean.caller);
        bun_sys::realpath(&path, &mut caller_buf).unwrap_or(&clean.caller)
    });
    let protected: [(&'static str, Option<&[u8]>); 5] = [
        (
            "the home directory",
            bun_core::env_var::HOME.get_not_empty(),
        ),
        (
            "the bun executable",
            bun_core::self_exe_path().ok().map(|exe| exe.as_bytes()),
        ),
        ("the current directory", cwd),
        ("the project directory", Some(top_level_dir)),
        ("the script that called Bun.build", caller),
    ];
    if let Some(what) = bun_sys::first_protected_in(real, protected) {
        return Err(refuse(log, format_args!("is or contains {what}")));
    }

    // The resolver follows links, so the path it gives a file is the real one. A plugin and the `files` option name a
    // file as they like.
    let has_unresolved_paths = c.bundle.plugins.is_some() || c.bundle.file_map.is_some();
    let mut input_buf = bun_paths::path_buffer_pool::get();
    for source in c.parse_graph().input_files.items_source() {
        let path = &source.path;
        if !path.is_file() || !bun_paths::is_absolute(path.text) {
            continue;
        }
        let input: &[u8] = if has_unresolved_paths {
            match bun_sys::realpath(&bun_core::ZBox::from_bytes(path.text), &mut input_buf) {
                Ok(input) => input,
                // Nothing on disk has this path, so nothing is removed with it.
                Err(e) if e.get_errno() == bun_sys::E::ENOENT => continue,
                Err(e) => {
                    log.add_sys_error(
                        &e,
                        format_args!(
                            "finding the real path of {} to clean outdir {}",
                            quote(path.text),
                            quote(root_path)
                        ),
                    );
                    return Err(Error::WriteFailed);
                }
            }
        } else {
            path.text
        };
        if is_parent_or_equal(real, input) != ParentEqual::Unrelated {
            return Err(refuse(
                log,
                format_args!("contains {}, which the build reads", quote(input)),
            ));
        }
    }

    let mut kept = KeptOutputs::default();
    for (index, chunk) in chunks.iter().enumerate() {
        if is_standalone && !matches!(chunk.content, Content::Html) {
            if standalone_sourcemaps
                .get(index)
                .is_some_and(Option::is_some)
            {
                kept.keep(&chunk.final_rel_path, b".map", Kept::File)?;
            }
            continue;
        }
        kept.keep(&chunk.final_rel_path, b"", Kept::File)?;
        if !chunk.external_legal_comments.is_empty() {
            kept.keep(
                &chunk.final_rel_path,
                legal_comments::FILE_EXTENSION,
                Kept::File,
            )?;
        }
        if matches!(
            chunk.content.sourcemap(c.options.source_maps),
            SourceMapOption::External | SourceMapOption::Linked
        ) {
            kept.keep(&chunk.final_rel_path, b".map", Kept::File)?;
        }
        if c.options.generate_bytecode_cache && c.chunk_gets_bytecode(chunk) {
            kept.keep(
                &chunk.final_rel_path,
                BYTECODE_EXTENSION.as_bytes(),
                Kept::RemovedFirst,
            )?;
        }
    }
    if !is_standalone {
        for file in c.graph.additional_output_files.iter() {
            kept.keep(&file.dest_path, b"", Kept::File)?;
        }
    }
    // `Bun.build` writes its metafiles once the linker has returned.
    let bundle_options = &c.bundle.transpiler.options;
    let metafiles = [
        &bundle_options.metafile_json_path,
        &bundle_options.metafile_markdown_path,
    ];
    for path in metafiles.into_iter().chain(&clean.written_later) {
        kept.keep(path, b"", Kept::File)?;
    }

    let mut stale = Vec::new();
    let mut failure: RemovalFailure = None;
    find_unkept(root_dir, &mut Vec::new(), &kept, &mut stale, &mut failure);
    match failure {
        None => Ok(stale),
        Some((e, path)) => Err(fail_to_remove(log, &e, &path, root_path)),
    }
}

fn fail_to_remove(
    log: &mut bun_ast::Log,
    e: &bun_sys::Error,
    path: &[u8],
    root_path: &[u8],
) -> Error {
    log.add_sys_error(
        e,
        format_args!(
            "removing {} to clean outdir {}",
            quote(path),
            quote(root_path)
        ),
    );
    Error::WriteFailed
}

/// Adds to `stale` what is in `dir` and not in `kept`, and removes what is in the way of a write. `prefix` is the path
/// of `dir` in the output directory, empty or with a `/` at its end.
fn find_unkept(
    dir: &bun_sys::Dir,
    prefix: &mut Vec<u8>,
    kept: &KeptOutputs,
    stale: &mut Vec<StaleOutput>,
    failure: &mut RemovalFailure,
) {
    use bun_sys::{E, EntryKind};

    let mut entries: Vec<(Vec<u8>, EntryKind)> = Vec::new();
    let mut listing = bun_sys::dir_iterator::iterate(dir.fd());
    loop {
        match listing.next() {
            Ok(Some(entry)) => entries.push((entry.name.slice_u8().to_vec(), entry.kind)),
            Ok(None) => break,
            Err(e) => {
                failure.get_or_insert_with(|| (e, prefix.clone()));
                return;
            }
        }
    }

    let remove_now = |name: &[u8], path: &[u8], failure: &mut RemovalFailure| {
        if let Err(e) = dir.delete_tree(name) {
            failure.get_or_insert_with(|| (e, path.to_vec()));
        }
    };
    let prefix_len = prefix.len();
    let mut unkept: Vec<StaleOutput> = Vec::new();
    let mut found = bun_collections::StringSet::new();
    for (name, listed) in &entries {
        prefix.truncate(prefix_len);
        prefix.extend_from_slice(name);
        // A checkout that is deployed from the output directory keeps its repository.
        if prefix_len == 0 && name == b".git" {
            continue;
        }
        let Some(&wanted) = kept.paths.get(&prefix[..]) else {
            unkept.push(StaleOutput {
                path: Box::from(&prefix[..]),
                is_directory: *listed == EntryKind::Directory,
            });
            continue;
        };
        bun_core::handle_oom(found.insert(name));
        let kind = match *listed {
            EntryKind::Unknown => kind_of(dir, name),
            known => known,
        };
        match (wanted, kind) {
            (Kept::File, EntryKind::File) => continue,
            (Kept::Directory, EntryKind::Directory) => {
                let options = bun_sys::OpenDirOptions {
                    iterate: true,
                    no_follow: true,
                };
                match dir.open_dir(name, options) {
                    Ok(subdirectory) => {
                        prefix.push(b'/');
                        find_unkept(&subdirectory, prefix, kept, stale, failure);
                        continue;
                    }
                    Err(e) if e.get_errno() == E::ENOENT => continue,
                    // A link took its place since the listing.
                    Err(e) if matches!(e.get_errno(), E::ENOTDIR | E::ELOOP) => {}
                    Err(e) => {
                        failure.get_or_insert_with(|| (e, prefix.clone()));
                        continue;
                    }
                }
            }
            // In the way of a write, or the bytecode of a chunk.
            _ => {}
        }
        remove_now(name, prefix, failure);
    }
    prefix.truncate(prefix_len);

    // Where names differ only by case, or by how a character is composed, an entry can be the file of a kept name
    // that the listing does not have. Removed after the writes, it would take the new file with it.
    let is_absent = |name: &[u8]| {
        let mut buf = bun_paths::path_buffer_pool::get();
        bun_sys::lstatat(dir.fd(), paths::resolve_path::z(name, &mut buf)).is_err()
    };
    let kept_names = kept.children.get(&prefix[..prefix_len.saturating_sub(1)]);
    let has_alias = kept_names.is_some_and(|names| {
        found.count() < names.len()
            && (names.iter()).any(|name| !found.contains(name) && !is_absent(name))
    });
    if has_alias {
        for entry in &unkept {
            remove_now(&entry.path[prefix_len..], &entry.path, failure);
        }
    } else {
        stale.append(&mut unkept);
    }
}

/// For a listing that does not tell what an entry is.
fn kind_of(dir: &bun_sys::Dir, name: &[u8]) -> bun_sys::EntryKind {
    let mut buf = bun_paths::path_buffer_pool::get();
    match bun_sys::lstatat(dir.fd(), paths::resolve_path::z(name, &mut buf)) {
        Ok(stat) => bun_sys::kind_from_mode(stat.st_mode as bun_sys::Mode),
        Err(_) => bun_sys::EntryKind::Unknown,
    }
}

/// `clean`: the build has written its files, and what `find_stale_outputs` found goes. An entry that cannot be removed
/// fails the build, which is whole by then.
#[inline]
fn remove_stale_outputs(
    log: &mut bun_ast::Log,
    root_dir: &bun_sys::Dir,
    root_path: &[u8],
    stale: Option<Vec<StaleOutput>>,
) -> Result<(), Error> {
    match stale {
        None => Ok(()),
        Some(stale) => remove_each(log, root_dir, root_path, stale),
    }
}

#[cold]
#[inline(never)]
fn remove_each(
    log: &mut bun_ast::Log,
    root_dir: &bun_sys::Dir,
    root_path: &[u8],
    stale: Vec<StaleOutput>,
) -> Result<(), Error> {
    let mut failure: RemovalFailure = None;
    let mut buf = bun_paths::path_buffer_pool::get();
    for entry in stale {
        let is_removed = entry.is_directory
            && match bun_sys::rmdirat(root_dir.fd(), paths::resolve_path::z(&entry.path, &mut buf))
            {
                Ok(()) => true,
                // A mount point stays, with what is in it: `rmdir` refuses one before it looks inside. On Windows
                // the error is for a directory in use, which is removed like any other.
                Err(e) => cfg!(not(windows)) && e.get_errno() == bun_sys::E::EBUSY,
            };
        if !is_removed && let Err(e) = root_dir.delete_tree(&entry.path) {
            failure.get_or_insert_with(|| (e, entry.path.into_vec()));
        }
    }
    match failure {
        None => Ok(()),
        Some((e, path)) => Err(fail_to_remove(log, &e, &path, root_path)),
    }
}
