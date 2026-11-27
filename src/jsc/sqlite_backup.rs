//! What a backup of an SQLite database asks of the file system around what SQLite does with the file
//! (`src/jsc/bindings/sqlite/SqliteBackup.cpp`).
//!
//! None of these opens a file that SQLite has open: to close a descriptor of a file gives up every lock that the
//! process holds on the file, and SQLite holds its locks on the destination until the backup is committed.

use core::ffi::c_char;

use bun_core::ZStr;
use bun_sys::O;

/// Makes the file. False if a file is there already, or if it cannot be made: SQLite then says why.
///
/// # Safety
/// `path` is NUL-terminated and readable during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Bun__SqliteBackup__createFile(path: *const c_char) -> bool {
    // SAFETY: the caller's contract.
    let path = unsafe { ZStr::from_c_ptr(path) };
    // The mode of a database that SQLite makes.
    bun_sys::File::open(path, O::WRONLY | O::CREAT | O::EXCL, 0o644).is_ok()
}

/// Removes the file that a backup made and did not complete. With `only_if_empty` a file with content stays: SQLite
/// has rolled back what this backup wrote, so the content is somebody else's.
///
/// # Safety
/// `path` is NUL-terminated and readable during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Bun__SqliteBackup__removeFile(path: *const c_char, only_if_empty: bool) {
    // SAFETY: the caller's contract.
    let path = unsafe { ZStr::from_c_ptr(path) };
    if path.is_empty() {
        return;
    }
    if only_if_empty && !bun_sys::stat(path).is_ok_and(|stat| stat.st_size == 0) {
        return;
    }
    let _ = bun_sys::unlink(path);
}

/// Whether the two paths name one file, under whatever names. False if either cannot be read, and on a file system
/// that gives its files no id.
///
/// # Safety
/// Both are NUL-terminated and readable during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Bun__SqliteBackup__isSameFile(a: *const c_char, b: *const c_char) -> bool {
    // SAFETY: the caller's contract.
    let (a, b) = unsafe { (ZStr::from_c_ptr(a), ZStr::from_c_ptr(b)) };
    match (bun_sys::stat(a), bun_sys::stat(b)) {
        (Ok(a), Ok(b)) => a.st_ino != 0 && a.st_dev == b.st_dev && a.st_ino == b.st_ino,
        _ => false,
    }
}

/// Work pool, or the thread of the connection for a small file. The name of a new file is in its directory: this
/// puts the directory on the disk. Windows has nothing to do here.
///
/// # Safety
/// `path` is NUL-terminated and readable during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Bun__SqliteBackup__syncDirectoryOf(path: *const c_char) {
    // SAFETY: the caller's contract.
    let path = unsafe { ZStr::from_c_ptr(path) };
    #[cfg(unix)]
    if let Some(directory) = bun_paths::dirname(path.as_bytes()) {
        if let Ok(directory) = bun_sys::File::openat(bun_sys::Fd::cwd(), directory, O::RDONLY, 0) {
            let _ = bun_sys::fsync(directory.handle());
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}
