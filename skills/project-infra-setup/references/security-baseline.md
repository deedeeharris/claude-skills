# Security baseline (detail)

This file is the security baseline checklist (SKILL.md section 12 points here), with the why, the how and the audit commands.
Items 1 to 4 apply only if the project uses MongoDB Atlas; every other item applies to every project unless its heading says otherwise.
Placeholders: `<PROJECT_ID>`, `<REGION>`, `<SERVICE>`, `<BUCKET>`, `<APP_DB>`. Never write real ids, emails or hosts into the repo docs of the skill.

## What the templates already do
- Runtime SA per service, no default compute SA (`modules/cloud-run-service/main.tf`).
- Per-secret `secretAccessor` for the runtime SA, never project-level.
- State bucket: uniform access, `public_access_prevention = "enforced"`, versioned (`bootstrap/main.tf`).
- App buckets (optional `bucket_names`): same flags, versioning, `objectAdmin` for the runtime SA on its own buckets only (`modules/cloud-run-service/buckets.tf`).
- WIF only, one pool per environment, no JSON keys (`bootstrap/main.tf`).
- Known gap: `tf-applier-<env>` holds project-level `run.admin`, `artifactregistry.admin`, `secretmanager.admin`, `iam.serviceAccountAdmin` and `iam.serviceAccountUser` (`templates/terraform/bootstrap/main.tf`; Terraform must create and bind them). `iam.serviceAccountAdmin` can change IAM on any service account in the project, which is why the applier lives in a per-environment project. It is gated by the `tf-<env>` reviewers and lives in its own project only. Do not copy those roles to any other identity. A hand-made app deploy SA (no Terraform) follows item 6 below instead.

## MongoDB Atlas (only if the project uses MongoDB Atlas; then all four items are mandatory)
1. **Users.** Never an `atlasAdmin` or admin user for the app. Create one app user with `readWrite` on `<APP_DB>` only. Create a separate read-only user (`read` on `<APP_DB>`) for backups and exports. Keep any admin user out of every app secret and out of CI.
2. **Network access.** Never `0.0.0.0/0` for prod. Options, best first:
   - Private endpoint (needs a paid tier, not M0).
   - Fixed egress IP: Cloud Run Direct VPC egress (or Serverless VPC connector) through Cloud NAT with a reserved static IP; add only that IP to the Atlas access list.
   - Free tier (M0) cannot do either. If the operator knowingly accepts `0.0.0.0/0` for cost, record it in `docs/stack.md` as an ACCEPTED RISK with date and exit plan (upgrade tier or add NAT by <date>), and compensate: random password of 32+ chars, the least-privilege user from item 1, alerts from item 3.
3. **Alerts and audit.** Enable Atlas alerts (connections spike, auth failures, replication, disk, new access-list entry, user change). Enable database auditing where the tier allows (M10+). On any suspected leak: rotate the app user password, write a new Secret Manager version, redeploy, disable the old version.
4. **URI storage.** The full URI lives only in Secret Manager. Deploy with secret refs (`<secret>:latest`, or a pinned number in prod), never in env files, tfvars, workflow files or the repo. Never print it.

## GCP
5. **Runtime SA.** Cloud Run runs as its own SA with only: `secretAccessor` per secret it reads, `storage.objectAdmin` (or `objectUser`) on its own bucket, and nothing else it does not need. Never the default compute SA. Never `roles/editor` on any SA or on the compute SA (remove it if present: `gcloud projects remove-iam-policy-binding`, after showing the operator).
6. **CI/CD identity.** Workload Identity Federation, no long-lived JSON SA keys in GitHub secrets. A deploy SA that does not run Terraform gets: `run.admin` on the one service, `artifactregistry.writer` on the one repo, `iam.serviceAccountUser` on the runtime SA only. No `secretAccessor`, no project-wide `storage.admin`.
7. **Secrets.** Per-secret IAM bindings, not project-level `secretAccessor`. Turn on Data Access audit logs for Secret Manager (`DATA_READ`, `DATA_WRITE` on `secretmanager.googleapis.com`) via `google_project_iam_audit_config` in Terraform.
   ```hcl
   resource "google_project_iam_audit_config" "secrets" {
     project = var.project_id
     service = "secretmanager.googleapis.com"
     audit_log_config { log_type = "DATA_READ" }
     audit_log_config { log_type = "DATA_WRITE" }
   }
   ```
8. **Buckets.** Uniform bucket-level access, `public_access_prevention = "enforced"`, signed URLs with a short TTL (minutes, not days) for private media, object versioning for all app data, and a retention policy for audit or compliance data (`retention_policy { retention_period = <seconds> }`, lock it only after the operator agrees: a locked policy cannot be shortened).
9. **Monitoring.** Alert policies (Terraform `google_monitoring_alert_policy`, notification channel to the operator) at least for:
   - 401/403 bursts (log-based metric on `httpRequest.status=401 OR 403`, threshold per minute).
   - 5xx rate on the Cloud Run service (`run.googleapis.com/request_count`, `response_code_class="5xx"`).
   - Writes to admin routes: users, settings, uploads (log-based metric on method POST/PUT/PATCH/DELETE for those paths).
   - A billing budget with threshold alerts (`google_billing_budget`, 50/90/100%).
   Not templated: each app has different routes and metrics. Create them per project and record the policy names in `docs/stack.md`.
10. **Firebase Hosting / admin web** (only if the project serves a web UI from Firebase Hosting or has an admin web UI). Security headers in `firebase.json` under `hosting.headers`, source `**`:
    - `Content-Security-Policy` with `default-src 'self'` and `frame-ancestors 'none'`, plus only the script/connect origins the app needs.
    - `X-Frame-Options: DENY`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
    - `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`
11. **Shared service API keys** (only if the project issues API keys to installed clients, for example a desktop app). One key per install, stored hashed, revocable, with an issue date and last-used time. Write-only scope: the endpoints answer `{ok, id}` and never return stored records. Never the same key on every install. A leaked install key must be revocable alone.
12. **Owner accounts.** 2-Step Verification required on every allowlisted and admin Google account (Workspace: enforce in Admin console; personal: operator turns it on and confirms). Record the check date in `docs/stack.md`.

## Audit an existing project (read-only)
Run with the operator's gcloud login. Output may contain emails and ids: read it, do not paste it into docs.

```
# 5, 6: who holds what. Look for roles/editor, roles/owner, storage.admin, secretAccessor at project level, default compute SA
gcloud projects get-iam-policy <PROJECT_ID> --format=json
# 5: which SA does the service run as (must not be <number>-compute@developer...)
gcloud run services describe <SERVICE> --region=<REGION> --project=<PROJECT_ID> --format="value(spec.template.spec.serviceAccountName)"
# 5: public invoker (allUsers / allAuthenticatedUsers must be absent unless intended)
gcloud run services get-iam-policy <SERVICE> --region=<REGION> --project=<PROJECT_ID>
# 6: JSON keys (user-managed keys must not exist)
gcloud iam service-accounts list --project=<PROJECT_ID> --format="value(email)"
gcloud iam service-accounts keys list --iam-account=<SA_EMAIL> --managed-by=user
# 7: per-secret bindings, one call per secret
gcloud secrets list --project=<PROJECT_ID> --format="value(name)"
gcloud secrets get-iam-policy <SECRET_ID> --project=<PROJECT_ID>
# 7: Data Access audit config for Secret Manager
gcloud projects get-iam-policy <PROJECT_ID> --format="json(auditConfigs)"
# 8: bucket flags (expect "enforced", True for uniform, versioning True)
gcloud storage buckets describe gs://<BUCKET> --format="value(public_access_prevention)"
gcloud storage buckets describe gs://<BUCKET> --format="value(uniform_bucket_level_access)"
gcloud storage buckets describe gs://<BUCKET> --format="value(versioning_enabled)"
gcloud storage buckets get-iam-policy gs://<BUCKET>
# 9: alert policies via REST (expect 401/403, 5xx, admin writes)
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" "https://monitoring.googleapis.com/v3/projects/<PROJECT_ID>/alertPolicies" 
# 9: budget
gcloud billing budgets list --billing-account=<BILLING_ACCOUNT_ID>
# 10: headers on the live site (expect CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy)
curl -sI https://<HOSTING_DOMAIN>/
```

Atlas (only if the project uses MongoDB Atlas; UI, items 1 to 4):
- Security > Database Access (Database Users): no admin user used by the app; app user has `readWrite` on `<APP_DB>` only; a separate read-only user exists.
- Security > Network Access: no `0.0.0.0/0` (or an accepted-risk entry in `docs/stack.md`).
- Project > Alerts: alert settings active. Project > Activity Feed shows recent user and access-list changes.

Items 11 and 12 are app and account checks: read the key issuing code and the key store (one key per install, revocable, write-only endpoints); ask the operator to confirm 2-Step Verification per owner account.

Write findings to `docs/infra-owasp-audit-YYYY-MM-DD.md` (SKILL.md section 11, "OWASP infra audit"). Fix high-risk items first; show the operator before any IAM removal.
