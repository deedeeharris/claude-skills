# Gemini CLI

Delegate tasks to Gemini CLI with full project context. Gemini runs autonomously in yolo mode and can read/write files, run commands, and produce rich output.

**Usage:** `/gemini <task description> [--save <output-file>] [--files <path1,path2,...>] [--dir <directory>] [--model <pro|flash|flash-lite>] [--plan]`

**Examples:**
- `/gemini explain this project in an HTML file and open it`
- `/gemini find the top 5 bugs in this codebase --save bugs-report.md`
- `/gemini refactor backend/app/services/container_manager.py to use async/await --files backend/app/services/container_manager.py`
- `/gemini write unit tests for all routes --dir backend/app/routers --save tests/generated_tests.py`
- `/gemini review the docker-compose.yml and suggest improvements --files docker-compose.yml --plan`

## Instructions

### Step 1 — Parse arguments

Extract from the raw args:
- **task**: everything before any `--` flags — this is the prompt to give Gemini
- **`--save <file>`**: if present, pipe/tee Gemini output to this file path
- **`--files <paths>`**: comma-separated file paths to include as explicit context
- **`--dir <directory>`**: a directory to set as working context (passed via `--include-directories`)
- **`--model <name>`**: model alias — `pro`, `flash`, `flash-lite` (default: omit, use Gemini's auto)
- **`--plan`**: use `--approval-mode=plan` instead of `yolo` (shows plan before executing)

### Step 2 — Gather context automatically

Before running Gemini, gather context to make the prompt maximally useful:

```bash
# Get the current project structure (top 2 levels)
find . -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' 2>/dev/null | head -60

# Get recent git changes for context
git log --oneline -10 2>/dev/null
git diff --stat HEAD 2>/dev/null | head -20
```

Use this to enrich the prompt with actual file paths and project structure.

### Step 3 — Build the Gemini command

**Base command:**
```bash
gemini --approval-mode=yolo -p "<full_prompt>"
```

**With model:**
```bash
gemini --approval-mode=yolo --model=<model> -p "<full_prompt>"
```

**With plan mode (shows plan, asks before executing):**
```bash
gemini --approval-mode=plan -p "<full_prompt>"
```

**With extra directories:**
```bash
gemini --approval-mode=yolo --include-directories=<dir> -p "<full_prompt>"
```

**With output saved to file:**
```bash
gemini --approval-mode=yolo -p "<full_prompt>" | tee <output-file>
```

### Step 4 — Build a rich, detailed prompt

Do NOT just pass the raw user task verbatim. Construct a detailed prompt that includes:

1. **What the project is** — 1-2 sentences from README or git history
2. **The cwd and key file paths** relevant to the task (use real paths from Step 2)
3. **The user's task** — spelled out precisely
4. **Output expectations** — if saving to a file, tell Gemini where to write it
5. **Any files to focus on** — list them explicitly if `--files` was given

**Example enriched prompt construction:**
```
Project: <name from README or git remote>
Root: <absolute path to cwd>
Stack: <language/framework from key files>
Key files: <list real file paths relevant to the task from Step 2>
Recent changes: <git log summary>

Task: <user task here>

[If --save was given]: Write your output/results to <output-file> at the end.
[If --files was given]: Focus especially on these files: <file list with full paths>.
```

### Step 5 — Run Gemini

Run the constructed command using Bash. Gemini is interactive/streaming — run it in the **foreground** so the user sees live output:

```bash
cd <project root>
gemini --approval-mode=yolo [--model=<model>] [--include-directories=<dir>] -p "<enriched_prompt>"
```

If `--save` was specified, pipe to tee:
```bash
gemini --approval-mode=yolo -p "<enriched_prompt>" | tee "<save-path>"
```

### Step 6 — Report result

After Gemini finishes:
- If `--save` was used, confirm the file was written and show its path
- If Gemini produced a file (like an HTML report), mention where it is
- Do not re-summarize Gemini's output unless it was very short

## Notes

- **yolo mode** = Gemini auto-approves all tool use (file reads, writes, shell commands) — no prompts
- **plan mode** = Gemini shows its plan first, then asks before executing — use for risky tasks
- Gemini has its own context window and will read files itself; you don't need to pre-read them
- On Windows paths use forward slashes or quote backslashes: `C:/Users/...` or `"C:\\Users\\..."`
- If Gemini is not authenticated, tell the user to run `! gemini auth login`
- If task is very large or risky, suggest `--plan` flag first
