# Customizing the templates

## Renaming the service

The templates ship ONE Cloud Run service whose base name is `api`. Terraform derives every resource name from it, and the
workflows hardcode the derived names. Rename in all places at once, before the first apply, or the deploy jobs will target
a service or registry that does not exist.

Derived names (from `var.name` in the modules):

| Module | Runtime SA | Artifact Registry repo | Cloud Run service | Secret IDs |
|---|---|---|---|---|
| `modules/cloud-run-service` | `<name>-<env>` | `<name>-<env>` | `<name>-<env>` | `<name>-<env>-<SECRET_NAME>` |
| `modules/preview-service` | `<name>-preview` | `<name>-preview` | `<name>-preview` | none |

With the default `api`: `api-dev`, `api-prod` (and `api-staging`), `api-preview`. The image inside each registry is also
called `api` (`<region>-docker.pkg.dev/<project>/api-dev/api@<digest>`).

Where `api` is written literally (search with `grep -rnE 'api-|/api[:@]|"api"' terraform .github/workflows` after copying):

| File | What to change |
|---|---|
| `templates/terraform/envs/dev/main.tf` (and every copied `envs/<env>/main.tf`) | `name = "api"` in `module "api"` and in `module "api_preview"`; optionally the module labels and the outputs that reference `module.api` |
| `templates/terraform/modules/preview-service/variables.tf` | `default = "api"` of `variable "name"` (only matters if a caller omits `name`) |
| `templates/github-workflows/terraform-plan.yml` | `SERVICE: api-${{ matrix.env }}` |
| `templates/github-workflows/terraform-drift.yml` | `SERVICE: api-${{ matrix.env }}` |
| `templates/github-workflows/terraform-apply.yml` | build `tags:` and the `image=` output (`/api-dev/api`), `SERVICE: api-${{ matrix.env }}` in `plan`, `SERVICE: api-dev` in `apply-dev`, `SERVICE: api-prod` in `apply-prod` |
| `templates/github-workflows/preview.yml` | `SERVICE: api-preview`, the build `tags:` and `--image` (`/api-preview/api`), the concurrency groups `cloud-run-api-preview` |

`templates/terraform/bootstrap/main.tf` mentions `api-preview` only in comments and in a service-account `display_name`;
those are cosmetic.

Name rules: lowercase letters, digits and hyphens, starting with a letter. Service account IDs are limited to 30 characters,
so `<name>-preview` and `<name>-staging` need `name` of 22 characters or fewer. After renaming: `terraform validate` in each
env root, then grep the workflows again for the old name. Expect zero hits.

A second service is a second module call in each env root plus its own build, plan and verify steps in the workflows;
the templates do not generate that for you.

## Refresh pins

Versions in the templates were current when they were last checked. Before the first use, and on every new project:

1. **Terraform CLI.** `TF_VERSION` in `templates/github/bootstrap.config.example.psd1` (repo-wide variable that CI installs).
   Latest: `gh api repos/hashicorp/terraform/releases/latest --jq .tag_name`. Keep it at or above `required_version` in the
   Terraform blocks, and use the same version locally.
2. **Provider constraint.** `hashicorp/google` `version = "~> 8.0"` in `templates/terraform/bootstrap/main.tf`,
   `templates/terraform/envs/dev/main.tf` and both modules' `versions.tf`. Move all of them together.
3. **GitHub Actions.** Every `uses:` in `templates/github/*.yml` and `templates/github-workflows/*.yml`, and the gitleaks
   image tag in `templates/github/ci.yml`. Latest release: `gh api repos/<owner>/<action>/releases/latest --jq .tag_name`.
   For a commit-SHA pin: `gh api repos/<owner>/<action>/commits/<tag> --jq .sha`, written as `uses: <owner>/<action>@<sha> # <tag>`.
   Pin by SHA anything that handles credentials (SKILL.md section 6). As shipped, every third-party action (google-github-actions,
   hashicorp, docker, amannn, googleapis) is SHA-pinned with its tag in a comment; GitHub's own `actions/*` use major tags. Dependabot's github-actions ecosystem keeps them fresh after Day 0.
4. **Provider lock file.** Each env root commits `.terraform.lock.hcl` (SKILL.md section 5, step 8) and CI inits with
   `-lockfile=readonly`. After changing the provider constraint, regenerate it for CI's platform and every operator platform:
   `terraform -chdir=terraform/envs/<env> providers lock -platform=linux_amd64 -platform=<windows_amd64|darwin_arm64|...>`,
   then commit it in a PR.
5. **Sources.** Dates next to "Sources" in SKILL.md and `references/repo-bootstrap.md` are "last checked" dates, not
   guarantees. Re-check a source before relying on a behavior it documents (plan availability, API fields, action inputs).
