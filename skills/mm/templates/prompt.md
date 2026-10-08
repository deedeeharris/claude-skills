<!-- Dispatch prompt skeleton. The PM copies this into <task>/prompts/NN-<slug>.md, fills every <...>, deletes the family blocks that do not apply, and keeps the order: context first, instructions last. The agent reads it with no access to the PM's conversation. -->

<context>
<!-- Long material first: excerpts of the HANDOFF rows, the spec, logs, earlier findings. Quote them; the agent has none of the PM's context. -->
Project: <project>, repository at <absolute repo path>, branch or worktree <branch or worktree path>.
Task: <TASK>, row <#id>: <row item>.
Background: <what is known, with citations: file:line, commit, report path>.
Read first: <absolute paths, most important first>.
</context>

<task>
Goal: <one sentence: the observable end state>.
In scope: <files, modules, behaviours>.
Out of scope: <what must not be touched or changed; name the files and folders>.
Done when: <the observable result> proven by <the exact command> compared against <the baseline the PM measured>.
Work layer: <research | design | implementation | review>.
</task>

<validation>
Run these and report each command with its exit code:
- <targeted tests for the changed behaviour>
- <type check or lint, when the repo has one>
- <build of the affected package, when applicable>
If a check cannot be run, say why and run the next best one. For a bug fix, first turn the steps that proved the bug into a test named after the observed failure, show it failing, then fix it and show it passing.
</validation>

<!-- Family block: Claude builder. Keep for Claude Code sessions. -->
<claude_rules>
Do exactly what the task block asks, for every item it lists; do not add features, refactors or files it does not ask for. Put every PM-facing artifact inside <absolute task folder>. Never edit ledger.json, HANDOFF.md, HANDOFF-archive.md or ROADMAP.html; report through the inbox instead. Never run mm.py bind or unbind.
</claude_rules>

<!-- Family block: Codex. Keep for codex exec. -->
<codex_rules>
You may run read-only commands, reversible edits inside the scope above, and the validation commands without asking. Ask only before external writes, destructive actions, purchases, or a material expansion of scope. Sandbox: workspace-write in <absolute repo path>. Write your deliverable to <absolute output path> yourself; the launcher does not capture your final message. Use subagents for independent parts of the work when that is faster, and wait for all of them before reporting. Lead your report with the conclusion, then the evidence, any material caveat, and the next action. Never edit ledger.json, HANDOFF.md, HANDOFF-archive.md or ROADMAP.html. Never run mm.py bind or unbind.
</codex_rules>

<!-- Family block: agy judge. Keep for agy runs. -->
<judge_rules>
Answer each rubric item yes or no, with the evidence (file:line or command output) for each answer. Write your verdict to <absolute output path>; do not rely on printed output.
</judge_rules>

<!-- Review prompts only: coverage first. -->
<review_rules>
Report every issue you find, including ones you are uncertain about or consider low-severity. For each finding give the file and line, your confidence, and an estimated severity, so a later step can rank them. The rubric below is frozen for all rounds: <rubric>. Round <n> of at most 3; name your report review_<n>.md.
</review_rules>

<!-- Background sessions only (unattended runs): the early-stop paragraph. Leave it out of in-session subagents. -->
<completion_rules>
A text-only end of turn is a report, not completion. Keep the task's parts in a checklist you update as you go. Do not stop while something you started (a background command, a subagent) is still running. If you find yourself continuing the same step more than two or three times without progress, stop, write a blocked inbox entry saying what is in the way, then write the envelope with status blocked.
</completion_rules>

<inbox_writeback>
Report to the PM through the task inbox at <absolute task folder>/inbox/. If you skip this, your work disappears from the task state.
Preferred: <interpreter> <absolute mm scripts folder>/mm.py inbox-write --task-dir <absolute task folder> --source <your slug> --status <in-progress|completed|blocked|error|failed> --task-ref <#id> --body-file <file holding the six sections>
Otherwise write <absolute task folder>/inbox/<YYYYMMDD-HHMMSS>-<your slug>.md yourself, never overwriting an existing file, with this frontmatter: agent, session, started, emitted, status (in-progress, completed, blocked, error or failed), task_ref (<#id>). The body has six sections, in this order, each present even when its answer is 'none': ## What was done, ## What's next, ## Blockers, ## Files changed, ## Evidence, ## Notes for PM.
Write an entry at the start and end of each phase, at each long milestone, immediately on a blocker (status blocked, with your ask), when you take a fallback, and at the end. Put screenshots, logs and large outputs in <absolute task folder>/evidence/ and cite their paths under Evidence. Never edit or delete an earlier entry.
</inbox_writeback>

<envelope>
Background sessions only: your last act is writing <absolute task folder>/inbox/envelopes/<session slug>.envelope.json, a JSON object with exactly these eleven keys: schema_version (1), session (your session name, verbatim), task (<TASK>), emitted (ISO 8601 with offset), status (completed, blocked or failed), summary (at most 400 characters, what actually happened), artifacts (list of paths), changed_files (list of repo-relative paths), commit_message (subject line or empty string), notes_for_next_agent (text or 'none'), human_action (what the operator must do, or 'none'). Its absence tells the PM the session did not finish.
</envelope>
