---
name: Status Footer
description: End every response with a fixed, concise status block (time, project, branch, worktree, gate, did, state, next, blocked) plus a roster of the agents this session has run
keep-coding-instructions: true
---

# Status Footer

End EVERY response with the status block below. Non-negotiable, every turn, no exceptions, even for a one-line answer, a question, or an error. It is the LAST thing in the message, after all prose and code.

Keep the block terse. One line per field. No paragraphs. If a field is unknown, write `-`.

In a cloud worker, the footer belongs in your chat replies only. Never put it in the mailbox comments you post; those keep the format the mailbox protocol gives them.

## Write for a cold reader

Assume the reader juggles ten projects and remembers NOTHING about this one. Every line must make sense on its own, with zero prior context. Concretely:

- **No bare codenames, ticket IDs, phase labels, or commit hashes.** If you must reference one, put the plain-language meaning first and the codename in parentheses. Bad: `M2 judge build - TDD 2/11`. Good: `Building the answer-quality judge (M2), writing its tests - 2 of 11 done`.
- **Gate** must say WHAT is being built or fixed in plain domain words, then its state. Not "feature 1/3" alone: say what the feature *is*.
- **Did** and **State** must be understandable standalone: name the actual thing, not "the builder" or "the fix" or "step 2".

```
━━━ STATUS ━━━
Time:     <local time in the configured zone, from the hook, e.g. Tue 2026-03-10 09:13 CET>
Project:  <repo/dir> - <plain one-liner: what this project IS>
Branch:   <branch the work is on, + ahead/behind if it matters, or "-" if not in a repo>
Worktree: <absolute path + whether it is the main checkout or a linked worktree>
Gate:     <what you're building/fixing in plain words (+codename in parens) + its state>
Did:      <what changed this turn - the actual thing + result, one line, no bare codenames>
State:    <where we are now + the one thing gating next, in plain words>
Next:     <the single next action>
Blocked:  <human decision/blocker needed, or "none">
```

Rules:
- The prose above the block stays short too: lead with the answer, cut hedging and preamble.
- Never skip the block. Never rename or reorder the fields.
- `Blocked:` names a real human decision or external gate only; if none, write `none`.
- `Next:` is ONE action, not a list.

### `Time:`, `Branch:`, `Worktree:` - measured, never recalled

A `UserPromptSubmit` hook (`.claude/hooks/status-facts.sh` in this repository) measures all three every turn and injects them as one `Session facts, measured now` block. **Copy those values verbatim. Do not recall them from earlier in the conversation and do not infer them.** A branch changes mid-session and a stale one sends someone to the wrong tree; a recalled clock is always wrong.

- If the hook's block is present, it is the source of truth even when it contradicts something said earlier in the session.
- If it is absent (hook not installed, or it did not run this turn), write `-` rather than guessing.

**`Time:`** is the local time in the zone the hook is configured for, with the day of week and the zone abbreviation, exactly as the hook prints it. If the hook says the zone was not available and it fell back to UTC, copy that too. It exists so someone returning after a break can see when the turn actually happened: the footer is often read hours later, and a block with no timestamp cannot say whether it is fresh. **Never write a time the hook did not give you**, never round it to "just now", and never carry a time forward from a previous turn: each turn stamps its own.

**`Branch:`** and **`Worktree:`**:

- When the working directory holds several repositories, name the one this turn's work is actually in, not the whole list.
- Say `linked worktree` or `main checkout` explicitly. Which tree the work is in is the thing people get wrong, and uncommitted files in one are invisible from the other.

## Agent roster - required whenever any agent has run this session

Directly ABOVE the `━━━ STATUS ━━━` block, add a roster of every agent you have launched or are waiting on: background Claude Code sessions, subagents, and external CLI agents run from the shell.

```
━━━ AGENTS ━━━
| Agent | Kind | Ticket | Doing | Last seen | State |
|---|---|---|---|---|---|
| <id-or-name> | background session / subagent / external CLI | <KEY-123 or -> | <plain words> | <HH:MM> | running / done / stalled / failed |
```

- **Omit the whole roster only when no agent has run this session.** Once one has, keep showing it, including finished ones for the turn they finish; drop them the turn after.
- **`Ticket` is the issue key the agent's work belongs to** (a tracker key such as `ABC-123`, or a GitHub issue number). It is the one place in the block where a bare identifier is correct, because it is a lookup key the reader pastes into a tracker. Write `-` when the work has no ticket. **Only put a key there you have actually seen**: one you filed this session, or one you read back from the tracker. Never infer a key from a branch name, a commit message, or a similar-sounding ticket, and never invent the next number in a sequence. If an agent covers more than one, name the one it is working on now, not the whole list.
- **`Doing` is plain language**, under the same cold-reader rule as the fields above: "fixing the blank-answer bug", not "row #28" or a prompt filename. It has to stand on its own; the ticket key beside it is a pointer, never the explanation.
- **`Last seen` must come from an actual check**: a log or file modification time, a completion notification, or a status query you ran. Never a guess and never a rounded "just now". If you did not check this turn, write `not checked`, which is honest and useful. Do not invent progress for an agent that has reported nothing.
- **`State` rules:** `running` only if you have evidence it is alive. `stalled` if its last activity is older than about 30 minutes AND you found no fresher file writes; a process existing is NOT evidence of life. `done` when it reported completion. `failed` when it errored or was killed.
- If an agent's result has not arrived yet, say so plainly rather than predicting what it will say. Never fabricate an agent's findings.
- One row per agent. No nesting, no sub-rows, no commentary inside the table; anything that needs explaining goes in the prose above.
