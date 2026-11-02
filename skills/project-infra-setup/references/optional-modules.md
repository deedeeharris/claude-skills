# Optional modules (stack-specific)

Read only the sections that match the project. Each one adds to the core workflow in SKILL.md; none of them relaxes a core rule.
Record every choice and its reason in `docs/stack.md`.

## Service selection (only if the workload is not a plain request/response API)

- Request/response APIs and web apps: Cloud Run (the default; the templates assume it).
- Always-on workers, persistent sockets, long-lived socket gateways, stateful daemons: hardened Compute Engine VM (see the next section).
- Static public sites: Firebase Hosting, only if public static exposure is intended.
- Admin-only UIs: server-side auth gate (IAP, Cloud Run IAM). Firebase client login alone does not make HTML/JS private.
- Background jobs: Cloud Scheduler plus Cloud Run jobs, or VM/systemd when the job needs local state.

## GCP network hygiene (only if the project has the default VPC network or runs Compute Engine VMs)

- The default network ships ingress rules for SSH, RDP and ICMP from `0.0.0.0/0`. List first:
  `gcloud compute firewall-rules list --project=<PROJECT_ID> --filter="name~default-allow"`. Show the list to the operator,
  then delete only the confirmed ones. Better: manage firewall rules in Terraform and import or destroy the defaults there.
- Compute Engine: size to the workload, harden before installing app code. Prefer no public IP; if SSH is needed use IAP TCP
  forwarding or tight source ranges. OS Login, no password SSH. systemd or Docker Compose with a restart policy, log rotation,
  disk monitoring, a patch plan. Keep private gateways and daemons on localhost or a private network.
- Write `docs/ops-runbook.md` for every VM or worker.

## Firebase (only if the project uses Firebase Hosting or Firebase Auth)

- Add Firebase to the GCP project; create the web app and Hosting site; enable Google sign-in in the Console when the CLI cannot.
- Authorized domains: Firebase app domain, Hosting domain, localhost for dev. Commit `firebase.json` for SPA rewrites.
- Admin-only UIs: do not treat Hosting as private. Keep Hosting deploy disabled until a server-side gate exists.
- Security headers in `firebase.json`: security baseline item 10 (`references/security-baseline.md`).
- Verification: deploy to Hosting only if intended; check the headers on the live site.

## Google auth (only if the project signs users in with Google)

- Decide the server-side vs client-side boundary. Firebase Auth for sessions/tokens; IAP or Cloud Run IAM when the whole UI
  must be unreachable without Google auth.
- Admin allowlists are enforced server-side by email or stable user ID. Admin identities live in config or IAM, not source.
- 2-Step Verification on every allowlisted and admin account: security baseline item 12.

## Gemini (only if the project calls the Gemini API)

- API keys restricted to `generativelanguage.googleapis.com` unless Vertex AI with ADC is the design.
- The key lives in Secret Manager. Record the key resource ID, never the key string.
- Verification: confirm the API key restriction.

## MongoDB Atlas (only if the project uses MongoDB Atlas)

- Use the Atlas CLI only after `atlas organizations list` works; `atlas auth whoami` alone is not enough. If user auth keeps
  expiring, use API key login locally or a headed shell.
- New Atlas project per app unless told otherwise. M0 for bootstrap if it fits. Create the DB user and network access; store
  the URI straight into Secret Manager. Never print username, password or URI.
- Never allow `0.0.0.0/0` in prod. Use an operator `/32`, a VM static IP, a Cloud NAT egress IP or another approved path.
  Only exception: a knowingly accepted free-tier risk, recorded with compensating controls (security baseline item 2).
- App user is `readWrite` on the app database only, never admin (security baseline items 1 to 4).
- Operator IP without printing secrets. PowerShell: `(Invoke-WebRequest -Uri "https://api.ipify.org").Content`.
  Python (`python3` on macOS/Linux): `python -I -c "import urllib.request; print(urllib.request.urlopen('https://api.ipify.org').read().decode())"`.
- Verify connectivity with a ping that prints nothing secret.
