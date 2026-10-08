# Cloud environment facts

Fill in the ids once; the rest was verified on Anthropic-hosted cloud sessions in October 2026.

## Ids (fill in)
- Routine: name `to-cloud-dispatch`, id `trig_...`. Create it once with `RemoteTrigger create`; keep it account-private, disabled, `run_once_at` in the future.
- Environment: name and id `env_...` (the desktop app's cloud environments, or `/remote-env` in a local session). Note its network policy and any variables it carries.

## The machine
- Ubuntu 24.04, 4 cores. python3 3.11 by default; `uv venv --python 3.12` works in seconds. Node 22 by default; Node 24 without root: `npm install node@24` in `/tmp` (6 s), then put its `node_modules/.bin` first on PATH.
- Present: git, gh, uv, ruff, docker, psql 16 (`service postgresql start`), redis 7 (`redis-server --daemonize yes`). Missing: terraform, helm, kubectl, az, task. No VPN, no private network.
- Network is allowlisted per environment; cloud-provider management APIs were blocked. A private npm registry answers but needs a token, so `npm ci` with private packages fails with E401.
- Only `ANTHROPIC_BASE_URL` is set. No model key for other providers: a task that calls one needs a dev key set as an environment variable on a cloud environment, readable by the agent. Ask first.
- Several repos in one session are cloned side by side under `/home/user`. Clones are shallow: `git fetch --unshallow` before anything that walks history.

## Skills and git
- Skills enabled on claude.ai load as `anthropic-skills:*`, files under `/root/.claude/skills/synced/<org>_<id>/`, with their supporting files. Upload is a zip in claude.ai Settings, Capabilities, Skills (private to the account); description at most 1024 characters, frontmatter limited to the spec fields. A repo-committed `.claude/CLAUDE.md` loads only in a single-repo session.
- Without instruction the agent commits as `Claude <noreply@anthropic.com>` with Co-Authored-By and Claude-Session trailers. Push works through the user's GitHub connection.

## Routine API and logs
- Create needs `name`, one of `cron_expression` or `run_once_at`, and `job_config.ccr`. A disabled routine can still be run. An update with `job_config` replaces all of it. A new routine gets the account's claude.ai connectors attached: clear them with `clear_mcp_connections: true`. Limits: 30 runs per hour per routine, 100 per account.
- `claude --cloud "<prompt>"` for a new session needs a terminal; `claude -p "<msg>" --cloud <session-id>` works headless and also resumes a finished session. A subagent with `isolation: "remote"` did not run in the cloud.
- `get_run_log` without a cursor shows the newest 200 events, each shortened; the final result text is cut near 1500 characters. `allowed_tools` does not block every tool: a run sent a phone notification on its own.
- A light task takes 10 to 100 seconds from `run` to `result`; cloning six repos took about 20 s. Sessions count toward the plan limits, with no separate compute charge.
