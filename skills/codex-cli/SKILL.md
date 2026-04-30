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
- **`--model <name>`**: model to use — defaults to Codex's auto. See [Supported Models](#supported-models) below for valid IDs. **Never guess or hallucinate a model name** — always use the list below or check the live docs first.
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

### Step 3 — Save prompt to file, then build the command

**CRITICAL: Never pass the prompt as an inline shell argument.** Codex hangs waiting for stdin when the prompt is passed inline on some platforms. Always write the enriched prompt to a file first, then reference it with `--instructions-file`.

**Prompt file location:** `.codex/prompts/<slug>-<timestamp>.md` (create dir if needed, never write to project root).

```bash
mkdir -p .codex/prompts
PROMPT_FILE=".codex/prompts/<slug>-$(date +%Y%m%d-%H%M%S).md"
cat > "$PROMPT_FILE" << 'PROMPT_EOF'
<enriched_prompt>
PROMPT_EOF
```

**Standard task (yolo, write mode):**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  --instructions-file "$PROMPT_FILE"
```

**With JSON events:**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  --json \
  --instructions-file "$PROMPT_FILE" > "<save-file>.events.jsonl"
```

**Review — uncommitted changes:**
```bash
codex exec review \
  --dangerously-bypass-approvals-and-sandbox \
  --uncommitted \
  -o "<save-file>" \
  --instructions-file "$PROMPT_FILE"
```

**Review — against base branch:**
```bash
codex exec review \
  --dangerously-bypass-approvals-and-sandbox \
  --base <branch> \
  -o "<save-file>" \
  --instructions-file "$PROMPT_FILE"
```

**With specific model:**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  -o "<save-file>" \
  --instructions-file "$PROMPT_FILE"
```

**Output file location:** If no `--save` is specified, default to `audits/codex/<slug>-<timestamp>.md`. Never write output to the project root. Create the directory if needed:
```bash
mkdir -p audits/codex
```

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

Always write the prompt to `.codex/prompts/` first (Step 3), then run:

```bash
cd <project root>
mkdir -p .codex/prompts audits/codex
PROMPT_FILE=".codex/prompts/<slug>-$(date +%Y%m%d-%H%M%S).md"
cat > "$PROMPT_FILE" << 'PROMPT_EOF'
<enriched_prompt>
PROMPT_EOF
codex exec --dangerously-bypass-approvals-and-sandbox \
  --sandbox workspace-write \
  -o "<save-file>" \
  --instructions-file "$PROMPT_FILE"
```

Tell the user: "Codex is running in the background. Prompt saved to `.codex/prompts/...`. Output will be saved to `<save-file>`."

If the user explicitly asks to wait (`--wait`), run in the foreground instead and stream output.

### Step 6 — Report result

After Codex completes (background notification) or finishes (foreground):
- Show the path to the saved output file
- If GitHub issues were created, list their URLs if available in the output
- Do not re-summarize Codex's output — just confirm completion and point to the file

## Supported Models

> **Live docs:** https://developers.openai.com/codex/models — check here for the latest list before using a model.
> **NEVER hallucinate a model ID.** If the user asks for a model you're unsure about, look it up first.

Models available as of April 2026 (pass as `-m <id>`):

| Model ID | Description |
|---|---|
| `gpt-5.5` | Newest frontier — complex coding, computer use, research |
| `gpt-5.4` | Flagship — strong reasoning + agentic workflows |
| `gpt-5.4-mini` | Fast/cheap mini variant for responsive tasks and subagents |
| `gpt-5.3-codex` | Industry-leading coding model for complex software engineering |
| `gpt-5.3-codex-spark` | Text-only research preview, near-instant iteration |
| `gpt-5.2` | Previous general-purpose model for coding and agentic tasks |

Default (no `-m`): Codex picks automatically based on task complexity.

Codex also accepts any model from providers supporting the OpenAI Chat Completions or Responses API, via `--provider`.

## Notes

- `--dangerously-bypass-approvals-and-sandbox` is the yolo equivalent — skips all confirmations
- For read-only tasks (review, analysis), prefer `--sandbox read-only` over full bypass
- `--output-last-message` / `-o` saves only the final natural-language response
- `--json` streams all structured events (tool calls, thinking steps) as JSONL — useful for debugging
- Codex uses OpenAI's API — this consumes OpenAI account credits, not Claude Code tokens
- If Codex is not authenticated, tell the user to run `! codex login`
- `codex exec review` has built-in git-diff awareness — it automatically reads the diff; no need to describe changes
- For large tasks (full codebase review, test generation), always run in background
- **Prompt files** go in `.codex/prompts/` — never inline the prompt as a shell argument (causes stdin hang)
- **Output files** go in `audits/codex/` by default — never write to the project root
