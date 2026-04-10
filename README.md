# claude-skills

Personal Claude Code skills, babysitter processes, agents, hooks, and commands.

## Install on a new machine

```bash
git clone git@github.com:deedeeharris/claude-skills.git ~/claude-skills
cd ~/claude-skills && chmod +x install.sh && ./install.sh
```

Symlinks everything into the right locations. `git pull` to update — no re-install needed.

## Structure

| Folder | Symlinked to | What goes here |
|--------|-------------|----------------|
| `skills/` | `~/.claude/skills/` | Claude Code skills (`SKILL.md` per folder) |
| `processes/` | `~/.a5c/processes/` | Babysitter process JS files |
| `agents/` | `~/.a5c/agents/` | Babysitter agent definitions |
| `hooks/` | `~/.claude/hooks/` | Claude Code hook scripts |
| `commands/` | `~/.claude/commands/` | Custom slash commands (`.md` files) |

## Current contents

### Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `babysitter-multi-session` | `/babysitter-multi-session` | Generate a `run-sessions.sh` script to chain multiple babysitter yolo sessions sequentially |
| `bh` | `/bh` | Bug Hunter — scan, TDD-fix, conventions gate, code review, DoD gate, commit |
| `bh-forever` | `/bh-forever` | Continuous bug hunting loop until convergence score ≥ 90 |
| `codex-cli` | `/codex-cli` | Codex CLI integration |
| `gemini` | `/gemini` | Gemini CLI integration |
| `deep-verify-plan` | `/deep-verify-plan` | Deep Verify Plan — runs iterative plan QA (6-dimension scan → dedup → prove gaps → self-answer → 3-judge review → quality score 95/100) without any coding |

### Processes

| Process | Description |
|---------|-------------|
| `bug-hunter.js` | Babysitter process driving the full BH pipeline |
| `deep-plan-verification.js` | Phase 0 plan verifier: 6-dimension parallel gap scan → dedup → prove gaps → self-answer → 3-judge review → consistency gate → quality score (target 95/100) |

### Scripts

Standalone bash scripts — copy to any git repo root and run directly. No install needed.

| Script | Description |
|--------|-------------|
| `scripts/issue-loop.sh` | Auto-fix GitHub issues in a loop: for each open issue, runs a plan+deep-verify babysitter session, sleeps 15 min, then runs a TDD implementation session. Closes issues on success, labels `needs-review` on failure. Stops when no open issues remain. Works on any git repo with `gh` + `claude` + `jq`. |

## Adding something new

**New skill:**
```bash
cp -r ~/.claude/skills/my-skill ~/claude-skills/skills/
cd ~/claude-skills && git add . && git commit -m "add skill: my-skill" && git push
```

**New process:**
```bash
cp ~/.a5c/processes/my-process.js ~/claude-skills/processes/
cd ~/claude-skills && git add . && git commit -m "add process: my-process" && git push
```

**New agent / hook / command:** same pattern — drop into the right folder, commit, push.

On any other machine: `git pull` and it's live instantly via symlinks.
