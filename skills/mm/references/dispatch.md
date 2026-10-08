# Dispatch: routes, launches, liveness, envelopes and review rounds

Load this when choosing a route for agent work, launching a background session, dispatching to Codex or agy, judging an envelope, or running a review loop (Sections 4.6, 4.6.1 and 4.6.2 of SKILL.md).

## Contents
- Shapes
- Host routing: Claude Code as PM
- Host routing: Codex as PM
- agy
- Checking what is installed
- Approval and the dispatch record
- Background launch on Claude Code
- Liveness
- Codex mechanics
- agy mechanics
- The envelope
- Review rounds
- Roles
- Preflight, argv and stdin
- Regression harvest
- Babysitter facts (as of 2026-09-25)

## Shapes

| Shape | Use it for |
|---|---|
| In-session subagent | small, independent reads, research or reviews whose result the PM needs now |
| Background session | multi-step builds; anything that edits product code |
| Autonomous build launch | a background build that must run to completion without questions |
| Cross-family review | an audit of finished work by a model family other than the builder's |
| Optional judge | a yes/no verdict on an artifact against its spec |

The PM never builds in its own session. Work that needs product-code edits always goes to an agent.

## Host routing: Claude Code as PM

Each preferred route is a skill or plugin that may not be installed; the fallback needs nothing beyond the host CLIs.

| Shape | Preferred route | Fallback |
|---|---|---|
| In-session subagent | `workflow-it` | the Agent tool, with a self-contained brief |
| Background session | `bg-it` | `claude --bg --name "<session name>" "<launch> <abs prompt path>"`, run from the repo root with stdin from `/dev/null`; in Git Bash set `MSYS_NO_PATHCONV=1` |
| Autonomous build launch | `/babysitter:yolo <abs prompt path>`, when the babysitter plugin is installed | a plain prompt that carries the early-stop paragraph from `templates/prompt.md` |
| Cross-family review | `codex-review` (`node <skills>/codex-review/scripts/run-review.js --kind implementation --uncommitted --repo <repo> --out-dir <dir outside the repo>`; `--kind prd` or `spec` for documents) | `codex-cli`, else `codex exec --sandbox workspace-write -C <repo> "<prompt>"` |
| Optional judge | `agy` with the overlay's judge model | skip the judge, or run a second `codex-review` pass |

## Host routing: Codex as PM

Codex has no Claude Code workflows, no `bg-it` and no in-session cron. It dispatches through its own subagents and `codex exec`.

| Shape | Preferred route | Fallback |
|---|---|---|
| In-session subagent | Codex's own subagents | a foreground `codex exec` with a self-contained brief |
| Background session | `codex exec` as a background process, with `--json` events to a file | `claude -p "<launch> <abs prompt path>"` for Claude-family work |
| Cross-family review | `claude -p` with the review prompt | `agy` with the overlay's judge model |

Auto-commit from a Codex PM needs a sandbox that can write `.git`. Under `--sandbox workspace-write` git cannot create `.git/index.lock`, so every `mm.py` write exits 13 and its message says `.git` is not writable by this process, naming a sandbox or the folder's permissions as possible causes; the files stay written. When git itself fails there (for example `detected dubious ownership`), the refusal and `mm.py status` print git's first error line instead of reporting no changes. Run the Codex PM with a sandbox that can write `.git`, or the operator commits the paths `mm.py status` lists as uncommitted.

## agy

agy is a dispatch target and a judge, never a PM host. It reads the skill through the shared skills folder but runs no hooks.

## Checking what is installed

Probe cheaply before offering a preferred route, and use the fallback when it is missing:
- Claude Code skills: list the user skills folder (a folder `<name>` is the command `/<name>`);
- plugins: `claude plugin list` (the babysitter plugin gives `/babysitter:yolo` and `/babysitter:call`);
- CLIs: `codex --version`, `agy --version`, or `mm_preflight.preflight(...)` with the overlay's paths.
Never launch through a route the probe did not find.

## Approval and the dispatch record

1. Draft the prompt from `templates/prompt.md` and save it under `prompts/NN-<slug>.md`.
2. Attended: show the prompt verbatim, then its path, the route and the model, and ask (the dispatch row of the approval table in SKILL.md).
3. Record it: `mm.py dispatch --task-dir <dir> --route <route> --model <model> --prompt-file <file> --approved-by <operator> [--row <id>] [--launch "<launch template>"]`. In unattended mode `--approved-by` approves nothing: the CLI checks the loop's approved route:model list. An off-list dispatch waits for the operator (the dispatch row of the approval table); the exception that row names is recorded with `--operator-exception <operator> --exception-reason "<the operator's words>"` and kept under `exception` in the record. Without an approval it exits 9 and nothing is launched.
   Attended, a one-time approval may replace `--approved-by`: `mm.py approve-dispatch --task-dir <dir> --row <id> --route <route> --model <model> --worker <subagent|workflow|codex|bg|other> --prompt-file <file> [--launch "<launch template>"]` records the approval bound to that prompt's sha256 for 15 minutes, then `mm.py dispatch ... --row <id> --approval-id <id> --worker <kind>` consumes it once; any change to the prompt, row, route, model, worker or launch refuses it with exit 9 (`MM-APPROVAL-REFUSED <code>`). The Claude Code plugin's dispatch dialog runs these two commands. Details in runtime.md.
4. The record goes to `prompts/dispatches.jsonl`, with an exact copy of the prompt under `prompts/`. Launch that copy, not a later edit.
5. When the work ends, `mm.py dispatch --close <id> --outcome "<one line>"`.

## Background launch on Claude Code

- Launch template: `/babysitter:yolo <abs prompt path>` by default; the overlay's `launch_override` replaces it. `{prompt}` in it becomes the prompt copy's absolute path, and a template without `{prompt}` is a prefix that the path follows; the dispatch record stores the result as `launch`, the exact text to launch, the path it put there as `prompt_path`, and the folder the launch runs from (the repo holding the task folder) as `launch_cwd`.
- Session name: `<repo folder> | Agent | <task>`.
- Through `bg-it` when installed; otherwise the fallback command in the Claude Code table.
- `claude --bg` needs a trusted workspace. In a folder Claude Code was never opened in and trusted, it prints `Workspace not trusted ...`, exits 1 and launches nothing. Trusting a folder writes the operator's Claude Code config, so the PM never does it: report it and name the fix (run `claude` in that folder once and accept the trust prompt). Capture the launch output to a file; `launch-check --launch-log <file>` then reports DEAD with that line at once.
- Never run a build prompt inline in the PM session, and never launch twice for one row: check the dispatch records first.
- After launching, a file on disk is not delivery. Run `launch-check` (next section).

## Liveness

`mm.py launch-check --task-dir <dir> --dispatch-id <id> --run-dir <babysitter runs dir>` (Claude Code) or `--events <codex events file>` (Codex), plus `--launch-log <file>` when the launch output was captured, answers ALIVE, PENDING or DEAD and appends the verdict to the dispatch record. Exit 1 means DEAD. A `--launch-log` file that is missing or unreadable exits 4, names the path and records nothing.

The PM does not supply the builder's transcript. launch-check looks in Claude Code's project folder for the folder the launch ran in (`$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, then the folder path with every character other than a letter or digit turned into `-`, so `D:\work\my_app` is `D--work-my-app`; a name longer than 200 characters is cut to 200 and given `-` and a hash, as Claude Code does, and any folder starting with the same cut name is looked in). That folder is the record's `launch_cwd`, so a task moved after its dispatch is still found where its builder started; an older record without it uses the repo holding the task folder now; `--cwd <folder>` names another, such as a worktree the launch ran in. A transcript counts when its first record is stamped at or after the launch, which rules out the PM's own session, and it holds this dispatch's launch record. Exactly one is the builder's, and its path is in the reason. None yet is PENDING inside the first 20 s and DEAD after it; several is PENDING with their names, and `--session-id <id>` picks one. `--transcript <file>` still wins, but a file that cannot be read, or that does not hold this dispatch's launch record or a failure record tied to it (below), is refused with exit 2 and nothing is recorded; a file not written yet is judged as no transcript; a tool result quoting the launch record is not the record.

The facts it uses, each tied to this dispatch:
- within about 15 s the session transcript shows the launch command record (`/babysitter:yolo`) naming this dispatch's prompt copy, stamped after the launch time, and then an assistant tool_use in the chain that record started (records linked to it by parentUuid, up to the next prompt typed into the session; a background-task notification or a tool result does not end it); an 'Unknown command' record for the launch command itself (its direct result, or one naming it, in full or by its name after the plugin prefix, stamped after the launch) means DEAD, while a later prompt's unknown command, or one of another command, does not. A launch that is not a slash command (its first word is not `/name` or `/plugin:name`: a plain prompt, or another command, such as an absolute executable path like `/usr/bin/run`) is proven only by a user record holding the whole stored `launch` text, never by one that just names the prompt copy; a record whose `launch` does not hold its stored `prompt_path`, or holds no letter or digit besides that path (only whitespace, quotes, brackets or other punctuation around it), is never ALIVE: PENDING, then DEAD at the stall limit, also when no transcript names the prompt copy. An older record without `prompt_path` whose launch is not a slash command is PENDING with the reason `record predates prompt_path; cannot prove this launch; operator must check the builder by hand`, and never DEAD by time (a failure line in `--launch-log` is still DEAD); no transcript can prove it, so a `--transcript` file that exists is refused with exit 2 and nothing is recorded. The first ALIVE check records the session id; `--session-id` sets it explicitly;
- within about 6 min a babysitter run exists whose processId is not `bare-run`, whose `createdAt` is at or after the launch, and whose run id a `run:create` call in that chain returned (a run only mentioned later, or created after another prompt, is not this launch); runs without a usable `createdAt` never count;
- after that the run journal keeps growing between checks; a journal that has not grown for the stall limit (`--stall-minutes`, 60 by default) makes the launch DEAD;
- for Codex, the events file shows `turn.started`;
- the launch command's captured output (`--launch-log <file>`): a line saying the workspace is not trusted, an unknown command, or a missing executable makes the launch DEAD at any time.
A bare run folder alone is never proof: a session-start hook creates one for dead sessions too. File times are never used.

Timing: run the first check about 20 s after the launch command returns (the reliable way is the same shell call: launch with its output captured, wait 20 s, then `launch-check --launch-log`), and again at about +6 min. A first check that runs later still gives the right verdict, but its reason says it came late. Attended: report a DEAD verdict with its reason and propose a relaunch. Unattended: a DEAD verdict ends the tick and is reported. A PENDING whose reason says the record predates prompt_path never ends by itself: attended, surface it to the operator; unattended, the tick is a no-op waiting on the operator (the no-op cap stops the loop if it stays). The operator checks the builder by hand, then `mm.py dispatch --close <id> --outcome "<what they found>"`; a relaunch is a new dispatch.

## Codex mechanics

- Write the prompt to a file inside the task folder; never pass a long prompt inline.
- The agent writes its own deliverable: say `Write your output to <abs path>` in the prompt, run with `--sandbox workspace-write`, and leave out `-o`, because `-o` overwrites that file with Codex's final message when the process exits.
- Codex's final message is the deliverable (a short verdict): a read-only run with `-o <abs path>`.
- Take the model from Codex's own config or the overlay; pass `-m` only when the operator chose a model for this dispatch.
- For background runs add `--json` and send the events to a file, so `launch-check --events` can read them. Close stdin (`< /dev/null`) whenever the prompt is passed as an argument.
- The prompt carries the inbox writeback block and names the inbox path; Codex writes the entry itself.

## agy mechanics

- Use the overlay's judge model.
- agy needs a real console on some platforms and renders to it: do not pipe or redirect its printed output. Tell it in the prompt to write its verdict to an absolute path, then read that file.
- A wrong model or effort pairing exits within seconds with nothing written; a live process with no output is still running.

## The envelope

Every background session's last act is writing `<task>/inbox/envelopes/<session slug>.envelope.json`. Its absence is the failure signal. Eleven keys, all required:

| Key | Value |
|---|---|
| `schema_version` | 1 |
| `session` | the session name, verbatim |
| `task` | the task name |
| `emitted` | ISO 8601 time with offset |
| `status` | `completed`, `blocked` or `failed` |
| `summary` | at most 400 characters: what actually happened |
| `artifacts` | list of paths |
| `changed_files` | list of repo-relative paths |
| `commit_message` | the commit subject, or an empty string |
| `notes_for_next_agent` | text, or `none` |
| `human_action` | what the operator must do, or `none` |

`<interpreter> ${CLAUDE_SKILL_DIR}/scripts/validate_envelope.py <path>` exits 0 for a valid completed envelope, 1 for a missing or malformed one, and 2 for a valid envelope that reports blocked or failed work. Keep 1 and 2 apart: 1 means the report cannot be trusted; 2 means it can, and says the work did not succeed. An envelope is a report, not evidence: rows still go green only on evidence the PM checked.

## Review rounds

- At most 3 rounds per review loop, unless the operator raises it for one dispatch. The round number is in every artifact name: `review_1.md`, `fix_1.md`, `review_2.md`.
- The rubric is frozen at round 1; its sha256 goes in the dispatch record and the ledger's `rounds.rubric_sha256`. Categories found in later rounds go to `rounds.residual`, not into the fix.
- After round 3 without approval the outcome is 'not accepted: never approved after 3 rounds'. It is reported, never looped again and never shown as green.
- Score gates use `>=`.
- Scope rule for triage: work the request never asked for is not blocking on its own; work the request did ask for and is missing always is.
- Review prompts ask for coverage first (every finding, with confidence and severity); the PM filters afterwards.

## Roles

| Role | Reads | Writes |
|---|---|---|
| researcher | anything in scope | nothing |
| reviewer | anything in scope | nothing |
| builder | anything in scope | only inside its assigned worktree |
| integration | anything in scope | git and PR operations |
| deploy | anything in scope | only an approved commit; deploy is on the hard-stop list |

A check built on `git diff` detects a breach after the fact; it prevents nothing. Name it that way.

## Preflight, argv and stdin

- Resolve every executable before launching: `mm_preflight.preflight(requirements)` returns the path and version of each, collects every problem before raising, and rejects Store stubs and virtual-environment interpreters. Candidates come from the overlay's paths and from PATH.
- Spawn with an argv list, never a shell string.
- Save the exact prompt before running it. Saved prompts and logs stay inside the task folder and are archived, never deleted.
- stdin: a launcher that passes the prompt as an argument closes stdin; a child that inherits an open stdin waits forever with no output.

## Regression harvest

When a manual check proves a bug, the bug-fix prompt asks the builder to turn those steps into a test named after the observed failure, to show it red before the fix and green after, and to name the test in the inbox entry. The PM records the test path in the row's notes.

## Babysitter facts (as of 2026-09-25)

- The plugin commands are `/babysitter:yolo` (non-interactive) and `/babysitter:call` (interactive).
- Always use the `babysitter:` command prefix; unqualified aliases are not portable.
- The npm `latest` dist-tag of the SDK (6.0.0) is broken for the hooks; pin 6.0.3.
- Git Bash rewrites arguments that start with `/`; set `MSYS_NO_PATHCONV=1` for launches from Git Bash.
