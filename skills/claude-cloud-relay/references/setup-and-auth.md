# Recipient setup and private authentication

Every recipient installs the CLI and signs in to their own account. Use the CLI's official installation instructions and run `claude auth login` when a login is needed and requested. Never share an existing login, authorization code, credential file, or token with the skill package. Inspect the CLI's auth status normally; do not inspect secret file contents.

Configure a private profile outside the package. Ask for the user's timezone, preferred scan times, and the conversation where reports should arrive when scheduling is requested. Configure partial title matches and per-session exceptions privately. Default message preview is off. Default repeat alerts are only for changed questions; a reminder interval means how long to wait before reporting the same still-unanswered question again. Default response-check timeout is 120 seconds; expiry means report the current status, not keep polling indefinitely.

## Persist login between cloud environments

On Linux the normal login is stored under the CLI configuration directory in `.credentials.json`, with mode 0600. `CLAUDE_CONFIG_DIR` changes that location. macOS normally uses Keychain. The file can include refreshable credentials; it belongs to the user, not this package.

Preferred options depend on the host:

1. Use the same persistent private runtime/configuration directory when the platform supports it. Do not mount a credential directory shared among unrelated users.
2. On fresh hosts, use the platform's supported encrypted secret-file binding or authorized credential restoration workflow for the normal login, with private permissions. Refresh/rotation must be persisted through that supported mechanism. Do not copy a raw credential into prompts, code, Markdown, or a ZIP.
3. If the platform cannot safely restore and rotate the normal login, require login on that runtime and keep proactive scans inactive. An installed skill alone does not preserve login across fresh environments.

Base64 encoding is not encryption. Do not place encoded auth JSON in an ordinary environment variable, editable configuration file, artifact, or conversation. If a platform explicitly supports encoded secret restoration, use its secret store and supported injection workflow, never print the secret, and validate readiness and refresh behavior on a fresh runtime before depending on it. This package does not provide a credential export script.

## Setup-token is not a proven substitute

`claude setup-token` generates a long-lived subscription token for `CLAUDE_CODE_OAUTH_TOKEN`. Anthropic's current authentication documentation says this token can only make model requests and cannot establish Remote Control sessions or fetch Claude.ai connectors. Do not assume it grants session-list/transcript/message APIs. Use full normal account authentication for relay operations unless an actual supported route is separately verified.

Do not use an API key or a third-party model provider as a substitute for the user's cloud-session account login. Respect organization policy and host network policy. Do not override injected authentication/proxy settings or work around denied routes.

## Onboarding checks

- CLI version/flags and logged-in subscription account are usable.
- A read-only discovery or retrieval succeeds for a user-selected target.
- No secret or unrelated transcript appears in logs or handoff artifacts.
- Luna is available on this host, or a clearly disclosed fallback is chosen.
- Private state survives the intended runtime restart.
- On a fresh runtime, the supported credential restoration works before any schedule is declared ready.

Sources:

- https://code.claude.com/docs/en/authentication#credential-management
- https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- https://code.claude.com/docs/en/claude-code-on-the-web
