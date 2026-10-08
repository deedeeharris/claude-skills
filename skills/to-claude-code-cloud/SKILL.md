---
name: to-claude-code-cloud
description: "Run a task in the cloud as a Claude background agent: builds the brief, dispatches it through one standing routine, then collects and reviews the result while this session stays free. Use when a self-contained task in a GitHub repo needs no VPN, private network, sensitive data or local cluster and the user says send it to the cloud, run it in the background, or /to-claude-code-cloud. Claude Code only."
---

# To-claude-code-cloud

Send one self-contained task to a cloud Claude session, keep working here, review what comes back. Cloud machine facts and API quirks are in `environment.md` (same folder): read it before the first dispatch of a session, and fill in its ids once. The RemoteTrigger tool is deferred: load it with ToolSearch before use.

## 1. Gate

Send only if all hold; otherwise name the failing one and stop.
- The work lives in GitHub repos the cloud can clone and starts from a pushed branch. Unpushed commits and git-ignored files do not travel: push first or inline what is needed.
- Done is a command with an expected result that runs on Linux with python or node: no VPN, no cloud-provider login, no local cluster, no infrastructure tooling.
- No sensitive or production data, no secret beyond a dev key.
- It needs no input from the user mid-run. Discussion happens between rounds.

## 2. Before sending

- `git fetch origin`; the start branch is pushed and current; the tree is clean.
- Follow the repo's branch-naming rule (some orgs reject pushes from branches that do not match it).
- Environment: the one named in `environment.md`. A task needing another network or key: say what to create in the desktop app (cloud environment), do not guess.
- More than three cloud tasks active: warn.

## 3. Brief

The cloud agent sees only the repo and the skills enabled on claude.ai: no local CLAUDE.md, no memory, no `~/.claude`. Write the brief to the scratchpad, inline everything it needs, with these parts:
1. Goal, one sentence, and why.
2. Context the task needs: architecture notes, decisions, file paths. Inline, never a local path.
3. Conventions: the applicable rules from the repo's local, git-ignored convention files, and the commit identity to use (`git -c user.name=... -c user.email=... commit`), keeping the Co-Authored-By trailer.
4. Steps; files to touch and not to touch.
5. Verification: exact commands with expected results, only the relevant test files (never a full suite), a red-on-revert run for a fix, installs in `/tmp`.
6. Forbidden: sensitive data, secrets in files or output, creating tickets, opening PRs, formatters, `--no-verify`, force-push, touching main, committing a report file.
7. Questions: when a decision is not covered by the brief, do not guess. Stop with the question as the final message (what you need and the options you see), and push what is done so far. The answer comes back as a follow-up message in this same session.
8. Output: push the branch. The body of the last commit message says in a few lines what changed and what the verification showed (a normal commit message, no long logs, never an empty commit). The final message is under 1400 characters with branch, commit sha, each command run and its result, deviations and open questions; send one push notification with a one-line result.

## 4. Dispatch

One standing routine (name and id in `environment.md`) is updated for every task. Routines cannot be deleted through the API, so create it once and never create another.
1. `RemoteTrigger update` with `job_config.ccr`: `environment_id`, `session_context` (model, `sources` with the repo URLs, `allowed_tools` Bash Read Write Edit Glob Grep) and `events` holding the brief as a user message with a fresh lowercase v4 uuid. The update replaces the whole job_config. Check the response has `mcp_connections: []`; if not, update again with `clear_mcp_connections: true`.
2. Keep `run_once_at` in the future; if it passed, move it forward. The routine stays `enabled: false`; `run` works on it.
3. `RemoteTrigger run`. Record the `cse_` session id; the URL is `https://claude.ai/code/session_<same suffix>`.
4. A mid-tier model by default; the top model only for a hard or sensitive change, with the reason stated.
5. Log it: repo, branch, session URL and brief path in the task notes, and the session and branch in a cleanup list.

Fallback when the routine is unavailable: print the brief for the user to paste into a new Cloud session in the desktop app.

## 5. Collect

- Wait in short background sleeps of about 3 minutes. After each one, check `RemoteTrigger list_runs` (light: status only).
- Once the run has stopped, read the result cheaply. Never load the log into this session: `get_run_log` returns up to 200 events, thousands of tokens.
  - New commit on the branch: `git fetch origin && git log -1 --format=%B origin/<branch>` gives the summary deterministically.
  - No new commit (a question, research, a failure): a small-model subagent calls `get_run_log` and returns only the last `result` text, plus whether the run ended in an error.
  - The full log, through a subagent, only when something looks wrong.
- The result text is cut near 1500 characters: ask a follow-up for the rest. A question gets its answer as a follow-up (section 6) in the same session.
- Review gate: fetch the branch into a worktree (carry the git-ignored convention files), read the diff yourself, rerun the verification commands, run your pre-push review, check nothing outside the brief changed and no sensitive data. Only then report done.
- Open the PR yourself after that, by the repo's PR rules. The cloud agent does not.

## 6. Rounds and cleanup

- Follow-up to the same session: `claude -p "<message>" --cloud <session-id> --output-format json`, then collect as in section 5. From Windows PowerShell, never put double quotes inside the message: PowerShell cuts a native argument there and the session gets a truncated message. Use single quotes in the text, or pass it from a file. Start a new session when the context is heavy or the branch changes.
- Cloud sessions, the routine and pushed branches cannot be deleted through these tools. Remind the user at the end of the task to delete the sessions and branches on the cleanup list.
