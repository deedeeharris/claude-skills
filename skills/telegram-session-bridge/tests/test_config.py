import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from tgbridge.config import Config, ConfigError
except ImportError:
    Config = None
    ConfigError = ValueError

TOKEN = "123456789:" + "abcdefghijklmnopqrstuvwxyzABCDE123456"


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Config, "Config implementation is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "private" / "config.json"

    def config(self, **kwargs):
        values = {
            "version": 1,
            "binding_id": "binding-123",
            "session_id": "session-123",
            "bot_id": 123456789,
            "bot_username": "example_bot",
            "owner_chat_id": 456,
            "owner_user_id": 456,
            "token": TOKEN,
            "host_command": ["/usr/bin/true"],
            "owner_pid": None,
        }
        values.update(kwargs)
        return Config(**values)

    def test_roundtrip_atomic_private_config(self):
        cfg = self.config()
        cfg.save(self.path)
        self.assertEqual(Config.load(self.path).resolve_token(), TOKEN)
        self.assertEqual(cfg.private_state_dir, self.path.parent)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])
        cfg.save(self.path)
        self.assertEqual(Config.load(self.path).host_command, ["/usr/bin/true"])

    def test_load_refuses_duplicate_json_keys(self):
        self.config().save(self.path)
        text = self.path.read_text().replace(
            '"owner_user_id": 456', '"owner_user_id": 9, "owner_user_id": 456'
        )
        self.path.write_text(text)
        with self.assertRaises(ConfigError):
            Config.load(self.path)

    def test_repr_never_exposes_token(self):
        cfg = self.config()
        self.assertNotIn(TOKEN, repr(cfg))
        with self.assertRaises(ConfigError) as caught:
            self.config(token="bad secret")
        self.assertNotIn("bad secret", str(caught.exception))

    def test_environment_source_and_precedence_over_default(self):
        cfg = self.config(token=None, token_env="CUSTOM_TG_TOKEN")
        with patch.dict(
            os.environ, {"CUSTOM_TG_TOKEN": TOKEN, "TELEGRAM_BOT_TOKEN": "invalid"}
        ):
            self.assertEqual(cfg.resolve_token(), TOKEN)
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ConfigError):
            cfg.resolve_token()
        self.config().save(self.path)
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "invalid"}):
            self.assertEqual(Config.load(self.path).resolve_token(), TOKEN)

    def test_rejects_malformed_fields_and_ambiguous_sources(self):
        bad = [
            {"version": 2},
            {"bot_id": True},
            {"owner_chat_id": -1},
            {"owner_user_id": "4"},
            {"binding_id": "../bad"},
            {"session_id": ""},
            {"bot_username": "@bot"},
            {"owner_pid": 0},
            {"host_command": "echo hi"},
            {"host_command": ["x\x00"]},
            {"token_env": "SECRET", "token": TOKEN},
            {"token": None},
            {"token_env": "../SECRET", "token": None},
        ]
        for fields in bad:
            with self.subTest(fields=fields), self.assertRaises(ConfigError):
                self.config(**fields)

    def test_load_rejects_invalid_json_unknown_fields_and_unsafe_permissions(self):
        self.config().save(self.path)
        self.path.write_text('{"secret": "' + TOKEN + '"}')
        with self.assertRaises(ConfigError) as caught:
            Config.load(self.path)
        self.assertNotIn(TOKEN, str(caught.exception))
        self.path.write_text("{bad")
        with self.assertRaises(ConfigError):
            Config.load(self.path)
        self.config().save(self.path)
        self.path.chmod(0o644)
        with self.assertRaises(ConfigError):
            Config.load(self.path)

    def test_refuses_symlink_file_and_parent_and_unsafe_parent(self):
        target = Path(self.temp.name) / "target"
        target.write_text("untouched")
        self.path.parent.mkdir(mode=0o700)
        self.path.symlink_to(target)
        with self.assertRaises(ConfigError):
            self.config().save(self.path)
        with self.assertRaises(ConfigError):
            Config.load(self.path)
        self.assertEqual(target.read_text(), "untouched")
        self.path.unlink()
        self.path.parent.rmdir()
        self.path.parent.symlink_to(Path(self.temp.name))
        with self.assertRaises(ConfigError):
            self.config().save(self.path)
        self.path.parent.unlink()
        self.path.parent.mkdir(mode=0o755)
        self.path.parent.chmod(0o755)
        with self.assertRaises(ConfigError):
            self.config().save(self.path)


if __name__ == "__main__":
    unittest.main()
