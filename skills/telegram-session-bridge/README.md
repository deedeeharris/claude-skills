# Telegram Session Bridge

Connect a private Telegram bot to an existing coding-agent session. The bridge provides deliberate owner pairing, durable inbound and outbound queues, text and original-document transfer, source-aware publication, and a CLI with a generic host-hook protocol. It runs no separate model and opens no second agent conversation.

Start with [beginner setup](references/setup.md), then [operations](references/operations.md). Agents follow [SKILL.md](SKILL.md). Integrators should read [host integration](references/host-integration.md) and the [compatibility and release gates](references/compatibility.md).

## Install and pair

Use Python 3.11 or later on POSIX with fcntl, Unix permissions and SQLite. Linux is required for optional /proc owner-process checks. Windows is unsupported. Real operation requires Telegram HTTPS access and private durable storage. A copied skill does not need the original repository or its virtual environment.

From this skill directory, create a separate private virtual environment:

```sh
python3 -m venv /absolute/private/tgbridge-venv
/absolute/private/tgbridge-venv/bin/python -m pip install -r requirements.txt
/absolute/private/tgbridge-venv/bin/python scripts/tg_bridge.py --help
```

Replace /absolute/private with an existing writable private parent. Add this directory to the host's documented skill location or load SKILL.md through its supported mechanism. There is no universal host installation path.

Create your own bot through the verified official BotFather, open its private chat, and follow the setup guide's expiring pairing flow. Prefer a host-provided TELEGRAM_BOT_TOKEN secret. Never put tokens in command arguments, logs or source. Use a different bot and private state directory for each simultaneous session. Credentials and binding state are not included.

A source export additionally supports an installed command:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/tg-bridge --help
```

Guides use tg-bridge for that installed command. With the portable skill, substitute the absolute virtual-environment Python followed by the absolute scripts/tg_bridge.py path.

## Capabilities and limits

Cooperative operation requires a host-owned collector job and a supported blocking tool that resumes the same already-open agent turn. Task-completion mode instead uses a verified host notification from a tracked background wait into the same conversation after final; a Claude Code Cloud 2.1.302 run reported this with the browser tab open. The host supplies that notification, not the Python bridge. Both paths require durable claims, tracked jobs and actual host validation. Timeout renewal can incur model overhead. A script wait itself invokes no model. Platform-forced termination and recovery require separate host support.

Run harness and doctor before selecting an explicit startup mode. Cooperative mode asserts the open-turn contract. Task-completion asserts the host notification contract and suppresses generic native hooks. Native mode requires a separately configured trusted adapter. Collector-only stores work without executing agent requests. Mode selection and --session-owned are operator assertions, not capability or lifecycle detectors. The automatic_continuation diagnostic concerns generic native hooks; it does not test the separate host task-notification path.

No native host adapter is bundled. Capture of actual final post-hook output, scoped native cancellation, and authoritative session shutdown remain unverified until tested on the chosen host/version. The observed Claude task wake does not establish closed-tab delivery or idle-pause survival there. A running collector or passing offline suite does not establish production support. Telegram-origin replies must use the real selected output; concurrent UI-origin replies stay in the UI. Read the release gates before promising any host capability.

Claude users should read the [host-specific setup](references/host-integration.md#claude-permissions-and-cloud-settings). The skill does not require or install allow-all permissions. Owners can preapprove reviewed bridge commands through the host's normal configuration; action rejections must be respected. Pairing instructions also cover hosts that buffer tool output until completion.

The bridge preserves queues and snapshots for recovery. Ambiguous sends need explicit review because retrying can duplicate delivery. Local locks cover one OS user on one machine. Lost host storage cannot be recovered by this package, and local retained data has no automatic purge.

## Develop and release

These commands apply to the source export, which contains pyproject.toml, tests and release scripts. The smaller portable ZIP contains only runtime files, guides and the license.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests -v
.venv/bin/ruff check scripts tests
.venv/bin/ruff format --check scripts tests
.venv/bin/python -m compileall -q scripts tests
.venv/bin/python -m build
.venv/bin/python scripts/build_skill_zip.py
.venv/bin/python scripts/build_source_zip.py
```

Run the same commands on Linux with Python 3.11, 3.12, 3.13 and 3.14 in CI. Install dependencies separately for each interpreter. CI may download build/development dependencies from PyPI. The tests use synthetic fixtures and local fake HTTP servers; they must not contact Telegram or use live credentials. These commands are a CI recipe, not a claim that a particular remote workflow or native host passed.

Both ZIP builders use explicit allowlists, fixed timestamps and permissions, sorted entries, and a credential-shape check. The portable ZIP contains 19 files. The source ZIP contains 37 files directly under one telegram-session-bridge directory, ready to copy into a repository's skills directory. It includes its own tests, packaging metadata and both builders. Rebuilding from that exported directory needs no private project files.

The source exporter adapts only the trusted package/manifest prefixes for the skill-root layout. It excludes Git metadata/history, development reports, interviews, private configuration/state, attachments, caches, environments and pre-existing artifacts. Do not publish a whole working directory or Git history as a substitute. ZIP bytes are deterministic for unchanged inputs with the same Python/zlib toolchain. Build wheel and sdist releases from the clean source export, then inspect and test the resulting artifacts.

## Contribute and report security issues

Use synthetic fixtures and run the checks above before submitting a change through the hosting repository's contribution mechanism. Keep runtime changes separate from host-support claims and include the relevant regression test and verification evidence. Do not submit tokens, user identifiers, private chats, state databases, attachments or unredacted logs.

For a suspected vulnerability, use a private security-reporting mechanism if the hosting repository offers one. If none is available, ask maintainers for a private route without disclosing the sensitive details publicly. Revoke exposed bot tokens through BotFather and protect affected local state. No dedicated contact account is supplied by this package.

Licensed under the [MIT License](LICENSE). When copied into another repository, this license applies to the Telegram Session Bridge files in this skill directory; it does not grant rights to unrelated repository content.
