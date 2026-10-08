# Prompts

Dispatch prompts for this task. The PM writes each one from the mm skill's prompt template, shows it to the operator, and records every dispatch with `mm.py dispatch`, which saves an exact copy of the prompt here and appends the record to `dispatches.jsonl`.

## Naming

`NN-<slug>.md`: `NN` is the order of dispatch, `<slug>` names the work. Copies saved by `mm.py dispatch` carry a timestamp and the dispatch id.

## What every prompt holds

- context first: the rows, spec excerpts and paths the agent needs, since it shares no context with the PM;
- the task: goal, in scope, out of scope, and a done-when line naming the proving command;
- the validation commands to run and report;
- the block for the agent's model family;
- the inbox writeback block, for every prompt;
- for background sessions, the envelope: the session's last act is writing `inbox/envelopes/<session slug>.envelope.json` with eleven keys (schema_version, session, task, emitted, status, summary, artifacts, changed_files, commit_message, notes_for_next_agent, human_action). Its absence tells the PM the session did not finish.

## Rules

- Launch the saved copy, never a later edit.
- Prompts, logs and outputs stay inside the task folder; at close they move under `archive/`, never deleted.
