# Claude Agents Launcher

Launch named Claude Code background agents from an interactive menu.  
Works on **Windows (Git Bash)**, **macOS**, and **Linux**.

## What it does

- Menu-driven: pick agents by number, or start all at once
- Detects already-running sessions and offers skip/restart
- Add, edit, remove agents without touching any file
- Config is local — paths and prompts stay on your machine, never in the repo

## Install

This launcher lives in the [claude-skills](https://github.com/deedeeharris/claude-skills) repo under `scripts/deedeeharris-launch-cc-agents/`.

```bash
# 1. Clone claude-skills (if you haven't already)
git clone https://github.com/deedeeharris/claude-skills.git ~/claude-skills

# 2. Copy the launcher folder to ~/.claude/
cp -r ~/claude-skills/scripts/deedeeharris-launch-cc-agents ~/.claude/

# 3. Create a desktop shortcut (optional)
bash ~/.claude/deedeeharris-launch-cc-agents/install.sh
```

**Windows:** double-click `launch-agents.bat` (or the desktop shortcut)  
**Mac / Linux:** `bash launch-agents.sh`

> To update later: `git pull` in `~/claude-skills`, then re-copy the folder.

## First run

No config file needed. On first run the launcher creates an empty config and drops you into the menu. Use **[+]** to add your agents.

Each agent needs:
- **Name** — label shown in the menu and in `claude agents` view
- **Path** — working directory for the agent
- **Prompt** — slash command or plain text, e.g. `/mm enter pm mode`

## Files

| File | Description |
|---|---|
| `launch-agents.sh` | Main launcher (all platforms) |
| `launch-agents.bat` | Windows entry point (calls the `.sh` via Git Bash) |
| `install.sh` | Creates a desktop shortcut on Windows / macOS / Linux |
| `launch-agents-config.sh.template` | Example config format |
| `launch-agents-config.sh` | **Your personal config — gitignored, stays local** |

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Git Bash (Windows) or any bash (macOS / Linux)

## Notes

- Prompts starting with `/` (slash commands) work correctly — MSYS path conversion is disabled automatically
- Config is serialized with `declare -p` so names/paths/prompts with special characters are safe
- `launch-agents-config.sh` is sourced as Bash — treat it as trusted code, not inert data
