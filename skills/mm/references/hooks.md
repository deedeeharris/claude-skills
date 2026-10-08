# Hooks: guard, PM status and the archaeology check

Load this when installing the mm hooks, when one does not fire, or when a tool call was refused by `mm guard` (Sections 4.4 and 4.6 of SKILL.md).

## The hooks

| Hook | Event | What it does |
|---|---|---|
| `hooks/guard.py` | PreToolUse | Blocks Edit, Write, MultiEdit, NotebookEdit and Codex `apply_patch` on a task's `ledger.json`, `HANDOFF.md` and `HANDOFF-archive.md`, and on `ROADMAP.html` in a ledger folder, inside a `.private/pm`, `.claude/pm` or `docs/pm` tree. It exits 2 with `mm guard: <file> is generated from ledger.json by mm.py and never edited by hand; use: <command>`; for a legacy folder the message names `/mm migrate`. It fails closed for write tools: when a write tool's target file cannot be determined, or the path check raises, the call is refused with `mm guard: cannot tell ...`. Other tools pass. A payload that cannot be read as a JSON object (empty, truncated, not UTF-8, or another JSON shape) is refused the same way, since the guard cannot tell whether it is a protected write, and so is a JSON object without a non-empty string `tool_name` unless its `hook_event_name` names another event; `guard.py --help` run by hand needs no payload and exits 0. For a session bound with `mm.py bind` it also enforces the PM write fence: a PM write to product code of the bound task's repository exits 2 with `mm guard: PM mode cannot directly modify product code: ...`, naming delegation or `mm.py unbind`; PM notes under the PM folder tree and files outside the repository stay writable, delegated workers (`agent_id` in the payload) and unbound sessions are not fenced, and an unreadable, pre-r26 or too-broad binding fails closed. The decision lives in `scripts/mm_fence.py`, the full table and its messages in runtime.md. |
| `hooks/pm_status.py` | UserPromptSubmit | For a session bound with `mm.py bind`, prints a `systemMessage` with the banner, task and mode, and one line of context naming the task folder and `mm.py status`. For an unbound session it prints nothing. It never runs git. When `MM_CC_RUNTIME_MOD_ACTIVE` equals the payload's session id (the optional Claude Code plugin sets it), it leaves out the `systemMessage` and keeps the context line unchanged; any other value prints the banner. |
| `hooks/check-handoff.py` | PostToolUse | After a write that touched a HANDOFF.md (an edit tool, an `apply_patch`, or a shell command naming HANDOFF or the compiler), it reports the archaeology symptoms, 0A values over 400 chars, and, in a ledger folder, a failing `mm.py check`. It never blocks and always exits 0. |
| `hooks/notify_wait.py` | PreToolUse on AskUserQuestion and Stop (Claude Code); Stop (Codex) | Sends the wait ping: one ntfy push when the mm PM waits on the operator (see "The wait ping"). It prints nothing, always exits 0 and never blocks a turn. |

`hooks/hookio.py` holds the payload parsing the hooks share: `tool_input.file_path` (or `notebook_path`) for edit tools, and the `*** Update File:`, `*** Add File:`, `*** Delete File:` and `*** Move to:` lines of an `apply_patch` patch wherever it sits in `tool_input`.

Shell writes are not parsed by the guard. They are caught afterwards: `check-handoff` runs `mm.py check`, and `check` fails on any hand edit of a generated file.

## Claude Code registration

In the user settings file (`~/.claude/settings.json`), with the overlay's interpreter and the absolute path of the installed skill folder:

```json
"hooks": {
  "PreToolUse": [
    {"matcher": "Edit|Write|MultiEdit|NotebookEdit",
     "hooks": [{"type": "command", "command": "<python> \"<mm skill dir>/hooks/guard.py\"", "timeout": 10}]},
    {"matcher": "AskUserQuestion",
     "hooks": [{"type": "command", "command": "<python> \"<mm skill dir>/hooks/notify_wait.py\" --host claude-code", "async": true, "timeout": 15}]}
  ],
  "UserPromptSubmit": [
    {"hooks": [{"type": "command", "command": "<python> \"<mm skill dir>/hooks/pm_status.py\"", "timeout": 5}]}
  ],
  "PostToolUse": [
    {"matcher": "Edit|Write|MultiEdit|Bash",
     "hooks": [{"type": "command", "command": "<python> \"<mm skill dir>/hooks/check-handoff.py\"", "timeout": 30}]}
  ],
  "Stop": [
    {"hooks": [{"type": "command", "command": "<python> \"<mm skill dir>/hooks/notify_wait.py\" --host claude-code", "async": true, "timeout": 15}]}
  ]
}
```

Add these entries with a JSON load and dump that keeps every other key; hook arrays from the user and local settings files are merged, so existing hooks keep running. Use an absolute interpreter path: on some systems a bare `python` resolves to a store stub that exits 0 and runs nothing, which turns every hook into a silent no-op.

## Codex registration

Codex reads hooks from `~/.codex/hooks.json` in the same JSON shape. Quote the interpreter and the script separately (`"\"<python>\" \"<script>\""`):
- PreToolUse: `guard.py`, matcher `apply_patch|Edit|Write`;
- PostToolUse: `check-handoff.py`, matcher `apply_patch|Bash|shell`;
- UserPromptSubmit: `pm_status.py`;
- Stop: `notify_wait.py --host codex`, timeout 10. Leave `notify` in `config.toml` alone; Codex has one `notify` slot and another program may hold it.

Codex runs a new hook only after it is trusted (`hooks = true`, and the hook's hash accepted through Codex's own hook review on the first run). mm never writes trust hashes itself.

## agy

agy has no hook registration. It is a dispatch target, not a PM host, so the guard does not apply to it; a HANDOFF edit made through agy is caught afterwards by `mm.py check`.

## Checking that the hooks work

- Guard: pipe `{"tool_name": "Edit", "tool_input": {"file_path": "<task>/ledger.json"}}` into `guard.py`; it must exit 2 and print `mm guard:`. The same payload for `<task>/notes.md` must exit 0 silently.
- PM fence: pipe the same Edit payload with `"session_id"` of a bound session and a product file into `mm.py fence --json`; it prints the same decision guard.py takes, as JSON, and exits 0.
- PM status: `mm.py bind --task-dir <task> --session test-1`, then pipe `{"session_id": "test-1"}` into `pm_status.py`; it prints the banner. Unbind afterwards.
- Archaeology: `check-handoff.py --check <HANDOFF.md>` prints violations to stderr and exits 1, and exits 0 on a clean file.
- Wait ping: with `MM_NTFY_DRY_RUN=1` and `MM_NTFY_TOPIC=test`, pipe a Stop payload whose `last_assistant_message` holds `PM mode:  mm PM for <task>` and `Blocked:  pick A or B` into `notify_wait.py --host claude-code`; one request appears in `<MM_STATE_DIR>/notify/outbox.jsonl` and nothing is sent.
- The skill's own tests cover them: `scripts/tests/test_hooks.py`, `scripts/tests/test_check_handoff.py` and `scripts/tests/test_notify_wait.py`.

## The wait ping

The wait ping requires the operator's approval and a configured notification topic; the notifier row of the approval table in SKILL.md names this exception to the hard-stop list. Only the hook sends it; the PM never posts to ntfy itself.

- PM only: the session's `mm.py bind` binding, else the Status Footer line `PM mode: mm PM for <task>`, else the PM banner in the last reply, else the newest banner in the transcript tail (Codex sessions are never bound). A footer `PM mode: no` stops it; a subagent payload (`agent_id`) never sends.
- Waits only: a PreToolUse on AskUserQuestion, or a Stop whose last `Blocked:` line is not `none` or `-`. A reply with no `Blocked:` line at all counts as waiting when its last line ends in `?`.
- The message carries the host, repo, task, local time, session id, working folder and a resume command; never the question, the `Blocked:` text or any reply text, which are only hashed to recognise the same wait. ASCII title `mm PM waiting - <host>`, UTF-8 `text/plain` body, tags `warning,computer`, priority `high`.
- Topic: `MM_NTFY_TOPIC` when set (empty turns the ping off), else `ntfy_topic` in `mm.local.md`; none, nothing is sent. The topic is a secret: it lives only in the overlay, never in skill text, settings or a dispatch prompt.
- At most one ping per session per minute; the same wait in the same session is not re-sent for 6 hours. State and a one-line log per decision, without message text, are in `<MM_STATE_DIR>/notify/`.
- `MM_NTFY_DRY_RUN=1` appends the request to `<MM_STATE_DIR>/notify/outbox.jsonl` instead of sending; the tests use only that. A network failure gives up after 4 seconds and is logged, never retried.
- agy has no hooks and is not a PM host, so it never pings. Codex `request_user_input` cannot be hooked; a Codex PM asks in plain text, which ends the turn and reaches the Stop hook.

## The archaeology symptoms

The PostToolUse check looks for five literal symptoms of history written into the HANDOFF, before Section 4 Archive: `preserved for audit trail`, `historical note kept for honesty`, `old content below` (at the start of a line), `initial assessment was` and `re-diagnosed`. The fix is always the same: state the current fact through `mm.py` and drop the history.
