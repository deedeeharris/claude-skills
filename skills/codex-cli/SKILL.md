# Codex CLI

Delegate tasks to OpenAI Codex CLI. Codex runs autonomously in yolo mode, can read/write files, run commands, and produce structured output. Saves the final response to a file and optionally streams all events as JSONL.

**Usage:** `/codex <task description> [--save <output-file>] [--review] [--uncommitted] [--base <branch>] [--model <model>] [--sandbox <mode>]`

**Examples:**
- `/codex find the top 5 bugs in this codebase --save docs/codex-bugs.md`
- `/codex refactor backend/app/services/container_manager.py to use async/await`
- `/codex review --uncommitted --save docs/codex-review.md`
- `/codex review --base main --save docs/codex-review.md`
- `/codex write unit tests for all FastAPI routes --save backend/tests/generated_tests.py`
- `/codex create GitHub issues for all bugs you find`
- `/codex explain the Docker networking architecture --save docs/docker-arch.md`

## Instructions

### Step 1 — Parse arguments

Extract from the raw args:
- **task**: the natural-language instruction (everything before `--` flags)
- **`--save <file>`**: path to write Codex's final response (passed as `--output-last-message`)
- **`--review`**: use `codex exec review` subcommand instead of `codex exec`
- **`--uncommitted`**: (review mode only) review staged/unstaged/untracked changes
- **`--base <branch>`**: (review mode only) review diff against a base branch
- **`--model <name>`**: model to use (e.g. `o3`, `o4-mini`, `gpt-4.1`) — defaults to Codex's auto
- **`--sandbox <mode>`**: `read-only`, `workspace-write`, or `danger-full-access` (default: `workspace-write` for tasks, `read-only` for review)
- **`--json`**: if present, also capture all JSONL events to `<save-file>.events.jsonl`

### Step 2 — Gather context automatically

Before running Codex, collect real project context to enrich the prompt:

```bash
# Project structure (top 2 levels, skip noise)
find . -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' 2>/dev/null | head -60

# Recent commits
git log --oneline -10 2>/dev/null

# Uncommitted changes summary
git diff --stat HEAD 2>/dev/null | head -20
```

Use this to embed real paths and recent context into the prompt.

### Step 3 — Build the command

**Standard task (yolo, write mode):**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  "<enriched_prompt>"
```

**With JSON events:**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  --json \
  "<enriched_prompt>" > "<save-file>.events.jsonl"
```

**Review — uncommitted changes:**
```bash
codex exec review \
  --dangerously-bypass-approvals-and-sandbox \
  --uncommitted \
  -o "<save-file>" \
  "<custom review instructions>"
```

**Review — against base branch:**
```bash
codex exec review \
  --dangerously-bypass-approvals-and-sandbox \
  --base <branch> \
  -o "<save-file>" \
  "<custom review instructions>"
```

**With specific model:**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  -o "<save-file>" \
  "<enriched_prompt>"
```

If no `--save` file is given, default to writing output to `codex-output.md` in the project root.

### Step 4 — Build a rich, detailed prompt

For task mode (not `--review`), do NOT pass the raw task verbatim. Construct an enriched prompt:

```
Project: <name from README or git remote>
Root: <absolute path to cwd>
Stack: <language/framework from key files>

Key files:
- <list real file paths from Step 2 that are relevant to the task>

Recent changes:
- <git log summary from Step 2>

Task: <user's task, stated precisely>

Output: Write your findings/results to <save-file>.
If creating GitHub issues: use `gh issue create --title "..." --body "..." --label bug` for each issue.
```

For `--review` mode: pass custom review instructions as the positional prompt argument if the user gave extra guidance (e.g. "focus on security"). Otherwise omit the prompt and let Codex use its default review behavior.

### Step 5 — Run Codex

Run in the **background** by default (Codex tasks take time). Use `run_in_background: true` on the Bash call.

```bash
cd <project root>
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  "<enriched_prompt>"
```

Tell the user: "Codex is running in the background. Output will be saved to `<save-file>`."

If the user explicitly asks to wait (`--wait`), run in the foreground instead and stream output.

### Step 6 — Report result

After Codex completes (background notification) or finishes (foreground):
- Show the path to the saved output file
- If GitHub issues were created, list their URLs if available in the output
- Do not re-summarize Codex's output — just confirm completion and point to the file

## Notes

- `--dangerously-bypass-approvals-and-sandbox` is the yolo equivalent — skips all confirmations
- For read-only tasks (review, analysis), prefer `--sandbox read-only` over full bypass
- `--output-last-message` / `-o` saves only the final natural-language response
- `--json` streams all structured events (tool calls, thinking steps) as JSONL — useful for debugging
- Codex uses OpenAI's API — this consumes OpenAI account credits, not Claude Code tokens
- If Codex is not authenticated, tell the user to run `! codex login`
- `codex exec review` has built-in git-diff awareness — it automatically reads the diff; no need to describe changes
- For large tasks (full codebase review, test generation), always run in background
