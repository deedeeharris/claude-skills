# Runtime: status JSON, the PM fence, dispatch approvals and the Claude Code plugin

Load this when a tool or a person reads mm state as JSON, when `mm guard` refused a PM write, when a dispatch is approved through `approve-dispatch` or the Claude Code dialog, or when installing, debugging or removing the optional Claude Code plugin `mm-runtime` (Sections 4.4 and 4.6 of SKILL.md).

## Contents
- Roles and the session binding
- status --json (mm.status/1)
- The PM write fence
- fence --json (mm.fence/1)
- One-time dispatch approvals (mm.approval/1)
- product-changes --json (mm.changes/1)
- The Claude Code plugin
- Install, enable and roll back
- Where the fence is not enforced
- Tested version

Everything below works without the plugin: the CLI, the fence in `hooks/guard.py` and the approval store are Python, and the plugin only calls `mm.py`.

## Roles and the session binding

- `mm.py bind --task-dir <task> --session <id>` makes that session the task's PM. The binding file (under `MM_STATE_DIR`, outside every repository) records `task_dir`, `bound_at`, `role` (always `pm`), `repo_root` and `repo_root_source`.
- `repo_root` is the fence root, resolved once at bind: the git top level of the task's worktree (`repo_root_source` `git`), or, outside any repository, the folder holding the PM root (`no-git`). A git failure refuses the bind with exit 21. A root that is a filesystem root, or that is or holds the home folder, is refused with exit 2 and nothing is written: move the task into a repository or a project folder below the home folder.
- A binding without `repo_root` predates this version: run `mm.py bind` once more. Until then every PM write outside the PM folder is refused (fail closed).
- Workers are never bound. A delegated worker is recognised by the `agent_id` in its hook payload, which wins over the binding; a payload without a usable `agent_id` in a bound session is the PM. Codex sessions are never bound, so they write as workers. Worker prompts say: never run `mm.py bind` or `unbind`.
- A binding stays on after the task is closed or moved, until `mm.py unbind --session <id>`.

## status --json (mm.status/1)

`mm.py status --json --session <id>` (only the binding is read) or `--task-dir <task>` prints exactly one JSON object and exits 0, also for an unbound session and every failure below; exit 2 is a usage error. Human `status` (no `--json`) is unchanged and needs `--task-dir`. Added fields keep `mm.status/1`; a removal, rename or type change would be `mm.status/2`.

| Field | Meaning |
|---|---|
| `schema` | `mm.status/1` |
| `ok` | true when `errors` is empty |
| `generated_at` | local ISO time, seconds, with offset |
| `mm_version` | the mm.py version |
| `session` | `id`, `binding_state` (`absent`, `ok`, `unreadable`, `not-asked`), `bound`, `role` (`pm` or null), `role_source` (`binding`, `legacy-default`, `fail-closed` or null), `bound_at` |
| `task_source` | `explicit`, `session` or `none` |
| `task` | `name`, `dir`, `repo_root`, `repo_root_source`, `dir_exists`, `legacy`, `revision`; null without a task |
| `mode` | `attended` or `unattended`; null without a readable ledger |
| `open_row` | the first row not terminal and not the wrap-up: `id`, `item`, `state`, `status_label` |
| `rows` | every row: `id`, `item`, `state`, `status_label`, `blocked`, `user_facing`, `test_level`, `pr`, `test_page`, `is_wrapup` |
| `waiting_on_operator` | `{row, kind, text}`, kind `decision`, `verification` or `human_check`, as human status lists them |
| `inbox` | `entries`, `problems`, `closed_task_files` |
| `dispatches_in_flight` | records: `id`, `at`, `route`, `model`, `row`, `mode`, `worker`, `approval_id`, `last_verdict` |
| `loop` | `mode`, `cadence`, `routes`, `noop_count`, `noop_cap`, `last_tick`, `stopped_reason`, `owner_session` |
| `check` | `status` (`ok`, `fixable`, `failed`, `not_run`), `code`, the first 20 `lines` of `mm.py check` |
| `uncommitted` | the PM paths git reports as changed; null when git failed |
| `errors` | `{code, message}`; each message ends with its recovery command |

Read `task`, `inbox`, `loop`, `open_row` and `uncommitted` only after a null check.

| Error code | Recovery the message ends with |
|---|---|
| `SESSION-ID-UNUSABLE` | pass the session id Claude Code reports |
| `BINDING-UNREADABLE` | `mm.py unbind`, then `mm.py bind` (every PM write is refused meanwhile) |
| `BINDING-LEGACY` | `mm.py bind` once to record the repository root |
| `TASK-DIR-MISSING` | the folder moved or closed: `mm.py unbind`, then bind it where it now lives |
| `NO-TASK` | pass `--task-dir`, or bind a task |
| `LEDGER-INVALID` | `mm.py check`, then repair with mm.py commands |
| `GIT-FAILED` | fix what git's quoted first error line names |
| `FENCE-ROOT-TOO-BROAD` | `mm.py unbind`; bind refuses that root |
| `CHECK-RAISED` | run `mm.py check` to see the error |
| `INBOX-UNREADABLE` | `inbox` is null: run `mm.py inbox-scan` to see which file, fix or move it aside |
| `DISPATCHES-UNREADABLE` | `dispatches_in_flight` is empty: inspect `prompts/dispatches.jsonl` and move the bad line aside |

## The PM write fence

`hooks/guard.py` (PreToolUse) and `mm.py fence` make one decision through `scripts/mm_fence.py`. Write tools are Edit, Write, MultiEdit, NotebookEdit and Codex `apply_patch`. Every target is resolved first (links, junctions and `..` followed, case folded on Windows), so a path through a link is judged by where it really lands.

| Who | Target | Decision |
|---|---|---|
| anyone | a task's `ledger.json` or a generated file | refused, with the existing mm.py command list |
| anyone | no target can be found | refused (cannot tell which file) |
| worker (`agent_id`), or an unbound session | anything else | allowed |
| PM, binding unreadable | anything, PM notes included | refused: unbind, then bind |
| PM | the PM folder tree (`.private/pm`, `.claude/pm`, `docs/pm`) | allowed |
| PM, binding without a usable `repo_root` | anything else | refused: bind again (legacy) or unbind (too broad) |
| PM | inside `repo_root`: product code | refused: delegate it, or leave PM mode with `mm.py unbind` |
| PM | outside `repo_root` (`~/.claude`, memory, other folders) | allowed |
| PM | the path cannot be resolved | refused (fail closed) |

Shell commands, delegation tools (Agent, Task, Workflow, Skill, the plugin's dispatch tool) and every other tool pass the fence. A PM shell command that changes product files is caught afterwards: the plugin warns and its tool result tells the PM to stop and ask the operator (the turn is never aborted), and `mm.py check` still catches hand edits of generated files. Other worktrees of the same repository lie outside the root.

## fence --json (mm.fence/1)

`mm.py fence --json` reads one hook payload on stdin (`tool_name`, `tool_input`, `session_id`, `cwd`, and `agent_id` when present) and prints `{schema, decision, actor, targets, messages}`: `decision` `allow` or `deny`, `actor` `pm`, `worker`, `unbound`, `pm-unreadable` or `unknown`, `targets` as `{path, class}`. It exits 0 whenever it prints, an unreadable payload included (`deny`), takes no lock and writes nothing.

## One-time dispatch approvals (mm.approval/1)

The `--approved-by` path is unchanged. `approve-dispatch` is a stronger attended path that binds the approval to one exact dispatch:

1. `mm.py approve-dispatch --task-dir <dir> --row <id> --route <route> --model <model> --worker <subagent|workflow|codex|bg|other> --prompt-file <file> [--launch "<template>"] [--operator <name>] [--channel cli|cc-dialog] [--session <id>] [--ttl-minutes N] [--expect-sha256 <hash>] [--json] [--dry-run]` appends one record to `prompts/approvals.jsonl` and prints `MM-APPROVAL-OK <id> sha256=<first 12 hex> expires <time>`.
2. `mm.py dispatch ... --row <id> --approval-id <id> --worker <kind>` consumes it and records the dispatch with `approval_id` and `worker`.

- The record holds `id` (`a<N>`), `task`, `task_dir`, `row`, `route`, `model`, `worker`, `launch` (the resolved template: the route's default `/babysitter:yolo {prompt}` for a background route when `--launch` is absent), `prompt_path`, `prompt_sha256`, `prompt_bytes`, `operator` (default: `operator_name` in `mm.local.md`; neither given is exit 2), `channel`, `session`, `approved_at`, `expires_at` (TTL 1 to 1440 minutes, default 15), `consumed_at` and `consumed_by`.
- approve-dispatch refuses: unattended mode or a row the ledger does not hold (exit 2), an unreadable prompt (4), `--expect-sha256` not matching the file (exit 9, `MM-APPROVAL-REFUSED PROMPT-CHANGED`), a held lock (10), a malformed `approvals.jsonl` (22: move it aside and approve again).
- dispatch refuses `--approval-id` together with `--approved-by`, without `--worker`, or in unattended mode (exit 2). Under the same lock as the record it checks, in order: the id exists (`UNKNOWN`), not consumed (`CONSUMED`), not expired (`EXPIRED`), the same task, task folder (`task_dir`, compared resolved and case-normalized, so an approval copied into another worktree's copy of the task approves nothing there), row, route, model, worker and launch (`MISMATCH:<field>`), and the sha256 of the exact prompt bytes it copies (`PROMPT-CHANGED`). Each refusal exits 9 with `MM-APPROVAL-REFUSED <code>` and writes nothing.
- The approval is marked consumed before the dispatch is appended. A crash between the two leaves a consumed approval and no dispatch: approve again. An approval is never reused; two racing dispatches record one.
- The record is durable evidence bound to the exact call, not cryptographic proof: a PM can run `approve-dispatch --channel cc-dialog` from a shell. It is UX and runtime enforcement.
- `approvals.jsonl` is committed with the dispatch and moves with the task at close.

## product-changes --json (mm.changes/1)

`mm.py product-changes --task-dir <dir> --json [--baseline <file>|-]` prints `{schema, repo_root, head, files, submodules}`: every dirty or untracked file git sees outside the PM folder tree as `[size, mtime_ns]` (null: deleted), and the HEAD commit (null before the first commit). With a baseline document it adds `changed`: files whose fingerprint differs, plus the product files committed in between when HEAD moved. A dirty submodule is fingerprinted from the inside: its own dirty files appear in `files` under `<submodule>/<path>`, and its checked-out HEAD in `submodules` (`{path: commit or null}`), so a further edit or commit inside it shows in `changed`. No repository gives empty `files` and exit 0; a git failure exits 21 and prints no document. It is read-only and takes no lock. Same-size rewrites within one mtime tick can escape it.

## The Claude Code plugin

`integrations/claude-code/mm-runtime/` holds an optional Claude Code plugin (a hooks module). It owns no MM state: every action is a `mm.py` call with an argument list, never a shell string. It adds:
- a status line from `status --json`, refreshed at session start, after `/clear` or `/resume`, at the end of each turn, after its dispatch tool, and after any shell command naming `mm.py`;
- the same fence for Edit, Write, MultiEdit and NotebookEdit through `mm.py fence --json`, failing closed when mm.py errors or times out; `hooks/guard.py` still runs after it;
- one typed tool, `dispatch`: attended and interactive, it shows the row, worker, route, model, launch, prompt path, sha256 and size in a dialog; Approve runs `approve-dispatch --expect-sha256` then `dispatch --approval-id`; a non-interactive session is refused; unattended, it runs `dispatch` with the approved list;
- a boundary warning after a PM shell call that changed product files (`product-changes` before and after): a toast, a status prefix and context for the next prompt. When the change is attributable to the PM call, the shell call's result also carries a stop note: do not continue the task, tell the operator what changed and ask how to proceed, revert nothing. The turn is never aborted. The change is `UNCERTAIN` (warning only, no stop note) when a worker or dispatch may have been active: a worker call or worker background shell, an overlapping or backgrounded PM shell call, in-flight dispatches at the start, dispatches that appear or a dispatch tool call during the call, or an unknown dispatch state (`DISPATCHES-UNREADABLE`, or no status). A failed `product-changes` read after the call counts as a change (`BOUNDARY MONITOR FAILED`). A new session id after `/clear` drops the previous session's pending warnings. Nothing is ever reverted;
- `/mm-runtime`, a pane with the rows, what waits on the operator, the inbox, in-flight dispatches, agent ids seen this session (historical, not live), the loop, check and uncommitted files.

While the plugin is active it sets `MM_CC_RUNTIME_MOD_ACTIVE` to the session id, and `hooks/pm_status.py` then leaves out its banner (the context line stays). The guard and the archaeology hook never read it.

## Install, enable and roll back

- Install a copy outside the skill folder, never the source in place: `<python> <mm skill dir>/scripts/mm_runtime_install.py --dest ~/.claude/mm-runtime --python <absolute python> [--dry-run]`. It copies `integrations/claude-code/mm-runtime/` without its `tests/` folder and writes the copy's `mm-config.ts` with the interpreter and this skill's `mm.py`, each as a JSON string literal. Its first line is `MM-RUNTIME-INSTALL-OK <dest>` (with `--dry-run`: `MM-RUNTIME-INSTALL-DRY-RUN <dest>: nothing written`, and nothing is written); then `copied <n> files from <source> (tests/ left out)`, `wrote <dest>/hooks/mm-config.ts: PYTHON = "<python>", MM_PY = "<mm.py>"` (`would copy`, `would write` in a dry run), the line `enable, with the operator's approval: add <dest> to env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json (append it after ';' when the variable already has a value); this script edited no settings file` (the separator is the platform's path separator, `;` on Windows), and `check: claude plugin validate --strict <dest>`. It refuses with exit 2 and writes nothing when the destination is inside the skill folder or inside `~/.agents` (the shared skills tree Codex and agy read), holds files that are not an earlier mm-runtime copy, or `--python` is not a file. Run again on its own copy, it overwrites the files and rewrites `mm-config.ts`. It edits no settings file.
- Enable with the operator's approval: add the copy's absolute path to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (JSON load and dump, every other key kept; append to an existing value with `;`). Check with `claude plugin validate --strict ~/.claude/mm-runtime` and a session started with `--debug-file`: it logs `mm-runtime@inline loaded`.
- An empty `mm-config.ts` means not configured: every call passes through and the status line says `MM runtime: not configured`.
- Roll back: remove the path from `CLAUDE_CODE_PLUGIN_DIRS` and delete the copy. A running session keeps the marker until it restarts, which only hides the banner. Settings hooks and bindings are unaffected.

## Where the fence is not enforced

Under `claude --safe-mode` and `claude --bare`, Claude Code runs no user settings hook and no installed plugin, so neither `hooks/guard.py` nor the plugin runs and the PM fence is not enforced: a PM write to product code goes through. mm stays usable there: the mm.py CLI, the ledger, `status`, `check` and dispatch records work as everywhere else. `"disableAllHooks": true` in the settings has the same effect. This is a documented gap; nothing claims enforcement in those modes.

Hooks set by managed-policy settings are the only hooks those modes keep. An organization's administrator installs them; a published skill cannot, so mm does not use them.

## Tested version

The plugin and the payload shapes were checked against Claude Code 2.1.287 (`claude -p`). The interactive TUI, teammates and nested subagents were not probed; where a payload's `agent_id` is missing or ambiguous the actor is the PM and the write is refused, which is visible and recoverable.
