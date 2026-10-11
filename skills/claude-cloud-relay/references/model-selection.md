# Current Luna model selection

The worker family is Luna; the generation is dynamic. The main assistant continues to reason about the results. Do not permanently pin worker selection to the generation that happened to exist when this skill was written.

## Before delegation

1. Read the actual current date from the host/session clock. Compute the current month and year on every activation; do not copy a date from this package, a previous conversation, or a model's knowledge cutoff.
2. Inspect the host's current supported worker-model identifiers. These establish what can actually be spawned, not what has been publicly announced elsewhere.
3. Search the web for `OpenAI Luna latest model <current month> <current year>`. Restrict sources to official OpenAI domains such as `openai.com` and `developers.openai.com`; verify any subdomain belongs to OpenAI. Also inspect the official model catalog and relevant release notes. Open the supporting official page, rather than trusting an unverified search snippet.
4. Identify the most recent released Luna-family model and its exact documented identifier. Compare release/version evidence; do not choose by a name's numeric substring alone. Current-month search terms provide freshness, but an existing latest model can have been released in an earlier month. An announcement for ChatGPT or the API is not proof of Codex/Work worker availability.
5. Choose the newest officially confirmed Luna version that the host exposes as a supported worker. Use the exact host identifier; an API snapshot ID is not necessarily a valid subagent override. Prefer a host's documented moving Luna alias when it is supported and its behavior is verified.
6. If a newer Luna exists but the host cannot spawn it, retain the newest supported Luna and briefly state the availability limit. If web verification fails, use the host-supported Luna already verified or the last successful supported selection, mark freshness unverified, and do not claim it is the newest. If no Luna is available, disclose the fallback under the worker protocol rather than silently choosing another family.

No extra user approval is needed for a newer verified and supported Luna version: choosing current Luna workers is part of this skill's authorization. A hypothetical future generation is not an instruction to construct an unlisted identifier or bypass host model controls.

## Cache and rechecks

Store discovery results privately outside the shareable skill directory: checked-at time, calendar month/year, official source URLs, latest documented release, exact selected host ID, and the relevant supported-model set. Never put account identifiers or session content in search queries.

A fresh result can be reused within the same conversation for up to 24 hours. Recheck on a new conversation's first activation, a calendar-month change, cache expiry, a host-model-list change, an explicit request for the newest model, or a selected-model availability error. Scheduled scans apply the same policy. This catches a release during the month rather than waiting for the next month.

Only retry a model-selection failure before an operation begins. After an uncertain send or worker failure, reconcile delivery before starting another worker; changing the model must not duplicate a message. Keep existing workers on their selected model through the operation, then use the refreshed selection for subsequent work.

## Official lookup entry points

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/changelog
- https://openai.com/news/

These URLs are lookup entry points, not claims that a particular future generation is available. The current generation and evidence belong in the private runtime cache, not the portable policy.
