# Day 0 repo bootstrap (GitHub: repo, branches, rulesets, CI/CD, environments)

Do this before any Terraform. Order matters: the CI job names must exist before the ruleset requires them, and the
Environments must exist before the Terraform bootstrap outputs can be stored as their variables.
Templates live in `templates/github/`. Everything below is also what `bootstrap-repo.ps1` automates.
Rules: no secrets in any file or command here (variables hold IDs only), `gh` is the only GitHub client.
Commands are written for PowerShell (Windows PowerShell 5.1 or PowerShell 7+, `pwsh`); Python examples use `python -I`
(`python3 -I` on macOS/Linux).

## 0. Plan and visibility check (first, it decides what is possible)

```powershell
gh auth status
gh api user --jq .plan                                           # EMPTY for personal accounts (verified 2026-10-14): never rely on it
gh api orgs/<org> --jq '{plan: .plan.name}'                      # org plan (needs org admin): free | team | enterprise
gh api repos/<owner>/<repo> --jq '{private: .private, visibility: .visibility, admin: .permissions.admin}'   # after the repo exists
```

The plan is therefore a REQUIRED config value (`Plan = 'free|pro|team|enterprise'`), read by the operator from
github.com > Settings > Billing and plans. `bootstrap-repo.ps1` never assumes one: empty Plan stops a dry run, and
`-Apply` tries organizations only and stops if that is empty too.

Availability per feature x visibility x plan. The **Private, Free** column was MEASURED live on 2026-10-15 against a throwaway
private repo on a Free account (`gh api` calls, GitHub's exact answer quoted); the Pro/Team/Enterprise columns come from GitHub Docs
(About rulesets; Managing environments for deployment) and were NOT measured.

| Feature | Public repo (any plan) | Private, Free (measured) | Private, Pro or Team (docs) | Private, Enterprise (docs) |
|---|---|---|---|---|
| Repository rulesets (branch + tag), legacy branch protection | yes | **NO** `GET/POST /rulesets` and `PUT /branches/main/protection`: 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." | yes | yes |
| Environments, Environment variables, OIDC subject `environment:<name>` | yes | **yes** (bare `PUT /environments/<n>` 200; `gh variable set --env` works) | yes | yes |
| Environment deployment-branch policy (`main` only) | yes | **yes, and enforced**: `PUT` with `custom_branch_policies` 200, policy POST 201; a job from another branch on that Environment failed with "Branch ... is not allowed to deploy to tf-prod due to environment protection rules." | yes | yes |
| Environment required reviewers, wait timer (the human gate) | yes | **NO** any body containing `reviewers` or `wait_timer`, even `{"wait_timer":0}` or `{"reviewers":[]}`: 422 "Failed to create the environment protection rule. Please ensure the billing plan supports the required reviewers protection rule." (the 422 STILL creates an empty Environment) | NO | yes |
| Secret scanning + push protection | yes | **NO** `PATCH security_and_analysis`: 422 "Secret scanning is not available for this repository." | paid add-on | paid add-on |
| CodeQL default setup | yes | **NO** 403 "Code scanning is not enabled for this repository. Please enable code scanning in the repository settings." | paid add-on | paid add-on |
| `allow_auto_merge` | yes | **NO, silently**: `PATCH` answers 200 but the value stays `false` | yes (with rulesets) | yes |
| Private vulnerability reporting | yes | n/a: `PUT` 404 (public repos only) | n/a | n/a |
| Dependabot alerts and security updates, Actions permissions, repo settings, repo variables, CODEOWNERS file, PR template | yes | **yes** (204 / 200) | yes | yes |

The script refuses BEFORE any write (exit 2) when the config asks for something the row above says is missing:
rulesets on a private repo that is not Pro/Team/Enterprise; `Reviewers = $true` on any private repo that is not Enterprise.
A private repo on Pro/Team can use rulesets, but with `Reviewers = $false` everywhere, which means NO approval
gate for Terraform apply or prod deploy and breaks Principle 2: the script then warns loudly and the operator records
the decision. Options to offer: (a) make the repo public (only if nothing sensitive is in it, never for a repo that will
hold client data), (b) Enterprise, (c) accept no approval gate for the Environments marked `Reviewers = $false`, (d) stop,
(e) degraded mode below. Record the decision and date in `docs/stack.md`. Dry-run it first: change `Plan` and `Visibility`
in the config and read the refusal text.

### Degraded mode: private repo on a Free account (opt-in)

Without it the operator could never use this skill on a private project. Set `AcceptDegraded = $true` in the config
(default `$false` = the refusal above, unchanged). The script then applies everything the table allows and SKIPS the rest:

| Applied | Skipped (reported under NOT ENFORCED, with GitHub's own error text) |
|---|---|
| repo, default branch, squash-only settings (no `allow_auto_merge`), Actions permissions, Dependabot alerts + security updates, Environments with their variables and the `main`-only branch policy (no reviewers, no wait timer), repo variables | rulesets (`main` and `v*` tags), Environment required reviewers, secret scanning + push protection, CodeQL default setup, auto-merge |

Plain meaning of NOT ENFORCED, printed by the script at the start and the end of every degraded run:
- **Nothing stops a direct push, force-push or delete of `main`**, or moving a `v*` tag. No PR is required.
- **CI still runs on PRs but does not gate the merge.** Measured: a PR with a failing `pr-title` check showed `mergeStateStatus: UNSTABLE`, `mergeable: MERGEABLE`, i.e. it can be merged.
- **No human approval gate** on `tf-prod`/`tf-dev`: the `main`-only branch policy still works, but `main` itself is unprotected, so whoever can push to `main` can reach the apply. The skill's Principle 2 does NOT hold in this mode.
- GitHub does not scan for secrets or run CodeQL; the CI `secret-scan` job (gitleaks) is the only scanner.

Two ways out (recommend one, do not stay degraded by default):
1. **Make the repo public** (only if nothing sensitive is in it): rulesets, Environment reviewers, secret scanning, CodeQL and auto-merge all become available free. Set `Visibility = 'public'` and re-run `-Apply` (visibility of an existing repo is changed by the operator in GitHub, the script never does it).
2. **GitHub Pro for the account**: turns rulesets and auto-merge on for private repos (docs, not measured). It does NOT give Environment required reviewers on a private repo (Enterprise only), and secret scanning / CodeQL are paid add-ons. So Pro closes the merge gate, not the approval gate.

What the operator must accept to stay degraded: no merge gate, no approval gate, no GitHub secret scanning. Compensate by hand:
review every diff yourself before pushing to `main`, push only through PRs by discipline, run `terraform apply` locally from a
reviewed plan until a real gate exists, and do not treat green CI as permission to merge. **Record the acceptance, the date and the
exit plan in `docs/stack.md`** (SKILL.md section 2, step 7 "Record"). Gates G1, G3 and G7 (section 10) cannot be proven
red in this mode because no ruleset exists: write `G1/G3/G7: NOT ENFORCED (degraded, <date>)` there, never "proven".

Idempotency is the same as the normal path: a second `-Apply` leaves the state identical (measured live on the Free-plan test repo).

Sources: environments availability in GitHub Docs "Managing environments for deployment" (required reviewers on private repos need Enterprise); rulesets availability in GitHub Docs "About rulesets"; Free-private column measured live 2026-10-15.

## 1. Create the repo

```powershell
gh repo create <owner>/<repo> --private --add-readme --description "<one line>"     # private by default
```

`gh repo create` makes the initial branch from the OWNER's account setting (often `master`). The script reads the real
default branch and renames it (`POST /repos/{o}/{r}/branches/{current}/rename`, `new_name`) to the configured one BEFORE
any setting, ruleset or branch policy; if that fails it stops. It does not PATCH `default_branch`.

Repo settings (REST `PATCH /repos/{owner}/{repo}`; field names verified against the REST docs 2026-10):

| Setting | Value | Why |
|---|---|---|
| `allow_squash_merge` / `allow_merge_commit` / `allow_rebase_merge` | true / false / false | linear history, one commit per PR |
| `squash_merge_commit_title` / `squash_merge_commit_message` | `PR_TITLE` / `PR_BODY` | the Conventional Commit PR title becomes the commit (release-please reads it) |
| `delete_branch_on_merge` | true | no stale branches |
| `allow_update_branch` | true | "Update branch" button, needed with strict required checks |
| `allow_auto_merge` | true | `gh pr merge --auto --squash` once checks pass |
| `has_wiki`, `has_projects` | false | docs live in `docs/`; turn on only if asked |

Also `PUT /repos/{o}/{r}/actions/permissions/workflow` with `default_workflow_permissions=read` and
`can_approve_pull_request_reviews=true` (release-please needs Actions to open PRs; the doc flags the second one as a
security trade-off, so it is scoped to what release-please needs and every workflow still declares its own `permissions:`).

Check: `gh api repos/<o>/<r> --jq '{b: .default_branch, s: .allow_squash_merge, m: .allow_merge_commit, r: .allow_rebase_merge, d: .delete_branch_on_merge, u: .allow_update_branch}'` returns `main,true,false,false,true,true`.

## 2. Branch model and naming

- Trunk-based. `main` is the only long-lived branch. Same commit goes dev, then prod (SKILL.md section 7, "Branching and environments").
- Short-lived branches, merged within days, named `<type>/<kebab-slug>`: `feat/`, `fix/`, `chore/`, `docs/`.
  Branches some AI coding tools create, e.g. `claude/`, are allowed under the same rules and still need a PR.
- Local work: a fresh clone, or a git worktree placed outside the main checkout (never nested inside it), e.g.
  `git worktree add ../<repo>-feat-login -b feat/login origin/main`.
- PR title = Conventional Commit: `feat: add login`, `fix(api): handle empty body`, `chore(deps): bump x`,
  `docs: ...`; breaking change with `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer. Enforced by `pr-title.yml`.
- Branch-name enforcement is not worth a ruleset (`branch_name_pattern` exists; add only if agents keep inventing names).

## 3. Rulesets (not legacy branch protection)

Use the repository rulesets API (`POST /repos/{o}/{r}/rulesets`, update with `PUT /repos/{o}/{r}/rulesets/{id}`).
Legacy branch protection is not used: rulesets layer, can be tested in `evaluate` mode, and cover tags.

`ruleset-main.json` (target `branch`, `~DEFAULT_BRANCH`, enforcement `active`):

| Rule type | Parameters | Purpose |
|---|---|---|
| `pull_request` | `required_approving_review_count` 1 (0 for solo), `dismiss_stale_reviews_on_push` true, `required_review_thread_resolution` true, `require_code_owner_review` false, `require_last_push_approval` false, `allowed_merge_methods` ["squash"] | PR required, no stale approvals, conversations resolved |
| `required_status_checks` | `strict_required_status_checks_policy` true, `context` = CI job names | gate |
| `required_linear_history` | none | no merge commits |
| `non_fast_forward` | none | block force-push |
| `deletion` | none | block branch delete |
| `required_signatures` | none | OPTIONAL, add only if the operator has signing set up (`RequireSignedCommits = $true`) |

Solo-operator variant (default in the example config, `Solo = $true`): `required_approving_review_count = 0`.
Reason: GitHub does not let an author approve their own PR, so 1 required approval would lock a one-person repo.
What stays enforced: PR required, all checks green, up to date with main, threads resolved, linear history, no force-push.
What is lost: a second pair of human eyes. Say this plainly in `docs/stack.md`. Switch to 1 approval when a second human
or a reviewing agent identity with its own GitHub account exists. `bypass_actors` is empty by default: nobody, admins
included, can push to `main`. `AdminBypass = $true` adds repo role admin with `bypass_mode: pull_request` (admin can
override only inside a PR, never by direct push).

Required status check names: the `context` is the JOB name (the job's `name:` if set, else its id), not the workflow
name. They must match EXACTLY or the PR waits forever on a check that never reports. Rules:
- No `matrix` on a required job (name becomes `job (value)`, never the bare job name). `verify-required-checks.py` expands simple matrices and FAILS a required bare name that only a matrix job produces.
- No workflow-level `paths:` filter on a workflow whose job is required (it would not run, the check never reports).
  Terraform Plan is path-filtered and matrix-based (`plan (dev)`), so it is deliberately NOT in the day-0 ruleset.
  When Terraform lands, add a tiny always-run gate job (or drop the path filter) and then require it.
- Prove the match with `templates/github/verify-required-checks.py` (see section 11).

`ruleset-tags.json` (target `tag`, include `refs/tags/v*`): rules `deletion`, `update` and `non_fast_forward`. `update` is
needed because moving a tag to a DESCENDANT commit is a fast-forward, which `non_fast_forward` alone allows. Creation is
left open so release-please can create `vX.Y.Z`; published versions can never be moved or deleted.

Idempotency: the script lists `/rulesets` (every page: `--paginate`, `per_page=100`), matches by `name`, then PUTs the existing id or POSTs a new one.
Roll-out tip: set `enforcement` to `evaluate` first on an existing repo, read "Rule Insights", then flip to `active`.

## 4. Repo files

Copy into the repo root through the first PR (`chore/bootstrap`, section 9). No direct push to `main`, ever:

| File | Source | Notes |
|---|---|---|
| `.github/CODEOWNERS` | `templates/github/CODEOWNERS` | replace `@OWNER`; infra and `.github/` owned explicitly |
| `.github/pull_request_template.md` | template | what / why / how verified / risk |
| `.github/dependabot.yml` | template | Day 0: github-actions only (an ecosystem whose directory does not exist yet is a Dependabot config error); uncomment the stack ecosystem at the scaffold step and terraform at the Terraform step; weekly, grouped |
| `.github/workflows/{ci,pr-title,release-please}.yml` | template | see sections 7 and 8 |
| `release-please-config.json`, `.release-please-manifest.json` | template | repo root |
| `SECURITY.md` | below | how to report, enables the Security tab policy |
| `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `config.yml` | below | |
| `.gitattributes`, `.editorconfig`, `.nvmrc` (Node) | below | |

`.gitattributes`:
```
* text=auto eol=lf
*.ps1 text eol=crlf
*.png binary
*.jpg binary
*.pdf binary
```

`.editorconfig`:
```
root = true
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2
[*.{py,tf}]
indent_size = 4
[Makefile]
indent_style = tab
```
(Terraform fmt uses 2 spaces; if the repo uses `terraform fmt`, drop `tf` from the 4-space line.)

`SECURITY.md`:
```
# Security policy
Report vulnerabilities privately via GitHub: Security tab > "Report a vulnerability". Do not open a public issue.
Expect an acknowledgement within 3 working days. Supported version: latest release on main.
```

`.github/ISSUE_TEMPLATE/config.yml`: `blank_issues_enabled: false`. `bug.yml` and `feature.yml` are GitHub issue forms
(`name`, `description`, `body:` with `textarea` fields: what happened / expected / how to reproduce; problem / proposal).
Keep them to 3 fields so they actually get filled in.

## 5. Security switches

| Switch | Call | Plan |
|---|---|---|
| Secret scanning + push protection | `PATCH /repos/{o}/{r}` body `security_and_analysis.secret_scanning.status` and `.secret_scanning_push_protection.status` = `enabled` | public free; private needs the paid secret-protection product (Free private measured: 422 "Secret scanning is not available for this repository.") |
| Dependabot alerts | `PUT /repos/{o}/{r}/vulnerability-alerts` (204) | all |
| Dependabot security updates | `PUT /repos/{o}/{r}/automated-security-fixes` (204). Not a field of the PATCH body | all |
| Private vulnerability reporting | `PUT /repos/{o}/{r}/private-vulnerability-reporting` (204) | PUBLIC repos only; the script skips it on private repos (not applicable) |
| CodeQL default setup | `PATCH /repos/{o}/{r}/code-scanning/default-setup` body `{state: "configured", query_suite: "default", languages: [...]}`; languages from `actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift` | public free; private needs code security (Free private measured: 403 "Code scanning is not enabled for this repository.") |

The script runs each as its own step: one 403/422 (plan limit) does not abort the rest, and the summary table lists the failed ones. With `AcceptDegraded = $true` a rejected secret-scanning or CodeQL step is SKIPPED (status `SKIPPED`, GitHub's text kept) and listed under NOT ENFORCED instead of failing the run.

## 6. Environments and variables

Environments: `plan-dev`, `plan-prod`, `tf-dev`, `tf-prod`, `dev`, `preview`. Call: `PUT /repos/{o}/{r}/environments/{name}`
(all body fields optional): `wait_timer` 0, `prevent_self_review`, `reviewers` (up to 6, `{type: "User"|"Team", id}`),
`deployment_branch_policy` (`{protected_branches, custom_branch_policies}`: two booleans that must be opposite; we use
`false` and `true`) then the policy list under `.../environments/{name}/deployment-branch-policies`. Reviewer ids come
from `gh api users/<login> --jq .id`.

Every Environment is bound (by WIF subject `repo:<o>/<r>:environment:<name>`) to exactly ONE identity of ONE GCP project,
and carries that project's variables itself:

| Environment | Reviewers | Branch policy | Identity (bootstrap of that env) | Variables on the Environment |
|---|---|---|---|---|
| `plan-dev`, `plan-prod` | none | none (PR jobs run on `refs/pull/N/merge`) | `tf-planner-<env>`: read-only, reads its own state bucket | `GCP_PROJECT_ID`, `WIF_PROVIDER`, `TF_PLANNER_SA` |
| `tf-dev`, `tf-prod` | yes (`tf-prod` MUST keep them; `tf-dev` optional, record it) | exactly `main` | `tf-applier-<env>`: only writer of that env's Cloud Run service, roles in that project only, writes its own state bucket | `GCP_PROJECT_ID`, `WIF_PROVIDER`, `TF_APPLIER_SA` |
| `dev` | none (the gate is `tf-*`) | exactly `main` | `image-pusher`: `artifactregistry.writer` on the dev repo, nothing else | `GCP_PROJECT_ID`, `WIF_PROVIDER`, `IMAGE_PUSHER_SA` |
| `preview` | none | none | `preview-deployer`: the `api-preview` service, its runtime SA and its registry only | `GCP_PROJECT_ID`, `WIF_PROVIDER`, `PREVIEW_DEPLOYER_SA` |

- Variables are set per Environment (`gh variable set NAME --env <name> --repo <o>/<r> --body <value>`), never repo-wide,
  because the same name has a different value in dev and prod. A job reads the variables of the Environment it declares.
  Only `GCP_REGION` and `TF_VERSION` are repo-wide. The values come from each environment's Terraform bootstrap outputs
  (SKILL.md section 5, "Terraform foundation"); fill them in the config and re-run `-Apply`. The script skips empty or `REPLACE-*` values with a
  warning and refuses `tf-dev` and `tf-prod` with the same `GCP_PROJECT_ID` (unless `AllowSharedProject = $true`).
- MainOnly reconcile: for each MainOnly Environment the script lists ALL deployment policies and DELETES every one that is not
  `branch main` (extra branches and tags alike, because each still authorizes its refs to use the Environment's identity),
  adds `main` if missing, then reads the list again and fails unless exactly `[branch main]` remains.
- `preview` has no reviewers and NO branch policy: any same-repository PR can run a modified workflow in it, so it holds nothing
  that reaches dev or prod data. It cannot assume any other identity because each is bound to a different Environment subject.
- `prevent_self_review`: a solo operator is the only reviewer, so it must be false or nothing can ever be approved.
  Say so in `docs/stack.md`. With a second reviewer, set it true.
- Cost of reviewers: `terraform-apply.yml` waits for `tf-dev` and then `tf-prod` on every push to `main`. If the dev wait is
  too slow set `tf-dev` `Reviewers = $false` in the config; `tf-prod` stays gated. This is an operator choice, record it.
- `wait_timer` stays 0; the human is the gate, not a clock.

The only GitHub secret allowed is `RELEASE_PLEASE_TOKEN` (see section 8). All real secrets stay in Secret Manager.

## 7. CI baseline (`ci.yml`, `pr-title.yml`)

- Triggers: `pull_request`, `push` to `main`, `workflow_dispatch`.
- `concurrency` group per PR (or ref) with `cancel-in-progress` only for PRs: main pushes are never cancelled.
- `permissions: contents: read` at top; jobs add nothing. No job here authenticates to GCP, so no `id-token`.
- Jobs (= required checks): `lint`, `typecheck`, `test`, `build`, `dependency-audit`, `secret-scan`; `pr-title` in its own workflow.
- Skeleton defaults to Node via `npm run <script> --if-present`. For another stack replace the runtime setup step
  (`setup-node` reads `.nvmrc` and caches npm, and fails when `.nvmrc` is absent), the package guards and the `run:` lines
  (Python: ruff, mypy/pyright, pytest, `pip-audit`; Go: `go vet`, `go test ./...`, `govulncheck`). Keep job names.
- Day 0 (no app yet): every required job still runs and reports, but `setup-node`, `npm ci` and the script step carry
  `if: hashFiles('package-lock.json') != ''`, and a `no app yet` step prints a visible notice when the lockfile is absent.
  Without that guard `npm ci` fails and the very first PR cannot pass its own required checks. When the scaffold lands,
  DELETE the guards and the notice step (and the `--if-present` flags), otherwise removing the lockfile would pass silently.
- `secret-scan` runs gitleaks from its container on full history with `--redact`, no license needed.
- For React-specific CI such as Playwright sharding or Storybook, extend `ci.yml`. If you adopt an aggregate gate job,
  make the aggregate the single required check (`alls-green` pattern) and update `ruleset-main.json`.
- Pin actions: floating major tags (`@v7`) are acceptable for first-party `actions/*`; pin any third-party action that
  runs with credentials or write permission to a full commit SHA (supply-chain incidents in 2025 hit tag-pinned actions).
  Dependabot's github-actions ecosystem keeps SHAs fresh.
- Fork PRs get no secrets and no OIDC; that is expected, they only run these unauthenticated jobs.

## 8. Release flow

- `release-please.yml` (googleapis/release-please-action, `release-type: simple`, config + manifest in repo root).
  On each push to `main` it opens or updates ONE release PR (version bump from Conventional Commits, `CHANGELOG.md`).
  Merging that PR creates the tag `vX.Y.Z` and a GitHub Release. First version comes from `.release-please-manifest.json` (`0.0.0`).
- Token trap: a PR or tag created with `GITHUB_TOKEN` does not trigger other workflows, so required checks would never run on the
  release PR and it could not merge. Provide `RELEASE_PLEASE_TOKEN` (fine-grained PAT or GitHub App token with contents +
  pull-requests write). Workflow falls back to `GITHUB_TOKEN`; then close and reopen the release PR to start CI.
  This is the one GitHub secret the skill allows; it holds no GCP access.
- Deploy is `terraform-apply.yml`: every merge to `main` builds the image once, plans dev and prod with `-var image=<digest>`,
  and applies the saved plan behind the `tf-dev` and `tf-prod` approvals, then verifies the serving revision's digest
  (judge the deploy job, not the run, and compare the serving revision's digest with the built one: SKILL.md Principle 5).
  Terraform is the only writer of those services. Releasing a tag does not deploy by itself; prod
  always passes through the human gate.
- Version tags are immutable via `ruleset-tags.json`. A bad release is fixed by a new patch version, never by moving a tag.
- Tag-based alternative (no release-please): push `vX.Y.Z` from main by hand; same tag ruleset applies. Prefer release-please.

## 9. Order of operations (what the agent actually does)

1. Section 0 checks, get the operator's decision on any refusal.
2. Copy `bootstrap.config.example.psd1` to `bootstrap.config.psd1`, fill owner/repo/logins. Dry run:
   `powershell -File bootstrap-repo.ps1 -ConfigPath bootstrap.config.psd1` (prints every call and payload, sends nothing).
   Show the operator the output.
3. With a clear yes: `... -Apply`. It creates the repo if missing, then settings, Actions permissions, security switches,
   rulesets, environments (policies reconciled, per-Environment variables), repo-wide variables, and prints a result table.
   Exit code 1 if any step failed. A gh failure on the first repository lookup that is not a 404 (auth, permission, network) stops the run with a FATAL
   line; a failure inside a later step marks that step FAILED and the run continues to the result table.
4. Work in a fresh clone or a git worktree outside the main checkout, add the repo files (section 4) and
   workflows on `chore/bootstrap`, open the PR with a Conventional Commit title. The ruleset already requires the checks, and
   they report because the workflows are inside this very PR. Merge it with `gh pr merge --squash` once green. If a required
   check cannot run yet (stack not scaffolded), set the main ruleset `enforcement` to `evaluate`, merge, then flip to `active`.
5. Prove the repository-only gates G1, G3 and G7 (section 10). G2 and G4 are deferred; record them in `docs/stack.md` as `pending, proven at step <...>`.
6. Update `docs/stack.md`: repo, plan, solo/approvals decision, environment reviewers, date. IDs only.

## 10. Proving the gates (every gate shown red once)

Run after the first CI run exists. Pass means the command fails the way described. Keep the evidence (command and real output)
in `docs/stack.md` or the PR. Clean up everything the proofs create.

**When each proof can run.** Day 0 (repository only): G1, G3, G7. G2 needs an application test suite (until `package-lock.json` exists `ci.yml` skips the test command, so a failing test cannot fail it): run it when the scaffold lands. G4 needs `terraform-apply.yml`, the Terraform foundation and the `tf-*` Environment variables: run it after the workflows are installed. Until then write `G2: pending, proven at scaffold` and `G4: pending, proven when terraform-apply.yml is installed` in `docs/stack.md`.

**G1. Direct push to main is rejected**
```powershell
git switch main; git commit --allow-empty -m "chore: gate proof"; git push origin main
```
PASS: push is rejected, output contains `GH013: Repository rule violations found for refs/heads/main` and
"Changes must be made through a pull request". FAIL: push succeeds. Then `git reset --hard origin/main`.

**G2. A PR with a failing test cannot merge** (DEFERRED: needs an app test suite; not a Day 0 proof)
```powershell
git switch -c chore/prove-red-test origin/main
# add a test that always fails (e.g. tests/prove-red.test.js: expect(1).toBe(2)), commit, push
git push -u origin chore/prove-red-test
gh pr create --fill --title "chore: prove red test gate" --body "gate proof, do not merge"
gh pr checks --watch
gh pr view --json mergeStateStatus,mergeable,statusCheckRollup --jq '{state: .mergeStateStatus, test: (.statusCheckRollup[] | select(.name=="test") | .conclusion)}'
gh pr merge --squash
```
PASS: `test` is `FAILURE`, `mergeStateStatus` is `BLOCKED`, and `gh pr merge` exits non-zero with a message that required status
checks have not succeeded. If the merge is only queued with `--auto` it still must not complete. FAIL: PR merges.
Close without merging: `gh pr close --delete-branch`.

**G3. A PR missing a required check cannot merge** (the check is required but never reports)
```powershell
gh api repos/<o>/<r>/rulesets --jq '.[] | select(.name=="main-protection") | .id'     # note the id
# copy ruleset-main.json, add {"context":"proof-missing-check"} to required_status_checks, name it "proof-missing":
gh api -X POST repos/<o>/<r>/rulesets --input proof-missing.json
git switch -c chore/prove-missing-check origin/main; git commit --allow-empty -m "chore: proof"; git push -u origin HEAD
gh pr create --fill --title "chore: prove missing check gate" --body "gate proof"
gh pr view --json mergeStateStatus --jq .mergeStateStatus ; gh pr merge --squash
```
PASS: all real checks green, yet `mergeStateStatus` stays `BLOCKED` (check "Expected, waiting for status to be reported")
and the merge fails. Clean up: `gh api -X DELETE repos/<o>/<r>/rulesets/<proof-id>` (your own temporary ruleset), `gh pr close --delete-branch`.
Also run `verify-required-checks.py` (section 11): it is the static version of this gate.

**G4. Prod apply waits for approval, and only from main** (DEFERRED: needs terraform-apply.yml, the Terraform foundation and the Environment variables; not a Day 0 proof)
```powershell
gh workflow run terraform-apply.yml --ref main
$id = (gh run list --workflow=terraform-apply.yml --limit 1 --json databaseId | ConvertFrom-Json).databaseId
gh run view $id --json jobs --jq '.jobs[] | {name, status, conclusion}'
gh api repos/<o>/<r>/actions/runs/$id/pending_deployments --jq '.[] | {env: .environment.name, can_approve: .current_user_can_approve}'
```
PASS: `apply-dev` has `status: waiting` (never `in_progress` before approval), `pending_deployments` lists `tf-dev`, and
`apply-prod` has not started. Approve dev; after `apply-dev` succeeds, re-run the two queries: now `apply-prod` is `waiting` and
`pending_deployments` lists `tf-prod`. Also prove the order: a run where `apply-dev` fails (reject its approval) must leave
`apply-prod` `skipped`, never waiting.
Branch policy check: `gh workflow run terraform-apply.yml --ref chore/some-branch`: the `build` job must fail
immediately with "Branch ... is not allowed to deploy to dev due to environment protection rules", and `plan`, `apply-dev` and
`apply-prod` must show `skipped` (they depend on `build`).
Stale plan: the workflow's concurrency group queues a newer run behind a waiting one, so prove it out of band: while
`apply-dev` waits for approval, the operator runs one authorized `terraform -chdir=terraform/envs/dev apply` locally
(any harmless change, e.g. a label), which bumps the state serial. Then approve the waiting job: `terraform apply tfplan`
must refuse with "Saved plan is stale". Revert the local change afterwards with a normal PR.
Judge the JOB, not the run: a skipped job shows green at run level (SKILL.md Principle 5).

**G7. A non-conventional PR title is blocked** (Day 0, repository only)
```powershell
git switch -c chore/prove-bad-title origin/main; git commit --allow-empty -m "chore: proof"; git push -u origin HEAD
gh pr create --fill --title "bad title no type" --body "gate proof, do not merge"
gh pr checks --watch
gh pr view --json mergeStateStatus --jq .mergeStateStatus ; gh pr merge --squash
```
PASS: the `pr-title` check is `FAILURE`, `mergeStateStatus` is `BLOCKED`, and the merge fails. Then `gh pr edit --title "chore: prove title gate"` turns the check green (shows it is the title that was blocked). Clean up: `gh pr close --delete-branch`.

**G5. Version tags are immutable** (optional; creates a tag you cannot remove without relaxing the ruleset, so use a real release tag or skip)
```powershell
git push origin --delete v<existing-tag>
git push --force origin <a-commit-on-main-after-that-tag>:refs/tags/v<existing-tag>
```
PASS: both rejected with `GH013` (the second is a fast-forward move, so only the `update` rule stops it). Skip G5 on a repo with no release yet.

**G6. Bootstrap script idempotent**: run `-Apply` twice; second run exits 0 and the settings table is unchanged
(`gh api repos/<o>/<r>/rulesets --jq 'length'` stays 2, environment list unchanged).

## 11. Required-check name proof

```powershell
cd <repo>
python -I .github\verify-required-checks.py .github\ruleset-main.json .github\workflows\ci.yml .github\workflows\pr-title.yml
```
(copy the script and `ruleset-main.json` next to the workflows when the repo has no `.github\` scripts folder; they are
templates, not runtime.) Pass: last line `RESULT: OK`, exit 0, `required but no job produces it: []`. It is shown red once by
renaming a context in the JSON (`lint` to `linting`): `RESULT: FAIL`, exit 1; and by requiring `plan` while only `plan (dev)` and
`plan (prod)` exist: FAIL. No arguments: usage line, exit 2.

## 12. Sources (last checked 2026-10-14; re-check before relying on them)

- Rulesets create/update, rule types and parameters: https://docs.github.com/en/rest/repos/rules
- Environments (PUT body, plan requirements): https://docs.github.com/en/rest/deployments/environments
- Deployment branch policies (POST `name`, `type`): https://docs.github.com/en/rest/deployments/branch-policies
- Repository update (merge settings, `security_and_analysis`): https://docs.github.com/en/rest/repos/repos#update-a-repository
- Dependabot security updates and private vulnerability reporting endpoints: https://docs.github.com/en/rest/repos/repos
- Code scanning default setup: https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration
- Actions workflow permissions: https://docs.github.com/en/rest/actions/permissions
- release-please-action (config/manifest inputs, GITHUB_TOKEN trigger limitation): https://github.com/googleapis/release-please-action
- amannn/action-semantic-pull-request: https://github.com/amannn/action-semantic-pull-request
- gitleaks: https://github.com/gitleaks/gitleaks
- Action versions read with `gh api repos/<r>/releases/latest` on 2026-10-14 (refresh them: SKILL.md section 1, "Refresh pins"): checkout v7.0.1, setup-node v7.1.0, release-please-action v5.0.0, action-semantic-pull-request v6.1.1, gitleaks v8.30.1.
- Not independently verified (snippet or knowledge only): secret scanning / code scanning availability on private repos by plan, and branch-policy availability on private Pro/Team. Verified: `gh api user` returns no plan for a personal account, so the script requires `Plan` and never assumes one.
