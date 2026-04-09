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
| `bh` | `/bh` | Bug Hunter — scan, TDD-fix, conventions gate, code review, DoD gate, commit |
| `bh-forever` | `/bh-forever` | Continuous bug hunting loop until convergence score ≥ 90 |

### Processes
| Process | Description |
|---------|-------------|
| `bug-hunter.js` | Babysitter process driving the full BH pipeline |

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
