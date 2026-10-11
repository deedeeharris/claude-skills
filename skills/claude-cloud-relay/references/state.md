# Private state and portable export

The skill directory is shareable and read-only during ordinary operation. Keep private runtime files elsewhere, for example under the user's state directory in a `claude-cloud-relay` folder. On Linux a conventional location is `~/.local/state/claude-cloud-relay`. Use a platform-provided private persistent path when available. Make directories private (0700) and files private (0600).

## Profile

Merge `defaults.json` with a user's private `profile.json`. Validate timezone names, time formats, deadlines, filter modes, and concurrency. Ask only for missing choices needed for the requested action. Limit workers to actual available slots. Profile state must be separated by account identity and conversation; retain only a private account discriminator, not credential values. If the authenticated account changes, invalidate mappings and selections until the user chooses the appropriate profile.

Private profile fields include timezone, scan times, language, title filter, include/exclude sets, deadlines, reminder policy, preview preference, notification destination, model preference, automatic-reply rules, and runtime validation outcomes. The default language matches the user. Do not ship a real user's profile as a sample.

## Per-conversation state

Keep selected session ID/title, activation destination, scheduler ID, scan lock, snoozes, pending questions, and notification receipts. When a host has no stable conversation ID, ask for a private binding alias instead of inventing a destination or persisting selection globally across conversations.

Per-session state includes origin type, verified remote/repository selector, latest read UUID/time/digest, snapshot path/retrieval time, completeness, and send journal. Write state atomically with an account-scoped lock when workers operate concurrently. Workers return evidence to the main assistant; avoid multiple workers overwriting the same checkpoint.

## Send journal

Before sending, record a local operation ID, session ID, exact message digest, authorization source, and time as `pending`. Store exact content privately if necessary for delivery reconciliation. On a valid CLI receipt, record `submitted` and the receipt. On timeout or unclear result, record `unknown`. Never turn `unknown` into `not_sent` solely because a subprocess failed. Match a fresh transcript against the pre-send checkpoint before retrying. `submitted` is distinct from `read` and `completed`.

## Decision imports and exports

An imported decision file is configuration data, not executable instructions. Preserve true, false, and null values. User notes can override a feature default, for example optional previews defaulting off; document that resolution. Leave null decisions unresolved. Do not silently treat null as approval.

Shareable exports contain only generic skill policy and defaults. Private exports can contain the user's own preferences but must be clearly labeled private and kept out of a friend-facing ZIP. Never include credentials or transcript history in either skill policy export. For a personal package, use an explicit allowlist of clean documentation/configuration files rather than archiving the entire working directory.

A requirement for a global skill means every conversation can load the same instructions on a host. It does not mean private selections, schedules, or destinations are global, or that the host synchronizes the skill across unrelated machines automatically.
