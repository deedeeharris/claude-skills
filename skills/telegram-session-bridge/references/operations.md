# Operations and recovery

These examples assume package-installed tg-bridge. For a copied skill, use the explicit venv Python plus absolute scripts/tg_bridge.py path described in [setup](setup.md). Replace paths, session identifiers, request IDs, and output IDs with actual values from this binding. Never insert a token into argv.

## Request and output loop

First use `tg-bridge --config CONFIG harness` and choose an explicit startup mode as described in [setup](setup.md). Cooperative mode requires keeping this original turn open; it does not resume a finalized session. Task-completion mode instead requires verified host notification into this same conversation when its tracked background wait finishes; it suppresses generic host hooks. Collector-only suppresses hooks and queues work without agent execution. It is storage/test operation, not a connection solution. Never launch a second collector or outstanding wait to diagnose an existing bot.

```sh
tg-bridge --config /absolute/private/bot-one/config.json wait --timeout 1800
tg-bridge --config /absolute/private/bot-one/config.json publish --request-id 42 --source telegram --kind progress --text-file /absolute/artifacts/progress.txt
tg-bridge --config /absolute/private/bot-one/config.json publish --request-id 42 --source telegram --kind final --text-file /absolute/artifacts/final.txt --file /absolute/artifacts/report.pdf
tg-bridge --config /absolute/private/bot-one/config.json complete --request-id 42
```

Wait claims one request and returns JSON including binding_id, session_id, source telegram, generation, request_id, text, and attachments with local path or safe error. Exit 3 is an empty timeout, not a task. Wait does not run a model. Claimed work stays running across a consumer or attachment-preparation crash; another wait does not automatically replay it. Text-only wait checks local binding/session/owner identity without resolving a token. Attachment preparation authenticates its newly resolved client with getMe before downloading. A credential validation failure reports the retained request ID; inspect status and correct the credentials before explicit recovery after verifying prior work stopped. A failed claim is never silently requeued.

In task-completion mode, a notification is a signal to inspect the exact recorded wait job, not authority to run its text. Require its real exit status and complete JSON. Handle exit 0 only after session/binding/source/generation validation; exit 3 only renews the wait. For any other status, duplicate notification or missing output, inspect running requests and outbox before recovery. Never execute the same claim twice. Wait's timeout bounds idle claiming; attachment preparation after a claim can extend the command, so leave time in the host job's deadline and preserve a retained claim if that deadline interrupts it.

Only publish the actual host-selected visible output after hooks/styles. --format markdown deterministically renders supported Markdown into Telegram text/entities; unsupported forms remain readable. Markdown syntax and paragraph boundary normalization are rendering, so rendered text need not match raw Markdown bytes. --format plain preserves decoded UTF-8 text exactly, including CR/LF. Long text is split into consecutive chunks of at most 4096 UTF-16 code units without splitting a Python character; entity offsets are UTF-16. Progress/final ordering follows durable publication order. No model rewrites are involved. Never send private reasoning.

Publish queues durable output and snapshots file bytes; success is not proof of remote delivery. All intended publishes must succeed before complete. Completion allows already queued output to drain, but blocks new output for that request. A multi-item publish can partly commit before a crash. Inspect before rerunning to avoid duplicate parts. Coding-UI requests and replies stay in that interface; concurrent UI use shares the session context, not Telegram routing. The native host must serialize or steer its turns safely.

## Commands in Telegram

- Ordinary messages queue predictably by update ID. Collecting them does not require an idle model.
- /interrupt followed by request text asks the native adapter to use supported steering/interruption. The request remains a durable priority item and must be claimed exactly once. Without confirmed native support, the user receives a truthful "queued with priority" fallback. Priority items are ordered by update ID ahead of ordinary pending work. Bare /interrupt returns usage help.
- /stop clears pending work and invalidates running requests/old-generation publication while keeping the collector/binding alive. A supported adapter additionally cancels only this binding/session's earlier-generation task work. Without that adapter, active host cancellation is unconfirmed; work may still be running in the host. /stop with arguments gives help.
- /status reports queue counts. These commands are accepted only from the paired private owner. Edits are not new tasks; commands addressed to another bot are ignored.

Unbind from the coding session to end polling and release the bot:

```sh
tg-bridge --config /absolute/private/bot-one/config.json unbind
```

This differs from /stop and from terminating the coding session. An already in-flight send cannot be recalled. A completely unbound bot cannot launch a session by receiving a Telegram command. End the host-owned job after unbind and verify it stopped before reusing the bot.

## Files and Telegram limits

The hosted Bot API limits used here are conservative decimal bytes: inbound getFile downloads 20,000,000 (20 MB), outbound documents 50,000,000 (50 MB), and outbound photos 10,000,000 (10 MB). Photo dimension/aspect rules also apply upstream. An upload Telegram accepts from a user may exceed what a bot can download. Oversized files are never split, truncated, or uploaded to an external service. Originals remain on the host; an explanatory notice is queued. Attachment download failures preserve metadata/error for the agent.

Use --file to transfer original file bytes as a document, including images when byte fidelity matters. --photo requests Telegram's photo presentation, which can transform the image; local snapshots/uploads preserve source bytes but cannot control Telegram processing. Incoming photo bytes are the variant Telegram exposes, not necessarily the user's camera original. Ask the user to send a document for original-image fidelity. Voice/audio are ordinary file attachments; automatic transcription is V2.

Current upstream references: [getFile](https://core.telegram.org/bots/api#getfile), [sendDocument](https://core.telegram.org/bots/api#senddocument), [sendPhoto](https://core.telegram.org/bots/api#sendphoto), [sendMessage](https://core.telegram.org/bots/api#sendmessage). Recheck upstream limits on upgrades.

## Restart and binding boundaries

While the session and binding remain live, the collector automatically retries transient getMe, webhook-check, and polling failures, including outages longer than five attempts. Exponential backoff grows from one second to a 60-second cap; a Telegram 429 retry_after is honored in full. Backoff waits use 0.25-second slices and check shutdown, unbind, and the optional owner process between slices and bounded hook calls. A hook can take up to five seconds; in-flight network operations have their own timeout/shutdown limits. These are script waits with no model calls. Fatal authentication, conflict, or other definite nonretryable read errors still stop the collector.

After a process exit, restart the collector with the same config to preserve this session's durable queue and offset. If explicitly rebinding the same session, use its same authoritative ID and --resume; this is offline and does not re-pair:

```sh
tg-bridge --config /absolute/private/bot-one/config.json bind --session-id ACTUAL_HOST_SESSION_ID --resume
```

A fresh session requires stopping/unbinding the previous collector and deliberately pairing again. No old binding's requests, outbox, or context transfer:

```sh
tg-bridge --config /absolute/private/bot-one/config.json bind --session-id NEW_ACTUAL_HOST_SESSION_ID
```

Telegram retains unconsumed updates for [no longer than 24 hours](https://core.telegram.org/bots/api#getting-updates). That is separate from the local durable SQLite inbox/outbox and attachment snapshots, which have no automatic expiry. Telegram retention cannot restore data after local storage or the host VM is destroyed. Fresh pairing deliberately starts at its pairing update boundary, excluding old history; it is not same-session recovery.

## Inspect before recovery

These observational commands need no resolved token, network call, or host hook:

```sh
tg-bridge --config /absolute/private/bot-one/config.json status
tg-bridge --config /absolute/private/bot-one/config.json doctor
tg-bridge --config /absolute/private/bot-one/config.json outbox inspect
```

They redact credentials and outbox payload text/artifact paths, but expose operational identifiers. Do not publish the whole state directory. An interrupted sending row becomes ambiguous on the next lock-owning collector startup. A timeout/lost send response can mean Telegram accepted the message. Ambiguous or failed output blocks later output in that generation to preserve order. Never automatically retry it or promise exactly-once transport or arbitrary agent side effects.

Inspect Telegram and local work first. If delivery is confirmed and its actual Telegram message ID is known, mark it sent. Otherwise explicitly choose cancellation or accept duplicate risk:

```sh
tg-bridge --config /absolute/private/bot-one/config.json outbox mark-sent --id 8 --message-id 123
tg-bridge --config /absolute/private/bot-one/config.json outbox cancel --id 8
tg-bridge --config /absolute/private/bot-one/config.json outbox retry --id 8 --ack-duplicate-risk
```

These are alternatives, not a sequence to run blindly. Retry of failed/queued output does not require the ambiguity flag, but does require reviewing the definite failure. Only definite Telegram 429 rejection schedules automatic resend; retryable reads continue with capped exponential backoff while the session remains live (server retry_after may be longer). Do not replay publication simply because the client lost its result.

For running requests/controls, verify prior work and any native action cannot still execute and inspect partial side effects before explicit recovery. Recovery requeues; it does not undo side effects:

```sh
tg-bridge --config /absolute/private/bot-one/config.json recover --request-id 42 --previous-work-stopped
tg-bridge --config /absolute/private/bot-one/config.json recover --control-id 5 --previous-work-stopped
```

A crash between database binding and config replacement can leave a private .pending-pairing.json or .pending-binding.json. It may contain a token. Do not delete or publish it. After verifying old work stopped, rerun the original init/pair or fresh bind with --recover-setup. This retires only the validated incomplete binding and performs a new deliberate pairing, not orphan execution. If final config already exists, inspect status and consider same-session resume. Unmatched active bindings are not silently displaced.

## Conflicts, secrets, and retention

Collector startup verifies getMe against the configured and durable bot/session/owner identity before polling or starting its sender. Each attachment client is verified before download. Rotating a token for the same bot is supported; changing an environment reference to another bot fails closed and never creates a new binding. Use the correct bot credential, even when two bots share the same owner. 401 means credentials are invalid; correct/rotate the configured secret. 409 means competing long polling or conflict; stop and identify the other consumer. The collector's per-user bot lock does not exclude another machine or OS user. Existing webhooks are refused; identify their owner before any separately authorized change. The bridge never automatically deletes a webhook.

On POSIX, private config/state directories use 0700, config/SQLite use 0600, and outbox snapshots use 0400. On Windows, protected ACLs restrict private storage to the owner and privileged system accounts, and snapshots deny ordinary writes. Avoid symlinks, shared parents, or multiple configs in one state directory. Software running as the same owner can still access these secrets; file permissions and ACLs are not a sandbox against that owner. Never commit config, SQLite journals, attachments, staged records, token material, or snapshots. Local state has no automatic retention purge. After unbinding, stopping the supervisor/consumer, resolving needed recovery, and choosing an authorized retention policy, remove or archive the private directory manually using protected storage. Backups can contain credentials and user content. Revoke the bot token through BotFather when no longer needed.

Exit codes: 0 success; 1 safe operational error; 2 invalid arguments; 3 wait timeout; 130 interrupted interactive command. Errors deliberately omit token-bearing upstream URLs/descriptions.
