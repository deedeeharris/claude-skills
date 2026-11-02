# project-infra-setup

A Claude Code skill that bootstraps and audits production infrastructure for a project on Google Cloud and GitHub:
a protected GitHub repo, Terraform-owned GCP resources, keyless CI/CD through Workload Identity Federation, and a
Cloud Run deploy pipeline where every `terraform apply` waits for a human.

## What it does

- **Day 0 (GitHub):** creates or configures the repo (squash-only, `main` as the only long-lived branch), `main` and `v*`
  tag rulesets, GitHub Environments with `main`-only branch policies and reviewers, security switches, Dependabot,
  CODEOWNERS, release-please, and CI whose job names match the required checks. Driven by a dry-run-first PowerShell script.
- **Terraform foundation (GCP):** one GCP project, state bucket, WIF pool, read-only planner and gated applier per
  environment; a Cloud Run service module with its own runtime service account, Artifact Registry repo with cleanup
  policies, and Secret Manager containers (values never enter Terraform).
- **CI/CD:** plan on PR (read-only), build once and deploy by image digest after merge behind `tf-dev` and `tf-prod`
  approvals, a post-deploy digest check on the revision that serves traffic, weekday drift detection, and per-PR preview
  revisions on a separate service.
- **Audit:** a 12-item security baseline with read-only audit commands, and an OWASP-style infra review.
- **Optional modules:** service selection (VMs, jobs, static sites), default-network firewall hygiene, Firebase,
  Google auth, Gemini API keys, MongoDB Atlas.

## Maturity

The Day 0 GitHub path (`bootstrap-repo.ps1`) ran live only against a private Free-plan repo in degraded mode: repo settings,
Environments, their variables and `main`-only branch policies were applied and checked; rulesets and Environment reviewers
were refused by GitHub on that plan (measured refusals in `references/repo-bootstrap.md` section 0). The success path for
rulesets and reviewers follows GitHub's REST docs but has NOT been run yet: prove G1, G3 and G4 on a throwaway repo first. The Terraform/GCP deploy path (bootstrap, plan/apply, preview, drift) passed
static validation (`terraform validate`, actionlint) and independent review but has NOT yet run against a live GCP project,
so it is **EXPERIMENTAL**. Run the gate proofs on a throwaway project first and treat any failure as a skill bug.

## Prerequisites

- `gh` CLI 2.40 or newer, authenticated (`gh auth status`) with rights to create and administer the repo.
- `gcloud`, logged in, with Application Default Credentials for the Terraform bootstrap (`gcloud auth application-default login`).
- `terraform` 1.11 or newer (match `TF_VERSION` in the bootstrap config).
- `git`.
- PowerShell: Windows PowerShell 5.1 or PowerShell 7+ (`pwsh`; dry run and refusal path tested on 5.1 and on pwsh 7.4 Linux, `-Apply` exercised on Windows only), for `templates/github/bootstrap-repo.ps1`.
- Python 3 (standard library only) for `templates/github/verify-required-checks.py`. Run it as `python -I ...`
  (`python3 -I ...` on macOS/Linux).
- A GCP billing account, and one GCP project per environment.
- GitHub plan: public repos get every feature on every plan. Private repos need Pro, Team or Enterprise for rulesets, and
  Enterprise for Environment required reviewers (the approval gate). A private repo on Free can only run in an opt-in
  degraded mode with no merge gate and no approval gate; the script refuses it by default.

## Quick start

1. Copy or symlink this folder into your Claude Code skills directory (commands run from the root of a clone of this repo):
   - macOS/Linux: `ln -s "$PWD/skills/project-infra-setup" ~/.claude/skills/project-infra-setup`
   - Windows (PowerShell): `New-Item -ItemType Junction -Path "$HOME\.claude\skills\project-infra-setup" -Target "$PWD\skills\project-infra-setup"`
   - Or copy the folder to `~/.claude/skills/project-infra-setup/`.
2. Start Claude Code in your project and ask, for example: "Use project-infra-setup to bootstrap this repo and a GCP
   dev/prod pipeline" or "Audit this GCP project's Cloud Run security".
3. Before copying templates, refresh the version pins (`references/customizing-templates.md`, "Refresh pins").
   If your service is not called `api`, read "Renaming the service" in the same file first.

The skill always dry-runs first and asks before any write, apply or IAM change.

## Gate proofs

Each enforcement gate (G1-G4, G7) must be shown failing ("red") once; G5 (tag protection) is optional until the first release and G6 is an idempotency re-run; commands and expected output are in `references/repo-bootstrap.md` section 10.

| Gate | Proves | When it can run |
|---|---|---|
| G1 | direct push to `main` is rejected | Day 0 |
| G2 | a PR with a failing test cannot merge | once the app has a test suite |
| G3 | a PR missing a required check cannot merge | Day 0 |
| G4 | prod apply waits for approval, and only from `main` | once the Terraform workflows and foundation exist |
| G5 | version tags cannot be moved or deleted (optional) | after the first release |
| G6 | `bootstrap-repo.ps1 -Apply` is idempotent | Day 0 |
| G7 | a non-conventional PR title is blocked | Day 0 |

## Layout

- `SKILL.md`: the workflow the agent follows.
- `README.md`, `LICENSE`.
- `agents/openai.yaml`: display metadata for agents that read it.
- `references/repo-bootstrap.md`: Day 0 detail (plan table, rulesets, Environments, CI, release flow, gate proofs).
- `references/security-baseline.md`: 12-item baseline, Terraform snippets, read-only audit commands.
- `references/customizing-templates.md`: renaming the service, refreshing version pins.
- `references/optional-modules.md`: service selection, network hygiene, Firebase, Google auth, Gemini, MongoDB Atlas.
- `templates/github/`: `bootstrap-repo.ps1` and its config, rulesets, `ci.yml`, `pr-title.yml`, release-please,
  `dependabot.yml`, CODEOWNERS, PR template, `verify-required-checks.py`.
- `templates/github-workflows/`: `terraform-plan.yml`, `terraform-apply.yml`, `terraform-drift.yml`, `preview.yml`.
- `templates/terraform/`: `bootstrap/` (applied once per environment), `envs/dev/`, `modules/cloud-run-service/`,
  `modules/preview-service/`.
- `templates/scripts/tf-ci.sh`: state check and serving-digest verification used by the workflows.
- `templates/docker/.dockerignore`.

## License

MIT. See `LICENSE`.
