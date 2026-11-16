# Host integration contract

This is a generic protocol and cooperative consumer, not a prebuilt native adapter for Codex, Claude Code, ChatGPT Work, Claude Cowork, or Antigravity. No extra model key or second agent conversation is used. Host support must be verified against the actual installed platform/version. [Compatibility](compatibility.md) lists gates.

## Read-only diagnostics and explicit startup modes

```sh
tg-bridge --config CONFIG harness
tg-bridge --config CONFIG run --session-owned --mode cooperative
tg-bridge --config CONFIG run --session-owned --mode task-completion
tg-bridge --config CONFIG run --session-owned --mode collector-only
```

The run commands are alternatives. Omitting --mode refuses startup before credential resolution or network activity. `cooperative` asserts an open existing-agent blocking-tool loop. `task-completion` asserts verified host task-completion notifications into the same conversation and suppresses generic host hooks; it does not implement those notifications. `collector-only` suppresses host hooks for that process and queues work without agent execution. `native` is permitted only with a separately configured trusted host_command; no native adapter is bundled or verified here. Mode and --session-owned are operator assertions; the CLI cannot detect host notification support, an open loop, a correct native adapter, or authoritative session lifetime.

`harness` reads only validated config and conventional socket metadata; it does not open the durable queue, resolve credentials, connect to sockets, launch servers, or invoke a model. `doctor` and `status` include the same redacted report and preserve the existing verification keys. `automatic_continuation` diagnoses the generic native host-command path: blocked without a host command or with a known identity mismatch; a configured command remains live-unverified. It does not test or rule out a supported open-turn wait or host task-completion notification. Canonical output capture and session lifecycle remain live-unverified independently.

Codex current identity uses CODEX_THREAD_ID and CODEX_SESSION_ID; conflicting values or a mismatch with the bound session reject every startup mode. Neither value available means identity unavailable, not an invented identity or rejection of other hosts. With Codex identity and CODEX_HOME available, only app-server-control/app-server-control.sock metadata is inspected with no symlink traversal. A socket is present-unverified, never ownership proof. A missing conventional socket diagnoses that Codex CLI path and does not invalidate a separately configured host hook. Reports contain constant status/reason strings, never identifiers, environment values, argv, or filesystem error text.

## Cooperative blocking-tool mode

The collector runs as a session-supervised foreground job independently of agent work. The existing agent keeps one listening turn open and uses a supported blocking/yielding tool to run wait. The command blocks in Python/SQLite, returns only when it claims work or times out, and does not invoke a model while waiting. Attachment downloads happen in this consumer, so a slow download does not block the collector. A separate sender connection/worker permits receiving during uploads. Host hook processes are bounded to five seconds; tasks must not execute inline in them.

When the tool actually completes back into that same turn, the agent can act on its durable claim using current context. The host must allow concurrent collector/consumer jobs and preserve that turn across tool yields. A timeout may require a model turn to renew the blocking wait. The 1800-second CLI example is an application wait duration, not proof any host permits a 30-minute tool call. Measure host timeout/renewal costs and report them. Repeated idle model polling does not meet the required idle behavior. Ending the agent turn and hoping for an undocumented notification is unsupported.

Canonical final capture is a separate gate: some hosts apply final hooks only when the turn is finalized, which may conflict with keeping the cooperative listening turn alive. Unless the host exposes a verified capture/resume facility, final fidelity and continuous operation remain unverified. Do not solve this by fabricating a second answer or forwarding pre-hook drafts. Progress/final artifacts must be the actual selected visible output after styles/hooks, in original order, with files selected by the session. No private reasoning is forwarded.

## Claude Code task-completion mode

An operator-reported Claude Code Cloud 2.1.302 run observed a tracked background `wait` finishing after the agent's turn had ended, a host completion notification resuming the same conversation, and a delivered Telegram reply. The browser tab was open. This establishes a usable host-specific integration candidate without a mod or generic native `host_command`; it does not establish closed-tab delivery, VM-pause survival, empty-timeout renewal, canonical output capture or active cancellation. Verify the behavior on the actual deployed host/version before relying on it. Other hosts do not inherit this capability.

1. Establish the actual conversation identity, private owner pairing and supported host job start/stop handles. Start one collector as a main-conversation host-managed background job with `--mode task-completion`, a finite deadline and an explicit cleanup/renewal policy. Do not launch another Claude CLI or model. A shell PID or `--session-owned` alone is not supervision proof.
2. Start exactly one `wait --timeout 1800` as a tracked host background Bash job. Record its task handle, output location and deadline. Give the host job time beyond the application wait for attachment preparation; respect the host's actual limits. Current Claude Cloud docs describe a 30-minute default background limit and an explicit maximum of two hours, so do not rely on the default to cover a full 1800-second wait plus download time.
3. Only after confirming the host owns the wait and delivers its completion to this same conversation may the agent end its listening turn. The collector continues receiving without invoking a model. Do not repeatedly read the output file or ask the model whether a message has arrived.
4. On that specific host completion notification, inspect the task's complete output and exit code. Exit 0 must contain a valid durable claim for this source/session/binding/current generation before execution. Exit 3 means no request; renew only while the binding and owner lifetime remain valid. Other exits, lost output or duplicate notifications require reconciliation, not blind execution or a second outstanding wait.
5. Execute through this same conversation's tools and approvals. Publish the selected progress/final artifacts, verify outbox delivery, and complete the request. Then start the next single tracked wait. A notification alone never owns a request or authorizes broader tools.
6. Track collector and consumer deadlines separately. Stop/unbind through the coding session and stop the exact owned jobs when done. Do not report cleanup from a timeout setting alone. A forced engine/VM end can prevent cleanup; reconcile retained running claims and ambiguous outputs before recovery.

No model runs while Python waits. Handling a request uses the existing model normally. An empty wait's completion may also start a model turn to renew it: an 1800-second wait can mean roughly two renewals per idle hour, not measured zero-cost service. The cited run had no empty timeout, so its renewal cost is unmeasured. Host task completion is a different path from Python's generic native hook diagnostics; `automatic_continuation: blocked` must not be treated as disproving an observed host notification.

### Claude permissions and Cloud settings

Keep the session's normal approval policy. Auto review can reject running external code, publishing content or unattended remote control. The skill does not select a permission mode, require broad allow rules or guarantee that preapproved commands pass every review. If an action is refused, stop and report the stated reason; do not reword it, route it through a wrapper or change permissions to evade the rejection.

For commands the owner has reviewed and chooses to preapprove through normal host configuration, prefer the exact bridge executable/config prefix. In a single-repository Cloud session, committed `.claude/settings.json` is a documented project-settings route. Review the resulting permission change as repository-wide configuration, separate from private bridge state. Never commit a bot token or private configuration. A narrow example, with placeholders to replace locally, is:

```json
{
  "permissions": {
    "allow": [
      "Bash(/ABS/VENV/bin/python /ABS/SKILL/scripts/tg_bridge.py --config /ABS/PRIVATE/config.json:*)"
    ]
  }
}
```

Run the reviewed command as a plain command, without compound shell setup, substitutions or a different wrapper. This rule covers only matching bridge CLI invocations, not arbitrary work requested through Telegram, and is not a guarantee that another host review accepts the action. Setup may need separate interactive approval. Broad `Bash`, file-editing or agent-tool allows are an optional owner policy with much wider effect on everyone using that repository; the skill neither installs them nor recommends them as necessary. Telegram authentication does not expand the owner's coding permissions.

Check the deployed Cloud settings documentation rather than assuming local/user settings were imported. Cloud does not automatically install repo-enabled plugins. Ordinary environment variables are read on engine startup, including restore/rebuild of an existing conversation; updates do not immediately change the current engine. Do not require a fresh conversation or describe proxy network secrets as a proven way to supply a Telegram URL-path token. See [setup](setup.md) for private token input and pairing when tool output is buffered.

Official references: [background commands](https://code.claude.com/docs/en/tools-reference#background-commands), [Cloud environments](https://code.claude.com/docs/en/cloud-environments), [settings](https://code.claude.com/docs/en/settings), and [permission rules](https://code.claude.com/docs/en/permissions). Host versions and organization policy can change the available behavior.

## Generic native hook

The optional static host_command is a trusted JSON argv array configured during init/pair, for example the argument structure below with a real existing adapter path. That example path is not shipped:

```sh
tg-bridge --config /absolute/private/bot-one/config.json init --session-id ACTUAL_HOST_SESSION_ID --host-command '["/absolute/trusted/adapter", "telegram-event"]'
```

Telegram content never becomes shell code or argv interpolation. The executable receives one JSON object on stdin:

```json
{
  "event": "stop",
  "binding_id": "actual-binding",
  "session_id": "actual-session",
  "request_id": 42,
  "generation": 3,
  "text": "",
  "canceled_request_ids": [40],
  "scope": "binding_session_tasks",
  "ownership": "claim_required"
}
```

Events are notify, interrupt, and stop. The adapter must verify the binding/session identity and generation at action time against authoritative current state. Stale events cannot cancel unrelated or newer work. For interrupt, revalidate that the referenced request remains eligible before steering; do not steer again after another consumer completed it. Execute no event text as a task without a successful queue claim:

- notify is a wake-up with no task payload. Use wait to claim exactly one item.
- interrupt requests the host's supported native steering/control. "Accepted" means that native control was performed, not task ownership. Its priority request still needs one successful durable claim and eventual completion. A repeated event after restart must not duplicate side effects.
- stop cancels only this binding/session's task work with generation strictly earlier than the event generation. Treat canceled_request_ids as optional hints. On recovered controls the list can be empty. Recheck scope/generation at action time; current/newer-generation work, other sessions, unrelated processes, and the relay must survive. Do not implement a global process kill. If scope cannot be proven, report unsupported.

Failed notify acknowledgments are retried by Python while current-generation pending work remains, including priority fallback requests. Retry delays start after hook completion and grow from one second to a 60-second cap. Empty Telegram batches and read-backoff waits still reconcile notifications; startup also reconciles pending work. Accepted notifications are not periodically repeated for unchanged busy work; new pending arrivals can cause another wake-up. An unconfigured hook is not retried until new eligible work or collector restart. Idle queues generate no hook/model activity. Stop/unbind invalidates old-generation wake-ups. Notification recovery never replays interrupt or stop controls and never transfers ownership: the adapter must atomically claim work and drain eligible work when its session becomes available.

A successful exit code alone does not acknowledge native action. Print exactly one supported JSON object, such as {"status":"accepted"}, only after supported action is performed. Otherwise return {"status":"unsupported"}; malformed output, failure, or timeout becomes a safe constant reason. Arbitrary hook output is not forwarded. Hook timeouts kill their process group. The adapter should enqueue native control quickly rather than running an agent task inline, but must not claim completion of an action it merely guessed would happen.

## Consumer/publication boundary

Only a successful durable claim owns execution. Multiple consumers can claim distinct pending requests; the host must serialize this single session or use explicitly supported native turn handling, rather than silently execute parallel agent turns. Wait JSON includes source telegram, actual configured session_id, binding_id, request_id, and generation. Compare these with the host's actual identity and honor generation invalidation. Use attachments as data paths and inspect errors. Normal coding-host approvals still apply. User content is not authorization to expand the host's permissions or publish unrelated material.

Publish accepts existing regular UTF-8 text/files, --source telegram, --kind progress|final, and a currently running current-generation request. Files are privately snapshotted before queueing. The host owns post-hook selection/capture; the bridge neither captures the UI nor generates answers. Publish all output, then complete, then return to the supported wait. Source UI publication is rejected. An old-generation publish is rejected after /stop. Native host work may still require cancellation even after the request is invalidated in SQLite.

## Session lifetime and shutdown

The actual host supervisor owns collector, sender, and consumer lifetime. --session-owned is an explicit contract assertion, not a lifecycle detector. A foreground CLI command by itself does not prove session ownership. Do not use a detached shell/nohup as a substitute. Closing the browser does not end a live cloud runtime; browser visibility is not a session signal.

Optional --owner-pid during init/fresh bind checks Linux /proc or Windows process creation-time identity and stops if the process dies or its PID is reused. It requires a genuine session-owning process, not an arbitrary parent shell. Missing identity is an error. Fresh binding resets an old owner PID unless explicitly supplied. Retryable startup and polling reads keep recovering automatically with exponential backoff capped at 60 seconds; full server retry_after delays may be longer. These waits use 0.25-second slices, checking unbind, signals, and owner PID identity between slices and bounded hook calls. A notification hook may take up to five seconds; network operations retain their own timeout/shutdown limits. It does not need a model-driven restart after a transient outage. Unbind ends polling on the next short cycle. On POSIX, SIGINT/SIGTERM request graceful shutdown and retain the collector lock until the sender exits. On Windows, console SIGINT can request graceful shutdown; terminating the process may be abrupt, so restart recovery treats an interrupted send as ambiguous. A progressing network operation can outlive a socket-operation timeout; the supervisor must enforce a shutdown grace and terminate the whole job if necessary. An abruptly interrupted send becomes ambiguous on restart.

Local locks cover one UID/VM only. Cross-VM ownership and host cancellation/resumption are host-integration responsibilities. Verify no response occurs after real session termination, without mistaking browser closure for termination. Never claim a generic VM can infer the end of a browser conversation.

## Low-level library callers

Use Service.run for the production collector: it owns the bot lock, validates configured/durable identity and getMe before starting the sender, and manages lifecycle and read retries. Service.step and Service.drain_one are low-level primitives; their caller must already own the bot lock and have validated the exact transport with validate_identity(config, store, api). Replacing that transport requires revalidation. validate_binding(config, store) is the offline identity check used by wait before claiming; prepare_request repeats that local check and authenticates attachment clients itself. No Store claim/transaction or Host payload interface changed.
