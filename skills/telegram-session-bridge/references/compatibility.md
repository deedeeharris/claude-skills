# Compatibility and release gates

This package supplies a transport, cooperative claim/publication protocol and generic native-hook interface. Offline tests cover synthetic behavior; they do not establish production support for a native coding host. No native adapter is bundled. Verify each applicable capability on the actual host and version before promising it.

| Capability | Offline verification boundary | Required live gate |
| --- | --- | --- |
| Owner pairing and fixed destination | Fake Bot API, CLI/store checks and credential-to-binding validation | Deliberate private pairing and rejection of other senders |
| Text, files, images and long answers | Rendering, localhost HTTP/multipart and original-byte checks | Actual Telegram rendering and document download/upload bytes |
| Existing-session execution | Durable claims and subprocess-hook protocol | Authoritative session/context identity and actual continuation |
| Receiving while busy | Separate collector/consumer/sender protocol | Host jobs survive agent work and blocking waits |
| Progress/final fidelity | Ordered forwarding of supplied canonical files | Capture the actual visible final post-hook/style output and progress |
| Interrupt/stop | Priority/generation boundaries and unsupported notices | Native steering/cancellation scoped and revalidated at action time |
| Session end | Synthetic signals, unbind and optional Linux PID checks | Authoritative host supervisor/end signal and browser-close behavior |
| Idle waiting | Script network/SQLite loops invoke no model | Supported same-turn completion or host task notification, with measured renewal overhead |
| Recovery | Queue/outbox restart, ambiguous delivery and retry boundaries | Real outage/reconnect within Telegram and host-storage limits |

Codex, Claude Code, ChatGPT Work, Claude Cowork, Antigravity and other hosts all require their own integration checks. Canonical final capture, active cancellation and authoritative lifecycle remain unverified until those checks pass. A matching ID, configured executable, present socket, queue acknowledgment or running collector is insufficient evidence.

Observed integration cases are limited: one Codex open-turn run handled Telegram work with owner-confirmed browser-close survival and an original-document byte match. One operator-reported Claude Code Cloud 2.1.302 run handled pairing, claims and ordered publication, and a tracked background wait woke the same conversation after final with the browser tab open. That report did not test a quiet empty-timeout renewal, closed-tab delivery, document hashes, stop/interrupt, final cleanup or canonical post-hook output. These cases are not a universal production certification. The [Claude task-completion recipe](host-integration.md#claude-code-task-completion-mode) records the supported contract and its limits without including private test evidence or identifiers.

Cooperative mode requires a session-owned job and a blocking tool whose completion resumes the same existing open turn. It needs no native server connection or host_command. Keep the consumer waiting; do not finalize the turn and assume an undocumented callback. Normal wait renewal within a live turn differs from recovery after platform-forced termination. Tool timeout and renewal behavior vary by host and may incur model overhead. A command example is not proof that a host permits its full duration, unlimited waiting or zero idle charges. Final post-hook capture can require native features absent from cooperative mode. See [host integration](host-integration.md).

Task-completion mode is a separate operator assertion for a verified host notification from its own background wait into this same conversation. Generic hooks are suppressed; the host supplies wake-up. Record exact task handles and inspect real exit status/claim data, with only one wait outstanding. It does not need a mod or native host_command. Normal host approvals apply. Broad allow rules are not installed or recommended as a default; use reviewed scoped rules where the host permits them, and stop on an action's rejection.

Run tg-bridge --config CONFIG harness and inspect doctor before starting a collector. Choose an explicit --mode. Modes are operator assertions. automatic_continuation reports the generic native host-command path; blocked does not rule out an already-open cooperative wait or separately verified task notification. Collector-only saves work and suppresses hooks without agent execution; collection alone is not a session connection.

Runtime requirements: Python 3.11+, POSIX fcntl/Unix permissions, SQLite and Telegram HTTPS access. Optional owner-PID checks also require Linux /proc. Windows is unsupported. Private durable storage must persist for recovery. Local locks do not cover other machines or OS users. Telegram retains pending updates for at most 24 hours. Local retained state has no automatic expiry, and destroyed host storage cannot be recovered by this package.

## Live release checklist

Use only an explicitly authorized bot/account. Keep identifiers, credentials and evidence private. Before claiming production support, record the actual platform/version and evidence for every applicable gate:

- Complete beginner setup, deliberate pairing, unauthorized-sender rejection, fixed destination, slash menu and bot reuse after unbind.
- Prove the existing agent retains its context/tools and normal approvals. Prove UI-origin replies stay in the UI during concurrent Telegram requests.
- Receive queued text and attachments during long work/uploads; claim once; forward actual visible progress, complete actual post-hook final output and original document bytes.
- Test priority /interrupt, supported native/fallback behavior, /stop queue clearing, scoped old-generation cancellation and relay survival. An old stop must preserve newer work.
- Recover same-session work and outbound parts through disconnect/process restart. Review ambiguous sends explicitly and prevent blind replay of side effects or uncertain delivery.
- Close the browser while runtime remains live, then terminate the real session. Prove the listener survives the former and stops with the latter.
- Measure idle waiting and renewal overhead. Verify attachment limits/notices, no file splitting/external upload, and durable-storage/retention assumptions.
- Review security/reliability findings, rerun local checks/build/install/archive validation and repeat affected live checks.

Local tests cannot replace these gates. Voice transcription and full mirroring of UI activity are outside the current scope. No separate AI answer, MTProto credentials, mailbox conversation transport or arbitrary external upload is part of the bridge.
