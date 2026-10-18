# Setup

## 1. Check the coding host

Keep this in the existing coding session, with its real session ID. Read [host integration](host-integration.md) and [compatibility](compatibility.md). You need a host-owned session job and supported same-turn blocking tool completion, verified same-session task-completion notifications, or a verified native adapter. A generic VM does not know when a browser conversation ends. A lost browser tab does not mean the cloud session ended.

Use one distinct bot and one private config directory per simultaneous session. There is no bridge-imposed bot count. Do not reuse a bot while another VM, user, webhook, or collector still consumes it. The local lock protects only this OS user on this VM.

## 2. Install Python dependencies

Use Python 3.11+ on POSIX. Linux is required for optional owner-PID checks. Windows is not supported. In the extracted telegram-session-bridge directory:

```sh
python3 -m venv /absolute/private/tgbridge-venv
/absolute/private/tgbridge-venv/bin/python -m pip install -r requirements.txt
/absolute/private/tgbridge-venv/bin/python scripts/tg_bridge.py --help
```

Choose your own writable private paths; the absolute paths here are placeholders. No root repository venv is included. Commands in these guides starting with tg-bridge use a source/wheel installation, as described in the skill's [README](../README.md). In a copied skill, replace that executable with the absolute venv interpreter followed by the absolute path to scripts/tg_bridge.py. Always invoke Python explicitly for direct launch.

## 3. Create your bot

1. In Telegram, find the verified official [BotFather](https://t.me/BotFather), then send /newbot.
2. Choose the displayed bot name and a unique username ending in bot. BotFather returns a bot token. This is a secret that controls the bot. Do not send it to the bot chat or share it with others.
3. Open the bot's private chat and press Start or send /start. This opens the conversation; pairing still requires the one-time code below. You do not need to look up a chat ID.
4. Optionally enable Telegram account two-step verification under Settings, Privacy and Security. It helps protect your Telegram account, but does not protect a leaked bot token. Rotate a leaked token through BotFather and update the configured secret.

No API ID, API hash, MTProto, GitHub mailbox, separate model key, or external bridge server is needed.

## 4. Provide the token privately

Prefer setting TELEGRAM_BOT_TOKEN in the actual coding runtime using the host's secret manager. Keep it available to pairing, the collector, fresh binding, and attachment downloads. Only the variable name is saved in config, not its value. The environment of another terminal or your laptop is not automatically the VM's environment. Claude Cloud reads environment variables when the engine starts, including after VM restore or rebuild; changing them does not update an already running engine immediately. An existing conversation can use the approved private stdin flow below rather than requiring a new conversation. Proxy-injected network secrets are a different facility and are not a demonstrated replacement for Telegram's URL-path token.

```sh
/absolute/private/tgbridge-venv/bin/python /absolute/skill/scripts/tg_bridge.py --config /absolute/private/bot-one/config.json init --session-id ACTUAL_HOST_SESSION_ID
```

Replace ACTUAL_HOST_SESSION_ID with the current host's authoritative identifier. Use an initially absent or already private config parent; configuration requires private directories (0700) and files (0600), rejects unsafe symlinks, and keeps state beneath that parent. Do not use a shared download folder. On a shell with a usable controlling terminal, --token-hidden prompts without terminal echo:

```sh
/absolute/private/tgbridge-venv/bin/python /absolute/skill/scripts/tg_bridge.py --config /absolute/private/bot-one/config.json init --session-id ACTUAL_HOST_SESSION_ID --token-hidden
```

If a token was supplied in the coding conversation for the authorized setup/test, the agent may pass it privately through --token-stdin. A trusted interactive PTY with echo disabled and token entry through stdin or the hidden prompt is acceptable when environment injection is unavailable. A separate secret manager is not a mandatory gate, and no repeated permission question is needed for that already-authorized action. There is no token-valued argv option. Never put the token in an echoed shell command, a here-document, stdout, logs, tracked file, or repeated assistant prose. Conversational input and private tool input may remain in the coding platform's history; hidden terminal input cannot remove that history. Inline stdin/hidden tokens are saved in the private config instead of an environment reference.

## 5. Pair the intended owner

The command checks getMe, refuses an existing webhook, then prints a safe JSON instruction to stderr containing bot username, pairing_text, and expiry. Send the exact displayed "/start pair_..." text privately to that bot before the default 180-second expiry. The code is one-time, random, and valid for at most 300 seconds if --pair-timeout is supplied. Failed or expired pairing does not bind the latest sender. The private chat ID and sender user ID are discovered from the matching update and saved automatically.

Some hosts buffer foreground tool output until the command exits. There, start this one `init` as a tracked, temporary host background job and read its private stderr/output file while it is still waiting. Show only the bot username, pairing text and expiry to the owner immediately. Use the host's completion notification to obtain the final setup result, then verify successful pairing before starting the collector. Do not start another init or wait for the pairing window to expire before showing the code. Keep output files private; final setup output can contain operational identifiers. No new asynchronous-pairing CLI flag is required.

The bridge registers /interrupt and /stop in the paired chat's slash menu. Menus are convenience only; code still checks both owner IDs and private-chat type on every update. No real messages should be sent during credential-free local verification.

## 6. Start the session-owned listener and consumer

After package installation, first inspect the offline report using the installed entry point:

```sh
tg-bridge --config CONFIG harness
tg-bridge --config CONFIG doctor
```

CONFIG is your absolute private config path. The report never resolves the token or connects to a socket/server. A configured executable or present conventional Codex socket remains live-unverified, and matching IDs do not establish owning-host control. Codex identity conflicts reject startup; no Codex identity means unavailable, allowing other hosts. Missing conventional Codex socket metadata describes that path only; it does not disprove an independently configured hook.

Run requires --mode. Choose cooperative only when the existing agent keeps its original turn open with a supported blocking tool and the host supervises both jobs:

Cooperative operation needs no app-server connection or host_command. A native automatic_continuation result of blocked does not prevent this open-turn path. The agent must actually enter and repeat wait; merely starting the collector or ending its turn leaves messages queued. Renew a normal tool timeout while the original turn remains live; do not equate renewal with reopening a forcibly ended session. Model-driven renewal can use tokens. Script polling makes no model calls; provider runtime charges are separate and depend on the host plan.

```sh
tg-bridge --config CONFIG run --session-owned --mode cooperative
```

For a host whose own tracked background-wait completion has been verified to resume this same conversation after final, use the separate mode:

```sh
tg-bridge --config CONFIG run --session-owned --mode task-completion
```

This suppresses generic native hooks and relies on the host's actual job notification, not a wake-up implemented by Python. Follow the [Claude task-completion recipe](host-integration.md#claude-code-task-completion-mode). Keep one collector and one consumer, record both host task handles, and honor their deadlines. An ordinary detached process is insufficient.

For explicitly requested collection/storage testing without agent execution, the alternative is:

```sh
tg-bridge --config CONFIG run --session-owned --mode collector-only
```

Collector-only suppresses host hooks for this run, saves work, and does not connect the agent. It is not the default solution to a bridge request. Never run these alternatives concurrently for one bot. Native mode requires a real separately configured trusted adapter; none is bundled or verified here. Selecting a mode is an operator assertion, not a capability detector. Startup emits a JSON observation with the mode and automatic-continuation status; it does not establish continuation or capture. `automatic_continuation` refers to the generic native host-command path, so `blocked` does not rule out an already-open cooperative wait or separately verified host task notifications.

The run command itself stays in the foreground of its host-managed job. Start it only with the host's real session job/supervisor. In cooperative mode, independently keep the current bound turn alive with a supported blocking tool running:

```sh
tg-bridge --config /absolute/private/bot-one/config.json wait --timeout 1800
```

An unsupported host must be reported as such, not replaced by repeated idle model calls or an undocumented wake-up after ending the turn. Cooperative mode is not background wake-up after final. Host timeout renewals can incur model overhead; disclose measured behavior, and distinguish user-approved occasional renewal from polling an empty queue with model calls. Configuration, SQLite, staged setup records, and snapshots are private local data; see [operations](operations.md) for safe retention and crash recovery.
