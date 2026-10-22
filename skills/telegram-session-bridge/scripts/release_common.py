"""Shared allowlists and validation for offline, skill-root release archives."""

import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).absolute().parents[1]
SKILL = (
    ROOT if (ROOT / "SKILL.md").is_file() else ROOT / "skills/telegram-session-bridge"
)
PORTABLE_FILES = (
    "SKILL.md",
    "README.md",
    "LICENSE",
    "requirements.txt",
    "references/setup.md",
    "references/operations.md",
    "references/host-integration.md",
    "references/compatibility.md",
    "scripts/tg_bridge.py",
    "scripts/tgbridge/__init__.py",
    "scripts/tgbridge/config.py",
    "scripts/tgbridge/messages.py",
    "scripts/tgbridge/formatting.py",
    "scripts/tgbridge/telegram.py",
    "scripts/tgbridge/store.py",
    "scripts/tgbridge/host.py",
    "scripts/tgbridge/harness.py",
    "scripts/tgbridge/service.py",
    "scripts/tgbridge/cli.py",
    "scripts/tgbridge/privatefs.py",
    "scripts/tgbridge/windows_security.py",
    "scripts/tgbridge/windows_host.py",
)
DEVELOPMENT_FILES = (
    ".gitignore",
    "pyproject.toml",
    "MANIFEST.in",
    "scripts/build_skill_zip.py",
    "scripts/build_source_zip.py",
    "scripts/release_common.py",
    "tests/test_cli.py",
    "tests/test_config.py",
    "tests/test_e2e.py",
    "tests/test_final_fixes.py",
    "tests/test_formatting.py",
    "tests/test_harness.py",
    "tests/test_host.py",
    "tests/test_messages.py",
    "tests/test_packaging.py",
    "tests/test_service.py",
    "tests/test_store.py",
    "tests/test_telegram.py",
    "tests/test_windows.py",
)
TOKEN_SHAPE = re.compile(rb"[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,}")


def publication_paths():
    return {
        **{name: SKILL / name for name in PORTABLE_FILES},
        **{name: ROOT / name for name in DEVELOPMENT_FILES},
    }


def read_source(path):
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Publication sources must not be symlinks")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Publication sources must be regular files")
    return path.read_bytes()


def validate_payload(data):
    if TOKEN_SHAPE.search(data):
        raise ValueError("Credential-shaped publication content rejected")


def source_payload(name, data):
    # Only these trusted packaging prefixes differ between the two layouts.
    if name == "pyproject.toml":
        data = data.replace(
            b'package-dir = {"" = "skills/telegram-session-bridge/scripts"}',
            b'package-dir = {"" = "scripts"}',
        ).replace(
            b'where = ["skills/telegram-session-bridge/scripts"]',
            b'where = ["scripts"]',
        )
    elif name == "MANIFEST.in":
        data = data.replace(b"include skills/telegram-session-bridge/", b"include ")
    return data


def validate_output(output, protected):
    resolved = output.resolve()
    if resolved in {path.resolve() for path in protected}:
        raise ValueError("Output cannot replace a publication source")
    if any(part.is_symlink() for part in (output, *output.parents)):
        raise ValueError("Output must not traverse symlinks")
    if output.exists():
        if not stat.S_ISREG(output.stat().st_mode):
            raise ValueError("Output must be a regular file")
        if any(path.exists() and output.samefile(path) for path in protected):
            raise ValueError("Output cannot replace a publication source")


def build_archive(output, *, source=False):
    paths = publication_paths()
    names = tuple(paths) if source else PORTABLE_FILES
    # Read only allowlisted files and validate every payload before creating or
    # replacing anything. Root history, state and credentials are never walked.
    sources = []
    for name in names:
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Archive paths must stay inside the skill root")
        data = read_source(paths[name])
        if source:
            data = source_payload(name, data)
        validate_payload(data)
        sources.append((name, data))
    root_license = ROOT / "LICENSE"
    if root_license.exists() and read_source(root_license) != dict(sources)["LICENSE"]:
        raise ValueError("Root and skill licenses must match")
    output = Path(output).absolute()
    protected = (*paths.values(), ROOT / "README.md", root_license)
    validate_output(output, protected)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for name, data in sorted(sources):
                info = zipfile.ZipInfo(
                    "telegram-session-bridge/" + name, (2020, 1, 1, 0, 0, 0)
                )
                info.create_system = 3
                mode = (
                    0o755
                    if name
                    in {
                        "scripts/tg_bridge.py",
                        "scripts/build_skill_zip.py",
                        "scripts/build_source_zip.py",
                    }
                    else 0o644
                )
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(
                    info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9
                )
        with zipfile.ZipFile(temporary) as archive:
            expected = {"telegram-session-bridge/" + name for name in names}
            if (
                set(archive.namelist()) != expected
                or len(archive.namelist()) != len(expected)
                or archive.testzip() is not None
            ):
                raise ValueError("Archive validation failed")
        validate_output(output, protected)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output
