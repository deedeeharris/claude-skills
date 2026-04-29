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
| `hebrew-rtl` | `/hebrew-rtl` | Apply RTL Hebrew rules when generating any document with Hebrew text — fixes BiDi, punctuation, layout mirroring, comma placement. Use alongside pptx-generator, minimax-docx, minimax-xlsx, or minimax-pdf. |
| `gemini` | `/gemini` | Gemini CLI integration |
| `deep-verify-plan` | `/deep-verify-plan` | Deep Verify Plan — runs iterative plan QA (6-dimension scan → dedup → prove gaps → self-answer → 3-judge review → quality score 95/100) without any coding |
| `plan-gap-finder` | `/plan-gap-finder` | Plan Gap Finder — spawns parallel agents (one per codebase area) to cross-reference a plan file against actual code; outputs a structured gap report: planned-but-missing, implemented-but-not-planned, partial |
| `prd-to-spec` | `/prd-to-spec` | Convert an approved PRD into a phase-gated implementation SPEC with verification ledger, TDD breakpoints, and quality gates. Dispatches to `prd-to-spec.js` process via `/babysitter:call` or `/babysitter:yolo` |
| `task-to-prd` | `/task-to-prd` | Convert a raw task (tracker ticket / email / text) into a fully characterized PRD via Five Whys + interactive clarification + adversarial review. Dispatches to `task-to-prd.js` process via `/babysitter:call` or `/babysitter:yolo` |

Note: the `prd-to-spec` and `task-to-prd` skills are thin user-facing wrappers — they parse inputs, ask the user to pick `/babysitter:call` (interactive) or `/babysitter:yolo` (auto-approve), and dispatch to the matching process below.

### Processes

| Process | Description |
|---------|-------------|
| `bug-hunter.js` | Babysitter process driving the full BH pipeline |
| `deep-plan-verification.js` | Phase 0 plan verifier: 6-dimension parallel gap scan → dedup → prove gaps → self-answer → 3-judge review → consistency gate → quality score (target 95/100) |
| `prd-to-spec.js` | Babysitter process that orchestrates the prd-to-spec skill: discovery (Verification Ledger) → SPEC generation → self-review (+ optional secondary reviewer) → user-approval breakpoint → execution prompt. Stack-agnostic. |
| `task-to-prd.js` | Babysitter process that orchestrates the task-to-prd skill: source-load + Five Whys → interactive clarification → scope-lock breakpoint → PRD draft → 5 parallel verification checks (+ optional secondary review) → per-finding gate → final approval → optional tracker update + follow-up prompt. Stack-agnostic. |

### Scripts

Standalone bash scripts — copy to any git repo root and run directly. No install needed.

| Script | Description |
|--------|-------------|
| `scripts/issue-loop.sh` | Auto-fix GitHub issues in a loop using a 3-session babysitter pipeline: Session 1 writes a spec + runs `/deep-verify-plan` (≥95/100), Session 2 uses `/writing-plans` to produce a TDD task list, Session 3 implements with TDD + `/verification-before-completion` then commits and pushes. Quality gates validate each artifact. Rate limits are detected by multi-pattern regex, sleep until reset (parsed from Claude's output), and retry up to 5×. Rate-limit exhaustion skips the issue without marking it failed. Closes issues on success, labels `needs-review` on session failure. Stops when no open issues remain. Works on any git repo with `gh` + `claude` + `jq` + `python3`. |

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
