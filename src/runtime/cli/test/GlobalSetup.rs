//! `globalSetup` and `globalTeardown` of `bun test`: modules that run once
//! per run, before the first test file is loaded and after the last one ends.
//!
//! They run in a process of their own, the host: `bun -e` with
//! `global-setup-entry.ts`, started by the process that owns the run and kept
//! for the whole run. It is not the test process, because what a setup starts
//! has to stay up while the test files run, and the test process keeps
//! nothing: `--isolate` closes every socket, timer and child process between
//! two files, and `--parallel` runs the files in workers that come and go. A
//! process that is nobody's test file is the same thing in every mode.
//!
//! Two pipes connect the two. On its fd 3 the host reports (the protocol is
//! at the top of `global-setup-entry.ts`): when the setup is over, with what
//! it did to `process.env`, and when the teardown is. Its fd 4 is the control
//! pipe. One byte on it says that the run is going to happen, and the setup
//! starts. After that this process closes its end to ask for the teardown,
//! and the kernel closes it when this process dies (a crash, a signal, the
//! `execve` of `--watch`), so the teardown runs either way. The end of that
//! pipe is the only thing that ends the run for the host: it ignores the
//! signals that stop a process for as long as the pipe is open, because a
//! terminal sends them to both processes and only this one knows whether the
//! run goes on.
//!
//! The waits are blocking reads: before the setup has reported there is
//! nothing to run, and after the last test file there is nothing left to run.
//! They have no time limit. A setup may pull images for minutes, and a limit
//! on a teardown would leave behind what it was about to remove.
//! The host is only ever touched under [`HOST`]'s lock, so whoever comes
//! second (an exit from another thread, say) waits for the first.
//!
//! Nothing waits for the teardown while the test process still runs its
//! files, because a teardown may wait for them: a server that closes once
//! its clients are gone. So the exit of the process stops the VM first, which
//! closes what the files left open, and a restart of `--watch` does not wait
//! at all: the next run does, for a host that the restart left behind.

use core::ffi::c_char;
use std::io::Write as _;

use bun_core::{Global, Output, pretty_errorln, strings};
use bun_jsc::virtual_machine::VirtualMachine;
use bun_resolver::fs::FileSystem;
use bun_sys::{Fd, FdExt as _};

use crate::api::bun::process::{self as spawn, SpawnOptions, Stdio};
use crate::cli::Command;

const ENTRY_SOURCE: &[u8] = include_bytes!("./global-setup-entry.ts");

/// `--watch` restarts with `execve`, so the next run is this same process and
/// the host of the run it interrupted is still its child, tearing down. The
/// next run waits for that host before its own setup starts, and this
/// variable of the real environment is how it knows which child that is.
#[cfg(unix)]
const PREVIOUS_HOST_ENV: &core::ffi::CStr = c"BUN_INTERNAL_TEST_GLOBAL_SETUP_PID";

/// Variables that are meant for the test process and not for the host. It
/// gets all the others. (The IPC channel to the parent of this process is not
/// one of them: the environment of `vm` never has it.)
const NOT_INHERITED: [&[u8]; 5] = [
    // This process already applied these flags, and hands the host the ones that are for it.
    b"BUN_OPTIONS",
    // The debugger of a run is there for the test files. The host would
    // listen where the test process listens, or wait for a client of its own.
    b"BUN_INSPECT",
    b"BUN_INSPECT_CONNECT_TO",
    b"BUN_INSPECT_NOTIFY",
    b"BUN_INSPECT_PRELOAD",
];

struct Host {
    #[cfg(unix)]
    pid: libc::pid_t,
    /// The read end of the pipe that is the host's fd 3.
    report: Fd,
    /// The write end of the pipe that is the host's fd 4.
    control: Fd,
    /// How the setup ended: `R` when it completed, which is when the host
    /// reports its teardown too, `E` when it failed, 0 when the host ended
    /// without a word, and `-` while nobody has asked for the setup.
    setup: u8,
    /// What was read after the end of a message.
    pending: Vec<u8>,
}

/// The host of this run, from its start until its teardown is over.
static HOST: bun_core::Mutex<Option<Host>> = bun_core::Mutex::new(None);
/// The resolved setup and teardown files, for [`watch_files`].
static FILES: bun_core::Mutex<Vec<Box<[u8]>>> = bun_core::Mutex::new(Vec::new());

/// Whether this process sets a run up: there is something to set up, and the
/// run is this process's. A `--parallel` worker never gets as far as to ask.
/// With `--aot` the process that compiles starts another one that runs, and
/// that one asks too. A file of `node:test`'s `run()` is a `bun test` of its
/// own, once per file, in a run that belongs to the caller of `run()`.
pub(crate) fn owns_run(ctx: &Command::ContextData) -> bool {
    (!ctx.test_options.global_setup.is_empty() || !ctx.test_options.global_teardown.is_empty())
        && !ctx.test_options.run_child
        && !crate::cli::run_compiled::is_requested(ctx)
}

/// Starts the host, which then waits to be told that the run is going to
/// happen. `false`: there is no host, and the reason is printed.
///
/// Only the process that owns a run calls this: not a `--parallel` worker,
/// not the process that compiles for `--aot`, not a file of `node:test`'s
/// `run()`. Call it after [`wait_for_previous_host`] and before the file
/// watcher starts (see [`remember_host`]), then [`run`], and [`finish_now`]
/// when the process goes on after the run.
/// Every way out of the process asks for the teardown and waits for it.
pub(crate) fn spawn(ctx: &Command::ContextData, vm: &mut VirtualMachine) -> bool {
    let (Some(setup_files), Some(teardown_files)) = (
        resolve_all(vm, &ctx.test_options.global_setup, "globalSetup"),
        resolve_all(vm, &ctx.test_options.global_teardown, "globalTeardown"),
    ) else {
        return false;
    };
    let mut files_json = b"{\"setup\":".to_vec();
    files_json.extend_from_slice(&json_array(&setup_files));
    files_json.extend_from_slice(b",\"teardown\":");
    files_json.extend_from_slice(&json_array(&teardown_files));
    files_json.push(b'}');
    // One placeholder, so that no path is searched for another one.
    let code = replace_first(ENTRY_SOURCE, b"__GLOBAL_SETUP_FILES__", &files_json);
    {
        let mut files = FILES.lock();
        files.extend(setup_files);
        files.extend(teardown_files);
    }

    // What the host prints comes after what this process has printed so far.
    Output::flush();
    let Some(host) = spawn_host(ctx, vm, &code) else {
        return false;
    };
    #[cfg(unix)]
    if ctx.debug.hot_reload == bun_options_types::context::HotReload::Watch {
        remember_host(host.pid);
    }
    *HOST.lock() = Some(host);

    // The VM lets go of what the test files left open before the process
    // waits for the teardown, which may be waiting for just that: a server
    // that closes once its clients are gone.
    vm.exit_handler.before_process_exit = Some(before_process_exit);
    // For the ways out that do not go through the VM. Ahead of the callbacks
    // that `--no-orphans` kills every child of this process from.
    Global::add_pre_exit_callback(finish_on_exit);
    true
}

/// Has the host run the setup and returns once it is over. `false`: it
/// failed, and no test file may run. What it changed in `process.env` is in
/// the environment of `vm` afterwards, which every test file and worker gets.
pub(crate) fn run(vm: &mut VirtualMachine) -> bool {
    let mut host = HOST.lock();
    let Some(host) = host.as_mut() else {
        return false;
    };
    Output::flush();
    if bun_sys::write(host.control, b"g").is_err() {
        host.setup = 0;
        return false;
    }
    let message = host.read_message();
    host.setup = message.as_ref().map_or(0, |(status, _)| *status);
    if let Some((b'R', records)) = message {
        apply_env_changes(vm, &records);
        return true;
    }
    false
}

/// Asks the host for the teardown and returns once it is over and the host is
/// gone. `false`, with the reason printed: the setup or the teardown failed,
/// or the host did not live to run them. Does nothing, and is `true`, when no
/// host is running.
pub(crate) fn finish() -> bool {
    let mut slot = HOST.lock();
    let Some(mut host) = slot.take() else {
        return true;
    };
    Output::flush();
    host.control.close();
    // A host that did not complete a setup has nothing more to say. Its pipe
    // ends when what it did set up is torn down.
    let teardown = host.read_message().map(|(status, _)| status);
    host.report.close();
    // After its last message the host has only its `exit` listeners left to run.
    #[cfg(unix)]
    let ended = wait_for(host.pid);
    #[cfg(not(unix))]
    let ended: Option<core::ffi::c_int> = None;

    // The host has printed the error of a setup or a teardown that failed.
    let (error, died) = match (host.setup, teardown) {
        (b'-', _) | (b'R', Some(b'D')) => return true,
        (b'R', Some(b'F')) => ("the global teardown failed", false),
        (b'R', Some(b'U')) => (
            "an error was not caught in the global setup process while the tests ran",
            false,
        ),
        (b'R', _) => (
            "the global setup process ended before the teardown was over",
            true,
        ),
        (b'E', _) => ("the global setup failed, so no test file was run", false),
        _ => (
            "the global setup process ended before the setup was over, so no test file was run",
            true,
        ),
    };
    match ended.filter(|_| died).and_then(how_it_ended) {
        Some(how) => pretty_errorln!("<r><red>error<r><d>:<r> {} <d>({})<r>", error, how),
        None => pretty_errorln!("<r><red>error<r><d>:<r> {}", error),
    }
    Output::flush();
    false
}

/// "exited with code 1", "was killed by SIGKILL": what a wait status says.
fn how_it_ended(status: core::ffi::c_int) -> Option<String> {
    #[cfg(unix)]
    {
        if libc::WIFEXITED(status) {
            return Some(format!("it exited with code {}", libc::WEXITSTATUS(status)));
        }
        if libc::WIFSIGNALED(status) {
            let signal = libc::WTERMSIG(status);
            return Some(match bun_core::SignalCode::from_number(signal) {
                Some(code) => format!("it was killed by {}", code.name()),
                None => format!("it was killed by signal {signal}"),
            });
        }
    }
    let _ = status;
    None
}

/// [`finish`] for a process that goes on: one that `--watch` keeps, or one
/// that has more to say before it exits.
pub(crate) fn finish_now(vm: &mut VirtualMachine) -> bool {
    vm.exit_handler.before_process_exit = None;
    finish()
}

/// `ExitHandler::before_process_exit`: a teardown that failed fails a run that
/// was going to exit with 0, however it came to exit.
fn before_process_exit(exit_code: u8) -> u8 {
    match finish() {
        false if exit_code == 0 => 1,
        _ => exit_code,
    }
}

/// For the ways out that do not go through the exit of the VM: the abort of
/// the `--parallel` coordinator, an error before a file is loaded. They all
/// exit with a code that is not 0, so a teardown that fails changes nothing.
extern "C" fn finish_on_exit() {
    let _ = finish();
}

/// Has `--watch` restart the run when a setup or a teardown file changes.
/// The test process never loads them, so its module graph does not have
/// them, nor the modules that they import.
pub(crate) fn watch_files(vm: &VirtualMachine) {
    for path in FILES.lock().iter() {
        vm.add_to_watcher_if_needed(path);
    }
}

impl Host {
    /// The next message of the host: its status byte, and its records with the
    /// NUL that ends each. `None`: the pipe ended first, so the host is gone.
    fn read_message(&mut self) -> Option<(u8, Vec<u8>)> {
        let mut message = core::mem::take(&mut self.pending);
        // Where the record that is being read starts. A NUL there is the
        // empty record that ends a message.
        let mut record_start: usize = 1;
        let mut chunk = [0u8; 16 * 1024];
        loop {
            while record_start < message.len() {
                let Some(nul) = strings::index_of_char_usize(&message[record_start..], 0) else {
                    break;
                };
                if nul == 0 {
                    self.pending = message.split_off(record_start + 1);
                    message.truncate(record_start);
                    let records = message.split_off(1);
                    return Some((message[0], records));
                }
                record_start += nul + 1;
            }
            match bun_sys::read(self.report, &mut chunk) {
                Ok(0) => return None,
                Ok(n) => message.extend_from_slice(&chunk[..n]),
                Err(err) if err.get_errno() == bun_sys::E::EINTR => {}
                Err(_) => return None,
            }
        }
    }
}

/// `None`: the host did not start, and the error is printed.
fn spawn_host(ctx: &Command::ContextData, vm: &mut VirtualMachine, code: &[u8]) -> Option<Host> {
    let failed = |what: &dyn core::fmt::Display| {
        pretty_errorln!(
            "<r><red>error<r><d>:<r> failed to start the global setup process: {}",
            what
        );
        Output::flush();
    };

    let lit = |s: &'static [u8]| -> *const c_char { s.as_ptr().cast::<c_char>() };
    let Ok(exe) = bun_core::self_exe_path() else {
        failed(&"the path of bun is not known");
        return None;
    };
    let mut argv: Vec<bun_spawn::CStrPtr> = vec![
        exe.as_ptr(),
        // A test file never installs the package that an import names, and neither does a setup file.
        lit(b"--no-install\0"),
        // The environment of this process already holds the values of its env files.
        lit(b"--no-env-file\0"),
    ];
    // Without it the host reads the bunfig.toml of the project root, as this process did.
    if let Some(bunfig) = &ctx.debug.named_bunfig {
        let mut flag = b"--config=".to_vec();
        flag.extend_from_slice(bunfig);
        argv.push(crate::cli::cli_dupe_z(&flag));
    }
    if let Err(err) = super::parallel::runner::push_code_loading_argv(ctx, &mut argv) {
        failed(&err.name());
        return None;
    }
    argv.push(lit(b"-e\0"));
    argv.push(crate::cli::cli_dupe_z(code));
    argv.push(core::ptr::null());

    // SAFETY: the env loader is set before the test command runs, and nothing else borrows it here.
    let env = unsafe { &mut *vm.transpiler.env };
    let not_inherited = NOT_INHERITED.map(|name| (name, env.map.get(name).map(Box::<[u8]>::from)));
    for (name, _) in &not_inherited {
        env.map.remove(name);
    }
    // The setup runs in the time zone of the test files. They get their
    // default without a variable, and a `bun -e` takes its zone from one.
    let default_time_zone = env.map.get(b"TZ").is_none();
    if default_time_zone {
        bun_core::handle_oom(
            env.map
                .put(b"TZ", crate::cli::test_command::DEFAULT_TIME_ZONE),
        );
    }
    let envp = bun_core::handle_oom(env.map.create_null_delimited_env_map());
    if default_time_zone {
        env.map.remove(b"TZ");
    }
    for (name, value) in &not_inherited {
        if let Some(value) = value {
            bun_core::handle_oom(env.map.put(name, value));
        }
    }

    let pipes = bun_sys::pipe().and_then(|report| match bun_sys::pipe() {
        Ok(control) => Ok((report, control)),
        Err(err) => {
            report[0].close();
            report[1].close();
            Err(err)
        }
    });
    let (report, control) = match pipes {
        Ok(pipes) => pipes,
        Err(err) => {
            failed(&err);
            return None;
        }
    };
    // The ends of this process. A child that got the control one would keep
    // the teardown from starting when this process dies.
    #[cfg(unix)]
    {
        let _ = bun_sys::set_close_on_exec(report[0]);
        let _ = bun_sys::set_close_on_exec(control[1]);
    }

    // The host stays in the process group of this process, which a worker
    // does not. A terminal can then stop a setup or a teardown that hangs
    // (Ctrl-C reaches the host), and a setup can ask on the terminal. The
    // host ignores the signals of a group while the run lasts.
    let options = SpawnOptions {
        stdin: Stdio::Inherit,
        stdout: Stdio::Inherit,
        stderr: Stdio::Inherit,
        // fd 3 and fd 4 of the host.
        extra_fds: vec![Stdio::Pipe(report[1]), Stdio::Pipe(control[0])].into_boxed_slice(),
        cwd: Box::from(FileSystem::get().top_level_dir()),
        // `finish` waits for the host with `waitpid`, so nothing needs a pidfd of it.
        can_block_entire_thread_to_reduce_cpu_usage_in_fast_path: true,
        #[cfg(windows)]
        windows: spawn::WindowsOptions {
            loop_: bun_jsc::EventLoopHandle::init(vm.event_loop().cast()),
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: `argv` and `envp` are null-terminated arrays of C strings, and `argv[0]` is not null.
    let spawned = unsafe { spawn::spawn_process(&options, argv.as_ptr(), envp.as_ptr()) };
    // The host has its own copies of these two ends. While this process holds
    // one of the report pipe, that pipe does not end when the host does.
    report[1].close();
    control[0].close();
    #[cfg_attr(unix, allow(unused_mut))]
    let mut spawned = match spawned {
        Ok(Ok(spawned)) => spawned,
        Ok(Err(err)) => {
            report[0].close();
            control[1].close();
            failed(&err);
            return None;
        }
        Err(err) => {
            report[0].close();
            control[1].close();
            failed(&err);
            return None;
        }
    };

    // libuv watches every process it spawns. This one is not a handle of any
    // test file: it must not keep their event loop alive, and nothing closes
    // it, so the `Process` is never released.
    #[cfg(windows)]
    {
        let process = spawned.to_process_handle(vm.event_loop());
        process.process_mut().disable_keeping_event_loop_alive();
        core::mem::forget(process);
    }

    Some(Host {
        #[cfg(unix)]
        pid: spawned.pid,
        report: report[0],
        control: control[1],
        setup: b'-',
        pending: Vec::new(),
    })
}

/// The absolute path of every module in `specifiers`, resolved from the
/// project root the way a test file is. `None`: one of them does not resolve,
/// and the error is printed.
fn resolve_all(
    vm: &mut VirtualMachine,
    specifiers: &[Box<[u8]>],
    key: &str,
) -> Option<Vec<Box<[u8]>>> {
    let mut paths: Vec<Box<[u8]>> = Vec::with_capacity(specifiers.len());
    for specifier in specifiers {
        // SAFETY: `vm.log` points at the log that the VM owns, for as long as the VM lives.
        let said = vm.log.map_or(0, |log| unsafe { log.as_ref() }.msgs.len());
        let dot_slash = core::cell::OnceCell::new();
        let resolved = vm
            .transpiler
            .resolve_entry_point(specifier, &dot_slash)
            .map(|resolution| Box::<[u8]>::from(resolution.path_pair.primary.text));
        // What the resolver logged on the way would be printed after the
        // first test file. It is for here: with the error, or for nobody.
        // SAFETY: as above, and nothing else borrows the log here.
        let log = vm.log.map(|log| unsafe { &mut *log.as_ptr() });
        let not_found = resolved
            .as_ref()
            .is_err_and(|err| err.name() == "ModuleNotFound");
        if let Some(log) = log {
            let mut logged = log.msgs.split_off(said.min(log.msgs.len()));
            for message in &logged {
                match message.kind {
                    bun_ast::Kind::Err => log.errors = log.errors.saturating_sub(1),
                    bun_ast::Kind::Warn => log.warnings = log.warnings.saturating_sub(1),
                    _ => {}
                }
            }
            if not_found {
                // The line that says so without the name of the key.
                logged.pop();
            }
            if resolved.is_err() {
                let mut failure = bun_ast::Log::default();
                failure.msgs = logged;
                let _ = failure.print(std::ptr::from_mut::<bun_core::io::Writer>(
                    Output::error_writer(),
                ));
            }
        }
        match resolved {
            Ok(path) => paths.push(path),
            Err(_) => {
                if not_found {
                    pretty_errorln!(
                        "<r><red>error<r><d>:<r> {} not found: <b>{}<r>",
                        key,
                        bun_core::fmt::quote(specifier)
                    );
                }
                Output::flush();
                return None;
            }
        }
    }
    Some(paths)
}

fn replace_first(source: &[u8], placeholder: &[u8], with: &[u8]) -> Vec<u8> {
    let index =
        strings::index_of(source, placeholder).expect("placeholder in global-setup-entry.ts");
    [&source[..index], with, &source[index + placeholder.len()..]].concat()
}

/// A JavaScript array literal of strings.
fn json_array(paths: &[Box<[u8]>]) -> Vec<u8> {
    let mut out: Vec<u8> = vec![b'['];
    for (i, path) in paths.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        let _ = write!(
            &mut out,
            "{}",
            bun_core::fmt::format_json_string_utf8(path, Default::default())
        );
    }
    out.push(b']');
    out
}

/// `records` is what the setup did to `process.env`: `+NAME=value` and
/// `-NAME`, each ended by a NUL. The test files read `process.env` from the
/// environment of `vm`, and a worker starts with it.
fn apply_env_changes(vm: &mut VirtualMachine, records: &[u8]) {
    // SAFETY: the env loader is set before the test command runs, and nothing else borrows it here.
    let env = unsafe { &mut *vm.transpiler.env };
    for record in strings::split(records, b"\0") {
        let Some((&kind, rest)) = record.split_first() else {
            continue;
        };
        match kind {
            b'+' => {
                // A name is not empty, and on Windows it can start with `=`.
                let Some(equals) = rest
                    .get(1..)
                    .and_then(|tail| strings::index_of_char_usize(tail, b'='))
                else {
                    continue;
                };
                let (name, value) = (&rest[..equals + 1], &rest[equals + 2..]);
                bun_core::handle_oom(env.map.put(name, value));
            }
            b'-' => env.map.remove(rest),
            _ => {}
        }
    }
}

/// Waits for the host that a restart of `--watch` left behind, if there is
/// one: see [`PREVIOUS_HOST_ENV`]. Every run calls this before its own watcher
/// thread starts and before it starts any process, whether or not it has a
/// setup of its own.
#[cfg(unix)]
pub(crate) fn wait_for_previous_host(vm: &mut VirtualMachine) {
    // SAFETY: the name is a C string, and the value is copied before anything can change the environment.
    let previous = unsafe {
        let value = libc::getenv(PREVIOUS_HOST_ENV.as_ptr());
        if value.is_null() {
            return;
        }
        core::ffi::CStr::from_ptr(value).to_bytes().to_vec()
    };
    // The variable was in the environment this process started with, so it is
    // in the one of `vm`, which the test files and every child process get.
    // SAFETY: as in `remember_host` and in `apply_env_changes`.
    unsafe {
        libc::unsetenv(PREVIOUS_HOST_ENV.as_ptr());
        (*vm.transpiler.env)
            .map
            .remove(PREVIOUS_HOST_ENV.to_bytes());
    }
    if let Ok(pid) = strings::parse_int::<libc::pid_t>(&previous, 10)
        && pid > 0
    {
        wait_for(pid);
    }
}

/// See [`PREVIOUS_HOST_ENV`]. The environment is only safe to change while no
/// other thread reads it, so this is for before the watcher thread starts.
#[cfg(unix)]
fn remember_host(pid: libc::pid_t) {
    let mut value: Vec<u8> = Vec::new();
    let _ = write!(&mut value, "{pid}\0");
    // SAFETY: both are C strings, and `setenv` copies them.
    unsafe {
        libc::setenv(PREVIOUS_HOST_ENV.as_ptr(), value.as_ptr().cast(), 1);
    }
}

/// Blocks until the child `pid` has ended, and reaps it. Its wait status, or
/// `None` for a pid that is not a child of this process or that is reaped
/// already: that one returns at once.
#[cfg(unix)]
fn wait_for(pid: libc::pid_t) -> Option<core::ffi::c_int> {
    loop {
        let mut status: core::ffi::c_int = 0;
        // SAFETY: `status` is a valid out-pointer.
        let rc = unsafe { libc::waitpid(pid, &raw mut status, 0) };
        if rc == -1 && bun_sys::last_errno() == libc::EINTR {
            continue;
        }
        return (rc == pid).then_some(status);
    }
}
