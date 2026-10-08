# mm local overlay (example)

Copy this file to `mm.local.md` beside `SKILL.md` and fill in your own values. `mm.local.md` is gitignored and never published. The overlay fills values only; it cannot change the invariants, the approval table, the hard-stop list or the loop contract.

```yaml
# Interpreter that runs the mm scripts. Leave empty to use python3.
python: <absolute path to a Python 3.10+ interpreter>

# Your display name, used in approved_by and in human:<name> evidence.
operator_name: <your name>

# Regex that task folder names or branch names match, for example [A-Z]+-[0-9]+ or kebab-case slugs.
task_id_pattern: <regex>

# Repositories that hold a .private/pm/ folder, one per line.
pm_roots:
  - <absolute repo path>

# Display names of your projects, keyed by repo folder name.
projects:
  <repo folder>: <display name>

# Absolute executables and folders the PM passes to the scripts as arguments.
paths:
  codex: <absolute path to codex, or empty for PATH>
  agy: <absolute path to agy, or empty for PATH>
  memory: <folder that promoted insights are written to>

# Model picks per role.
models:
  builder: <model id>
  reviewer: <model id>
  judge: <model id>

# Background launch prefix. Empty means the core default /babysitter:yolo.
launch_override: <empty or a launch prefix>

# on or off. Every mm.py write auto-commits the task's own PM paths (never pushes) unless this is off.
auto_commit: on

# Optional: how tick reports and loop stops reach you, for example the tg skill. Empty means chat and ledger only.
notifier: <empty or a skill name>

# Optional: ntfy topic for the wait ping (hooks/notify_wait.py), sent when the PM waits on you. A secret; empty means no ping.
ntfy_topic: <empty or a topic name>

# Chat language, week start day, time zone and console code page.
locale:
  language: <language>
  week_start: <day>
  time_zone: <IANA zone>
  code_page: <code page or empty>
```
