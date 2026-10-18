"""Release archives have explicit boundaries and work without the private project."""

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).absolute().parents[1]
SKILL = (
    ROOT if (ROOT / "SKILL.md").is_file() else ROOT / "skills/telegram-session-bridge"
)
PREFIX = "telegram-session-bridge/"
PORTABLE_FILES = {
    "SKILL.md",
    "README.md",
    "LICENSE",
    "requirements.txt",
    "references/setup.md",
    "references/operations.md",
    "references/host-integration.md",
    "references/compatibility.md",
    "scripts/tg_bridge.py",
    *{
        "scripts/tgbridge/" + name + ".py"
        for name in (
            "__init__",
            "config",
            "messages",
            "formatting",
            "telegram",
            "store",
            "host",
            "harness",
            "service",
            "cli",
        )
    },
}
SOURCE_FILES = PORTABLE_FILES | {
    ".gitignore",
    "pyproject.toml",
    "MANIFEST.in",
    "scripts/build_skill_zip.py",
    "scripts/build_source_zip.py",
    "scripts/release_common.py",
    *{
        "tests/test_" + name + ".py"
        for name in (
            "cli",
            "config",
            "e2e",
            "final_fixes",
            "formatting",
            "harness",
            "host",
            "messages",
            "packaging",
            "service",
            "store",
            "telegram",
        )
    },
}
TOKEN_SHAPE = re.compile(rb"[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,}")


class PackagingTests(unittest.TestCase):
    def run_command(self, *args, cwd=ROOT, env=None, timeout=30):
        clean_env = {
            key: value
            for key, value in os.environ.items()
            if key
            not in {
                "PYTHONPATH",
                "TELEGRAM_BOT_TOKEN",
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
            }
        }
        clean_env.update(env or {})
        return subprocess.run(
            [sys.executable, *map(str, args)],
            cwd=cwd,
            env=clean_env,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def build(self, root, kind, output):
        return self.run_command(
            root / "scripts" / f"build_{kind}_zip.py", "--output", output, cwd=root
        )

    def unpack(self, kind, directory):
        output = directory / f"{kind}.zip"
        result = self.build(ROOT, kind, output)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(output) as archive:
            archive.extractall(directory / "extract")
        return directory / "extract/telegram-session-bridge", output

    def synthetic_checkout(self, directory):
        # Copy named publication inputs only. Never walk private state/history.
        root = directory / "source"
        skill = root / "skills/telegram-session-bridge"
        for name in PORTABLE_FILES:
            target = skill / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SKILL / name, target)
        for name in SOURCE_FILES - PORTABLE_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        # An exported layout can also supply the trusted private-layout metadata.
        for name in ("pyproject.toml", "MANIFEST.in"):
            path = root / name
            text = path.read_text()
            if ROOT == SKILL:
                if name == "pyproject.toml":
                    text = text.replace(
                        '"scripts"', '"skills/telegram-session-bridge/scripts"'
                    )
                else:
                    text = text.replace(
                        "include SKILL.md",
                        "include skills/telegram-session-bridge/SKILL.md",
                    )
            path.write_text(text)
        return root, skill

    def test_mit_license_and_spdx_metadata_match(self):
        metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
        self.assertEqual(metadata["project"].get("license"), "MIT")
        self.assertEqual(metadata["project"].get("license-files"), ["LICENSE"])
        self.assertIn("setuptools>=77", metadata["build-system"]["requires"])
        license_text = (SKILL / "LICENSE").read_text()
        self.assertIn("MIT License", license_text)
        self.assertIn("Telegram Session Bridge contributors", license_text)
        self.assertEqual((ROOT / "LICENSE").read_text(), license_text)

    def test_reproducible_allowlist_archives_and_portable_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for kind, expected in (("skill", PORTABLE_FILES), ("source", SOURCE_FILES)):
                with self.subTest(kind=kind):
                    first, second = root / f"{kind}1.zip", root / f"{kind}2.zip"
                    for output in (first, second):
                        result = self.build(ROOT, kind, output)
                        self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(first.read_bytes(), second.read_bytes())
                    with zipfile.ZipFile(first) as archive:
                        self.assertEqual(
                            set(archive.namelist()),
                            {PREFIX + name for name in expected},
                        )
                        self.assertEqual(len(archive.namelist()), len(expected))
                        for info in archive.infolist():
                            self.assertEqual(info.date_time, (2020, 1, 1, 0, 0, 0))
                            self.assertEqual(
                                (info.external_attr >> 16) & 0o777,
                                0o755
                                if info.filename
                                in {
                                    PREFIX + name
                                    for name in (
                                        "scripts/tg_bridge.py",
                                        "scripts/build_skill_zip.py",
                                        "scripts/build_source_zip.py",
                                    )
                                }
                                else 0o644,
                            )
                            self.assertIsNone(
                                TOKEN_SHAPE.search(archive.read(info)),
                                "Credential-shaped publication content",
                            )
                        archive.extractall(root / kind)
            result = self.run_command(
                root / "skill" / PREFIX / "scripts/tg_bridge.py", "--help", cwd=root
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("publish", result.stdout)

    def test_exported_layout_rebuilds_archives_without_private_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            exported, original_source = self.unpack("source", root)
            self.assertFalse((exported / "skills").exists())
            self.assertEqual(
                (exported / "README.md").read_bytes(),
                (SKILL / "README.md").read_bytes(),
            )
            metadata = tomllib.loads((exported / "pyproject.toml").read_text())
            self.assertEqual(
                metadata["tool"]["setuptools"]["package-dir"], {"": "scripts"}
            )
            self.assertEqual(
                metadata["tool"]["setuptools"]["packages"]["find"]["where"], ["scripts"]
            )
            self.assertNotIn(
                "skills/telegram-session-bridge/",
                (exported / "MANIFEST.in").read_text(),
            )
            for kind in ("skill", "source"):
                rebuilt = root / f"rebuilt-{kind}.zip"
                result = self.build(exported, kind, rebuilt)
                self.assertEqual(result.returncode, 0, result.stderr)
                if kind == "source":
                    self.assertEqual(original_source.read_bytes(), rebuilt.read_bytes())
                else:
                    reference = root / "reference.zip"
                    self.assertEqual(self.build(ROOT, kind, reference).returncode, 0)
                    self.assertEqual(reference.read_bytes(), rebuilt.read_bytes())

    def test_planted_private_files_are_excluded_without_being_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root, skill = self.synthetic_checkout(Path(directory))
            sentinel = "private-" + os.urandom(16).hex()
            for base in (root, skill):
                for name in (
                    ".git/objects/private",
                    ".bridge-state/auth.json",
                    "dist/old.zip",
                    "config.json",
                    "interview.json",
                    "PRD.md",
                    "attachments/document",
                    "__pycache__/cache.pyc",
                ):
                    path = base / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(sentinel)
            for kind, expected in (("skill", PORTABLE_FILES), ("source", SOURCE_FILES)):
                output = root / f"{kind}.zip"
                result = self.build(root, kind, output)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(output) as archive:
                    self.assertEqual(
                        set(archive.namelist()), {PREFIX + name for name in expected}
                    )
                    self.assertTrue(
                        all(
                            sentinel.encode() not in archive.read(name)
                            for name in archive.namelist()
                        )
                    )

    def test_builders_cannot_replace_sources_through_alias_symlink_or_hardlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root, skill = self.synthetic_checkout(Path(directory))
            for kind in ("skill", "source"):
                for source in (
                    skill / "SKILL.md",
                    root / "scripts/build_source_zip.py",
                    root / "pyproject.toml",
                ):
                    digest = hashlib.sha256(source.read_bytes()).digest()
                    symlink = root / "source-alias.zip"
                    symlink.symlink_to(source)
                    hardlink = root / "hardlink.zip"
                    os.link(source, hardlink)
                    for output in (
                        source.parent / "unused/../" / source.name,
                        symlink,
                        hardlink,
                    ):
                        result = self.build(root, kind, output)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(
                            hashlib.sha256(source.read_bytes()).digest(), digest
                        )
                    symlink.unlink()
                    hardlink.unlink()

    def test_symlink_sources_and_parent_directory_escape_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root, skill = self.synthetic_checkout(Path(directory))
            outside = Path(directory) / "outside.md"
            outside.write_text("outside sentinel")
            source = skill / "README.md"
            original = source.read_bytes()
            source.unlink()
            source.symlink_to(outside)
            for kind in ("skill", "source"):
                output = root / f"{kind}.zip"
                self.assertNotEqual(self.build(root, kind, output).returncode, 0)
                self.assertFalse(output.exists())
            source.unlink()
            source.write_bytes(original)
            references = skill / "references"
            references.rename(skill / "real-references")
            references.symlink_to(skill / "real-references", target_is_directory=True)
            for kind in ("skill", "source"):
                output = root / f"{kind}.zip"
                self.assertNotEqual(self.build(root, kind, output).returncode, 0)
                self.assertFalse(output.exists())

    def test_token_contamination_is_rejected_without_disclosure_or_output_damage(self):
        with tempfile.TemporaryDirectory() as directory:
            root, skill = self.synthetic_checkout(Path(directory))
            tokens = (
                "1:" + "Q" * 20,
                "234567890:" + "Q" * 35,
                "12345678901234567890:" + "Q" * 100,
            )
            for kind, path in (
                ("skill", skill / "README.md"),
                ("source", root / "tests/test_config.py"),
            ):
                original = path.read_text()
                for token in tokens:
                    for contamination in (token, "https://example.invalid/bot" + token):
                        path.write_text(original + "\n" + contamination)
                        output = root / f"{kind}.zip"
                        output.write_bytes(b"previous artifact")
                        result = self.build(root, kind, output)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertNotIn(token, result.stdout + result.stderr)
                        self.assertEqual(output.read_bytes(), b"previous artifact")
                path.write_text(original)

    def test_mismatched_root_license_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.synthetic_checkout(Path(directory))
            (root / "LICENSE").write_text("different license")
            for kind in ("skill", "source"):
                output = root / f"{kind}.zip"
                self.assertNotEqual(self.build(root, kind, output).returncode, 0)
                self.assertFalse(output.exists())

    def test_relative_document_links_resolve_in_each_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            for kind in ("skill", "source"):
                exported, _ = self.unpack(kind, Path(directory) / kind)
                for path in exported.rglob("*.md"):
                    for link in re.findall(r"\[[^\]]*\]\(([^)]+)\)", path.read_text()):
                        if "://" in link or link.startswith("#"):
                            continue
                        target = (path.parent / link.split("#")[0]).resolve()
                        self.assertTrue(
                            target.is_relative_to(exported),
                            f"Link escapes archive: {path.name}",
                        )
                        self.assertTrue(
                            target.exists(), f"Missing link in {path.name}: {link}"
                        )

    @unittest.skipIf(
        os.environ.get("TGBRIDGE_EXPORT_TEST_CHILD") == "1",
        "outer suite verifies clean source installation",
    )
    def test_clean_export_full_suite_source_and_wheel_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            exported, _ = self.unpack("source", root)
            result = self.run_command(
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-v",
                cwd=exported,
                env={
                    "PYTHONPATH": str(exported / "scripts"),
                    "TGBRIDGE_EXPORT_TEST_CHILD": "1",
                },
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_command(
                "-m", "build", "--no-isolation", cwd=exported, timeout=60
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for artifact in (
                exported,
                *sorted((exported / "dist").glob("*.whl")),
                *sorted((exported / "dist").glob("*.tar.gz")),
            ):
                destination = root / ("installed-" + artifact.name)
                result = self.run_command(
                    "-m",
                    "pip",
                    "install",
                    "--no-index",
                    "--disable-pip-version-check",
                    "--no-deps",
                    "--no-build-isolation",
                    "--target",
                    destination,
                    artifact,
                    cwd=root,
                    timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                result = self.run_command(
                    destination / "bin/tg-bridge",
                    "--help",
                    cwd=root,
                    env={"PYTHONPATH": str(destination)},
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("publish", result.stdout)
                metadata = next(destination.glob("*.dist-info/METADATA")).read_text()
                self.assertIn("License-Expression: MIT", metadata)
                self.assertIn("License-File: LICENSE", metadata)
                self.assertTrue(
                    next(destination.glob("*.dist-info/licenses/LICENSE")).is_file()
                )
