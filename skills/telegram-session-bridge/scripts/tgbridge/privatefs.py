"""Platform-specific private files, directory durability and collector locking."""

import os
import stat
from pathlib import Path

if os.name == "nt":
    import functools

    import pywintypes

    from . import windows_security

    def _safe_windows_error(function):
        @functools.wraps(function)
        def wrapped(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except pywintypes.error as exc:
                raise OSError(
                    exc.winerror, "Windows private storage operation failed"
                ) from None

        return wrapped

    check_private = _safe_windows_error(windows_security.check_private)
    open_nofollow = _safe_windows_error(windows_security.open_nofollow)
    private_directory = _safe_windows_error(windows_security.private_directory)
    readonly_snapshot = _safe_windows_error(windows_security.readonly_snapshot)
else:

    def check_private(path, *, directory=False, fd=None):
        info = os.fstat(fd) if fd is not None else path.stat()
        if (
            not (
                stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
            )
            or info.st_mode & 0o077
            or info.st_uid != os.getuid()
        ):
            raise ValueError("Storage must be privately owned")

    def private_directory(path, *, parents=True):
        path.mkdir(mode=0o700, parents=parents, exist_ok=True)
        check_private(path, directory=True)

    def open_nofollow(path, flags, mode=0o600):
        return os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode)

    def readonly_snapshot(fd):
        os.fchmod(fd, 0o400)


def safe_path(value):
    path = Path(value)
    if ".." in path.parts:
        raise ValueError("Unsafe path")
    path = path.absolute()
    if os.name == "nt" and any(
        ":" in part or part.endswith((".", " ")) for part in path.parts[1:]
    ):
        raise ValueError("Unsafe Windows path component")
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError("Links and junctions are not permitted")
        if (
            os.name == "nt"
            and part.exists()
            and part.stat(follow_symlinks=False).st_file_attributes
            & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise ValueError("Reparse points are not permitted")
    return path


def sync_directory(path):
    if os.name == "nt":
        # Windows has no supported fsync for directory handles. File contents are
        # flushed before atomic replacement; do not claim POSIX power-loss durability.
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def lock_fd(fd):
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def runtime_root():
    if os.name == "nt":
        from win32com.shell import shell, shellcon

        # The OS profile location is stable across TEMP overrides and sessions.
        return (
            Path(shell.SHGetFolderPath(0, shellcon.CSIDL_LOCAL_APPDATA, None, 0))
            / "tgbridge-locks"
        )
    return Path("/tmp") / f"tgbridge-{os.getuid()}"
