"""Atomic write helpers shared by every mm module that persists files.

Temp files are always written BESIDE their destination (never
tempfile.gettempdir()/%TEMP%, which may be a different volume and would
silently break os.replace atomicity), flushed, fsynced, closed, then swapped
in with os.replace under a bounded retry loop that tolerates the transient
PermissionError / winerror-5 / winerror-32 sharing violations AV scanners
and open handles cause on Windows.
"""

import contextlib
import hashlib
import os
import pathlib
import time


class AtomicWriteError(RuntimeError):
    pass


class DestinationAppeared(AtomicWriteError):
    """A destination absent from the caller's snapshot appeared before this process could create it."""


# While a journal() block runs: normalized path -> identity() of the bytes this process swapped in there,
# and the destinations still to be created without ever replacing a file (absent from the snapshot).
_journal = None
_fresh = set()


@contextlib.contextmanager
def journal(fresh=()):
    """Record every file this process swaps in inside the block: the
    identity (identity()) of the temp file, taken before the swap, under the
    destination path. A restore uses it to tell a file this run wrote from
    one another writer created (write_status()).

    Each destination in `fresh` (absent when the caller took its snapshot)
    is published the first time with no overwrite: when another writer
    created it in the meantime, the write raises DestinationAppeared, leaves
    that file untouched and removes only this process's temp file."""
    global _journal, _fresh
    outer = (_journal, _fresh)
    _journal, _fresh = {}, {_journal_key(p) for p in fresh}
    try:
        yield _journal
    finally:
        _journal, _fresh = outer


def _journal_key(path) -> str:
    return os.path.normcase(os.path.abspath(path))


def _forget(path) -> None:
    if _journal is not None:
        _journal.pop(_journal_key(path), None)


def identity(path):
    """(st_dev, st_ino, size, mtime_ns, sha256) of the file at `path`, taken
    from one open handle, or None when there is no file. st_dev and st_ino are
    0 where the platform gives none (see write_status())."""
    try:
        with open(path, "rb") as fh:
            st = os.fstat(fh.fileno())
            digest = hashlib.sha256(fh.read()).hexdigest()
    except FileNotFoundError:
        return None
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, digest)


def write_status(recorded: dict, path) -> str:
    """How the file at `path` stands against `recorded` (a journal()):
    "match"      it still has the identity recorded when this process wrote
                 it, including a real file id (st_dev, st_ino): proven;
    "unproven"   it matches, but the platform gives no file id, so size, time
                 and bytes alone cannot prove it is the same file;
    "changed"    a write is recorded, but the file no longer has its identity;
    "unrecorded" no write of it is recorded."""
    expected = (recorded or {}).get(_journal_key(path))
    if expected is None:
        return "unrecorded"
    if identity(path) != expected:
        return "changed"
    return "match" if expected[0] and expected[1] else "unproven"


def _publish(tmp: pathlib.Path, path: pathlib.Path, fresh: bool) -> None:
    """Swap tmp in at path. A fresh destination is never replaced: FileExistsError when it exists."""
    if not fresh:
        os.replace(tmp, path)
    elif os.name == "nt":
        os.rename(tmp, path)
    else:
        os.link(tmp, path)
        _unlink_quiet(tmp)


def _unlink_quiet(tmp: pathlib.Path) -> None:
    try:
        tmp.unlink()
    except OSError:
        pass


def _tmp_name(path: pathlib.Path) -> pathlib.Path:
    return path.with_name(path.name + ".tmp-" + os.urandom(4).hex())


def _stage_text(tmp: pathlib.Path, text: str, encoding: str, newline: str) -> None:
    with open(tmp, "w", encoding=encoding, newline=newline) as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())


def _stage_bytes(tmp: pathlib.Path, data: bytes) -> None:
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def _replace_with_retry(
    tmp: pathlib.Path,
    path: pathlib.Path,
    retries: int,
    retry_delay_s: float,
) -> None:
    last_error = None
    try:
        recorded = identity(tmp) if _journal is not None else None
    except OSError:
        _unlink_quiet(tmp)
        raise
    key = _journal_key(path)
    fresh = _journal is not None and key in _fresh
    for attempt in range(retries):
        try:
            _publish(tmp, path, fresh)
            if recorded is not None:
                _journal[key] = recorded
            _fresh.discard(key)
            return
        except FileExistsError as exc:
            _unlink_quiet(tmp)
            if fresh:
                raise DestinationAppeared(f"{path} appeared after the backup, before this run could create it: "
                                          "it is another writer's file and was left untouched") from exc
            raise
        except PermissionError as exc:
            last_error = exc
        except OSError as exc:
            if getattr(exc, "winerror", None) in (5, 32):
                last_error = exc
            else:
                _unlink_quiet(tmp)
                raise
        if attempt < retries - 1:
            time.sleep(retry_delay_s)
    _unlink_quiet(tmp)
    raise AtomicWriteError(
        f"failed to replace {path} after {retries} attempts: {last_error}"
    )


def atomic_write_text(
    path: pathlib.Path,
    text: str,
    *,
    encoding: str = "utf-8",
    newline: str = "\n",
    retries: int = 5,
    retry_delay_s: float = 0.15,
) -> None:
    path = pathlib.Path(path)
    tmp = _tmp_name(path)
    try:
        _stage_text(tmp, text, encoding, newline)
    except Exception:
        _unlink_quiet(tmp)
        raise
    _replace_with_retry(tmp, path, retries, retry_delay_s)


def atomic_write_bytes(
    path: pathlib.Path,
    data: bytes,
    *,
    retries: int = 5,
    retry_delay_s: float = 0.15,
) -> None:
    path = pathlib.Path(path)
    tmp = _tmp_name(path)
    try:
        _stage_bytes(tmp, data)
    except Exception:
        _unlink_quiet(tmp)
        raise
    _replace_with_retry(tmp, path, retries, retry_delay_s)


def exclusive_dir(parent: pathlib.Path, name: str) -> pathlib.Path:
    """Create a new folder `name` under `parent`, never reusing an existing
    one: on a collision it takes `name-2`, `name-3`, ... instead."""
    parent = pathlib.Path(parent)
    parent.mkdir(parents=True, exist_ok=True)
    for n in range(1, 1000):
        target = parent / (name if n == 1 else f"{name}-{n}")
        try:
            target.mkdir()
            return target
        except FileExistsError:
            continue
    raise AtomicWriteError(f"no free folder name for {name} under {parent}")


def atomic_write_many(
    items: list,
    *,
    encoding: str = "utf-8",
    newline: str = "\n",
    retries: int = 5,
    retry_delay_s: float = 0.15,
) -> None:
    """Write multiple (path, text) pairs with best-effort group atomicity.

    HONEST SEMANTICS, not overclaimed: this is NOT a single multi-file
    transaction — os.replace has no multi-path form. The prior bytes of
    every existing destination are read and retained in memory first. All
    temp files are then staged and fsynced. Only after every temp file is
    safely on disk does the function start calling os.replace, in order.

    If a replace fails partway through, every destination this call already
    swapped in is restored from the retained prior bytes (via a bounded
    atomic replace of its own), any not-yet-attempted temp files are
    unlinked, and AtomicWriteError is raised.

    The window this does NOT cover: a process crash between two os.replace
    calls. If that happens, the destinations already swapped stay swapped
    and the rest stay at their original content — there is no way to make N
    independent os.replace calls into one atomic unit on Windows, and this
    function does not pretend otherwise.
    """
    items = [(pathlib.Path(p), text) for p, text in items]

    prior_bytes = {}
    for path, _ in items:
        prior_bytes[path] = path.read_bytes() if path.exists() else None

    staged = []
    tmp_created = []
    try:
        for path, text in items:
            tmp = _tmp_name(path)
            tmp_created.append(tmp)
            _stage_text(tmp, text, encoding, newline)
            staged.append((path, tmp))
    except Exception:
        for tmp in tmp_created:
            _unlink_quiet(tmp)
        raise

    replaced = []
    try:
        for path, tmp in staged:
            _replace_with_retry(tmp, path, retries, retry_delay_s)
            replaced.append(path)
    except Exception as exc:
        for path, tmp in staged[len(replaced) + 1 :]:
            _unlink_quiet(tmp)
        for path in replaced:
            prior = prior_bytes.get(path)
            # A journal entry is dropped only once the rollback has removed the file or put the prior
            # bytes back. When the rollback fails, the entry stays, so a restore can still prove the
            # file is this run's and remove it while it matches.
            if prior is None:
                try:
                    path.unlink()
                except OSError:
                    continue
                _forget(path)
                continue
            try:
                restore_tmp = _tmp_name(path)
                _stage_bytes(restore_tmp, prior)
                _replace_with_retry(restore_tmp, path, retries, retry_delay_s)
            except Exception:
                continue
            _forget(path)
        raise AtomicWriteError(str(exc)) from exc
