# Claude Cloud Relay

A shareable assistant skill for reading and messaging Claude Code cloud sessions through a user's own account. Luna workers perform retrieval and delivery; the main assistant gives concise voice-friendly briefings and recommendations.

## Install

Extract the ZIP. Put the `claude-cloud-relay` directory, containing `SKILL.md`, in your assistant's user-level skills directory. Codex commonly uses `~/.agents/skills/claude-cloud-relay`; Claude Code uses `~/.claude/skills/claude-cloud-relay`. Check your host's skill-loading rules, then start a new conversation and ask to use the skill.

The Luna delegation instructions target hosts that expose Luna workers, such as compatible Codex environments. The skill checks official OpenAI sources using the current month and year and selects the newest verified Luna version the host supports. It does not permanently pin a generation. See [model selection](references/model-selection.md). Other hosts must report their available-model fallback. Installing into Claude Code does not make Luna available there.

Then follow [setup and authentication](references/setup-and-auth.md). Each recipient signs in to their own account and creates their own private profile. No credentials, transcripts, personal preferences, or account/session identifiers are in this package.

## Included policy

- Session discovery and selection; exact and summarized reads; exact and formulated sends.
- Luna delegation, bounded parallel reads, private checkpoints, evidence and delivery verification.
- Short briefings, reply recommendations, voice follow-ups, and optional message previews off by default.
- PM scans, waiting-for-user detection, consolidated briefings, deduplication, snoozes, and configurable schedules.
- Optional automatic replies restricted to the user's own standing rules; empty rules mean no automatic replies.
- Cross-session comparison disabled. JSON decision import/export is supported without assuming consent for unanswered decisions.

## Current capability boundaries

The CLI send route and isolated cloud transcript retrieval are supported workflows. The teleport picker may show only 20 items; full enumeration must be verified. Scheduled environment access, credential persistence across fresh hosts, and reading/messaging PC sessions via Remote Control require end-to-end validation on the recipient's setup. The skill includes these checks rather than claiming them complete.

This is an agent skill, not a server or always-running daemon. It does not start schedules, log in, or send messages merely by being installed. Notification destinations and schedules belong to the conversation where the user activates them, not every conversation that happens to load the skill.
