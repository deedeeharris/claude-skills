---
name: codex-cli
description: Use when delegating coding, review, analysis, testing, or repo-maintenance work to OpenAI Codex CLI from Claude Code or another agent, especially when the user asks to run codex, get a Codex review, use codex exec, save Codex output, stream JSON events, or run autonomous codebase work in a local repository.
---

# Codex CLI

Delegate work to OpenAI Codex CLI. Codex runs in a separate local process, can inspect or edit files according to its sandbox mode, can run commands, and can save its final response to a file.

Use this skill for slash-style requests such as:

```text
/codex find the top 5 bugs in this codebase --save docs/codex-bugs.md
/codex review --uncommitted --save audits/codex-review.md
/codex review --base main --save audits/codex-review.md
/codex write unit tests for all FastAPI routes --save backend/tests/generated_tests.py
```

## Current CLI Contract

Verified against `codex-cli 0.130.0`:

- `codex exec` reads instructions from stdin when no prompt is provided or when the prompt argument is `-`.
- If stdin is piped and a prompt argument is also provided, Codex appends stdin as a `<stdin>` block; avoid that mixed mode for this skill.
- `codex exec review` reads custom review instructions from stdin only when the prompt argument is `-`.
- `--instructions-file` is not a supported flag in `codex-cli 0.130.0`.
- `-o` is short for `--output-last-message <FILE>`.
- `--json` streams events to stdout as JSONL.
- Sandbox modes are `read-only`, `workspace-write`, and `danger-full-access`.
- `--dangerously-bypass-approvals-and-sandbox` skips confirmations and sandboxing. Use it only when the user explicitly wants yolo behavior or the surrounding runner is already sandboxed.

Before relying on a newly installed Codex version, verify flags with:

```bash
codex --version
codex exec --help
codex exec review --help
```

## Parse Arguments

Extract from the raw request:

- `task`: natural-language instruction before flags.
- `--save <file>`: final response output path. Pass it to `-o`.
- `--review`: use `codex exec review`.
- `--uncommitted`: review staged, unstaged, and untracked changes.
- `--base <branch>`: review diff against a base branch.
- `--model <name>`: pass through as `-m <model>`. Never invent model names.
- `--sandbox <mode>`: pass through to `codex exec` for task mode.
- `--json`: also capture JSONL events to `<save-file>.events.jsonl`.
- `--yolo`: use `--dangerously-bypass-approvals-and-sandbox`.

Defaults:

- Save path: `audits/codex/<slug>-<timestamp>.md`.
- Task sandbox: `workspace-write`.
- Review mode: do not use yolo unless the user explicitly asks.
- Prompt path: `.codex/prompts/<slug>-<timestamp>.md`.

## Gather Context

Before running Codex, collect a small amount of real repo context and put it into the prompt:

```bash
git rev-parse --show-toplevel 2>/dev/null
git status --short 2>/dev/null
git log --oneline -10 2>/dev/null
find . -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' 2>/dev/null | head -80
```

On PowerShell, use equivalent native commands:

```powershell
git rev-parse --show-toplevel 2>$null
git status --short 2>$null
git log --oneline -10 2>$null
Get-ChildItem -Force -Depth 2 | Where-Object {
  $_.FullName -notmatch '\\.git|node_modules|__pycache__|\\.venv'
} | Select-Object -First 80 FullName
```

## Write Prompt File

Never pass a long prompt as an inline shell argument. Write the enriched prompt to `.codex/prompts/` and feed it to stdin.

PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path ".codex/prompts","audits/codex" | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$PROMPT_FILE = ".codex/prompts/<slug>-$ts.md"
@'
Project: <project name>
Root: <absolute path from `git rev-parse --show-toplevel` or current working directory>
Stack: <detected stack>

Key files:
- <paths>

Recent context:
- <git status/log summary>

Task:
<precise task>

Output:
Write the final result to <save-file>.
'@ | Set-Content -LiteralPath $PROMPT_FILE -Encoding utf8
```

Bash:

```bash
mkdir -p .codex/prompts audits/codex
PROMPT_FILE=".codex/prompts/<slug>-$(date +%Y%m%d-%H%M%S).md"
cat > "$PROMPT_FILE" << 'PROMPT_EOF'
Project: <project name>
Root: <absolute path from `git rev-parse --show-toplevel` or current working directory>
Stack: <detected stack>

Key files:
- <paths>

Recent context:
- <git status/log summary>

Task:
<precise task>

Output:
Write the final result to <save-file>.
PROMPT_EOF
```

## Run Task Mode

PowerShell, normal sandboxed task:

```powershell
Get-Content -Raw -LiteralPath $PROMPT_FILE | codex exec `
  --sandbox workspace-write `
  -o "<save-file>" `
  -
```

Bash, normal sandboxed task:

```bash
cat "$PROMPT_FILE" | codex exec \
  --sandbox workspace-write \
  -o "<save-file>" \
  -
```

PowerShell, yolo task:

```powershell
Get-Content -Raw -LiteralPath $PROMPT_FILE | codex exec `
  --dangerously-bypass-approvals-and-sandbox `
  -o "<save-file>" `
  -
```

Bash, yolo task:

```bash
cat "$PROMPT_FILE" | codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  -o "<save-file>" \
  -
```

PowerShell with JSON events:

```powershell
Get-Content -Raw -LiteralPath $PROMPT_FILE | codex exec `
  --sandbox workspace-write `
  -o "<save-file>" `
  --json `
  - > "<save-file>.events.jsonl"
```

Bash with JSON events:

```bash
cat "$PROMPT_FILE" | codex exec \
  --sandbox workspace-write \
  -o "<save-file>" \
  --json \
  - > "<save-file>.events.jsonl"
```

`-o <save-file>` captures only the final natural-language response and is not affected by redirecting stdout. `--json` writes structured event logs to stdout, so redirect stdout to the `.events.jsonl` file when JSON capture is requested.

With a specific model:

```bash
cat "$PROMPT_FILE" | codex exec \
  --sandbox workspace-write \
  -m <model> \
  -o "<save-file>" \
  -
```

## Run Review Mode

PowerShell, uncommitted review with default Codex review behavior:

```powershell
codex exec review `
  --uncommitted `
  -o "<save-file>"
```

Bash, uncommitted review with default Codex review behavior:

```bash
codex exec review \
  --uncommitted \
  -o "<save-file>"
```

PowerShell, uncommitted review with custom instructions:

```powershell
Get-Content -Raw -LiteralPath $PROMPT_FILE | codex exec review `
  --uncommitted `
  -o "<save-file>" `
  -
```

Bash, uncommitted review with custom instructions:

```bash
cat "$PROMPT_FILE" | codex exec review \
  --uncommitted \
  -o "<save-file>" \
  -
```

PowerShell, review against a base branch:

```powershell
codex exec review `
  --base <branch> `
  -o "<save-file>"
```

Bash, review against a base branch:

```bash
codex exec review \
  --base <branch> \
  -o "<save-file>"
```

PowerShell, review against a base branch with custom instructions:

```powershell
Get-Content -Raw -LiteralPath $PROMPT_FILE | codex exec review `
  --base <branch> `
  -o "<save-file>" `
  -
```

Bash, review against a base branch with custom instructions:

```bash
cat "$PROMPT_FILE" | codex exec review \
  --base <branch> \
  -o "<save-file>" \
  -
```

Use `--dangerously-bypass-approvals-and-sandbox` in review mode only when the user explicitly requests yolo review behavior.

## Background Execution

Codex work often takes time. Run in the background unless the user explicitly asks you to wait. Codex CLI has no wait flag; waiting is a behavior of the agent running this skill, not a CLI option.

Tell the user:

```text
Codex is running in the background. Prompt saved to .codex/prompts/<file>. Output will be saved to <save-file>.
```

When Codex finishes, report the saved output path. Do not re-summarize Codex output unless the user asks.

## Supported Models

Do not maintain a hard-coded model table in this skill. Model availability changes by Codex version, sign-in method, plan, provider, and date. When the user asks for a specific model, verify it before passing `-m`.

Use the local model catalog first:

```bash
codex debug models
```

`codex debug models` may refresh the model catalog and can require authentication or network access. Use `codex debug models --bundled` when you only need the model catalog bundled with the installed binary.

Then check official OpenAI Codex docs when network access is available. If the requested model is still uncertain, ask the user before running Codex with `-m`.

## Safety And Output Rules

- Prompt files go in `.codex/prompts/`.
- Default output files go in `audits/codex/`.
- Never write prompt or output files to the repo root.
- Prefer `--sandbox read-only` or review mode for audit-only work.
- Prefer `--sandbox workspace-write` for normal implementation work.
- Use `--dangerously-bypass-approvals-and-sandbox` only for explicitly approved yolo runs.
- If Codex is not authenticated, tell the user to run `codex login`.
- If the CLI rejects a flag, run `codex exec --help` and adjust to the installed version.
- Codex uses OpenAI account credits, not Claude Code tokens.
