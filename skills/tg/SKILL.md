---
name: tg
description: Send text messages and files to a configured Telegram chat (group, channel, or DM with bot). Supports forum/topic groups. Reads bot token + chat ID from ~/.claude/.env so the skill itself contains no secrets.
---

# Telegram Send

Send text messages and files to a Telegram chat via bot API. Works for groups, channels, DMs with the bot, and forum/topic groups.

**Usage:** `/tg <message or filepath> [caption]`

**Examples:**
- `/tg Hello world` — send a text message
- `/tg Build deployed successfully to staging` — send a text message
- `/tg /path/to/screenshot.png` — send a photo
- `/tg /path/to/report.pdf Here is the report` — send a document with caption
- `/tg C:\path\to\file.txt Check this log` — Windows paths work too

---

## First-time setup

This skill ships with no credentials. Configure it once per machine, then it works forever.

### 1. Create a bot

Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts. You get a **bot token** that looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz...`.

### 2. Add the bot to the chat where you want messages

- **Group / supergroup:** add the bot as a member, then send any message in the group (use `@yourbot ping` if the group has privacy mode on).
- **Channel:** make the bot an admin.
- **DM with the bot:** send `/start` to the bot.

### 3. Find the chat ID

```bash
source ~/.claude/.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | python -m json.tool
```

Look for `"chat": { "id": ... }` in the response. Group/supergroup IDs are negative and start with `-100`. Save it.

**For forum/topic groups only:** open the topic in Telegram, copy the URL — it looks like `https://t.me/c/<chat_id_no_-100>/<topic_id>`. The second number is `TELEGRAM_TOPIC_ID`.

### 4. Save credentials to `~/.claude/.env`

Copy the template from `~/.claude/skills/tg/.env.example` and fill in the values. The skill reads from `~/.claude/.env` (a single shared env file across all your skills) — never from the skill folder itself, so the skill stays free of personal data.

```
TELEGRAM_BOT_TOKEN=<token from @BotFather>
TELEGRAM_CHAT_ID=<chat id, e.g. -1001234567890>
TELEGRAM_TOPIC_ID=<optional, only for forum topics>
```

### 5. Verify

```bash
source ~/.claude/.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"
```

If `"ok":true` and a bot info object comes back, you're set. If `"ok":false, "error_code":401`, the token is wrong or revoked — reset it with @BotFather.

---

## Skill instructions (for the agent)

### 1. Parse the arguments

- If the **first argument** (first word, or first quoted path) resolves to an existing file on disk → send as file. Everything after the file path is the **caption**.
- Otherwise → send the **entire argument string** as a text message.

### 2. Load config

```bash
source ~/.claude/.env
```

Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional: `TELEGRAM_TOPIC_ID`.

If a required var is missing, tell the user to follow the **First-time setup** section above and point them at `~/.claude/skills/tg/.env.example`.

### 3. Send a text message

```bash
source ~/.claude/.env
THREAD_FIELD=""
[ -n "$TELEGRAM_TOPIC_ID" ] && THREAD_FIELD=",\"message_thread_id\":$TELEGRAM_TOPIC_ID"
RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary "{\"chat_id\":\"$TELEGRAM_CHAT_ID\"$THREAD_FIELD,\"text\":\"$MESSAGE\",\"parse_mode\":\"Markdown\"}")
echo "$RESPONSE"
```

Notes:
- Use `--data-binary` (not `-d`) so curl preserves UTF-8 bytes verbatim. On Windows Git Bash, `-d` can mangle multi-byte characters (em-dash, Hebrew, emoji) and trigger `Bad Request: strings must be encoded in UTF-8`.
- `$MESSAGE` must already be JSON-escaped (escape `"`, `\`, newlines). For complex strings, write the JSON to a tmp file and pass `--data-binary @tmp.json`.

### 4. Send a file

Determine the API endpoint by file extension:
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`) → `sendPhoto`, field `photo=@<filepath>`
- **Everything else** → `sendDocument`, field `document=@<filepath>`

For images:
```bash
source ~/.claude/.env
TOPIC_ARG=()
[ -n "$TELEGRAM_TOPIC_ID" ] && TOPIC_ARG=(-F "message_thread_id=$TELEGRAM_TOPIC_ID")
RESPONSE=$(curl -s -F "chat_id=$TELEGRAM_CHAT_ID" \
  "${TOPIC_ARG[@]}" \
  -F "photo=@$FILEPATH" \
  -F "caption=$CAPTION" \
  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendPhoto")
echo "$RESPONSE"
```

For documents:
```bash
source ~/.claude/.env
TOPIC_ARG=()
[ -n "$TELEGRAM_TOPIC_ID" ] && TOPIC_ARG=(-F "message_thread_id=$TELEGRAM_TOPIC_ID")
RESPONSE=$(curl -s -F "chat_id=$TELEGRAM_CHAT_ID" \
  "${TOPIC_ARG[@]}" \
  -F "document=@$FILEPATH" \
  -F "caption=$CAPTION" \
  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument")
echo "$RESPONSE"
```

### 5. Check the response

- `"ok": true` → report success: "Message sent to Telegram" or "File sent to Telegram"
- `"ok": false` → show the `"description"` field from the error
- `401 Unauthorized` from any endpoint → the token is invalid or revoked. Tell the user to get a new one from @BotFather.
- `400 Bad Request: chat not found` → the bot isn't in the chat, or `TELEGRAM_CHAT_ID` is wrong. Re-run setup step 3.

### 6. Error cases to handle before calling the API

- File path provided but file doesn't exist → "File not found: `<path>`"
- No arguments provided → show usage examples
- Missing env vars → show setup instructions

---

## Limits

Telegram Bot API caps:
- Photos: 10 MB max
- Documents: 50 MB max

If a file exceeds these, inform the user before attempting the upload.

---

## Why config lives in `~/.claude/.env`, not in this skill

This skill is intended to be portable / shareable. Keeping credentials in `~/.claude/.env` (a per-user file, not part of the skill) means:
- The skill folder can be committed to git or shared publicly without leaking secrets.
- Multiple skills (Slack, ElevenLabs, etc.) can share one env file.
- A new user only needs `.env.example` as a template — the skill itself never changes per user.
