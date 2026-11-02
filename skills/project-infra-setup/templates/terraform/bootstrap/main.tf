# EXPERIMENTAL (project-infra-setup): validated statically, not yet run against a live GCP project. Prove the gates first.
# BOOTSTRAP: applied ONCE PER ENVIRONMENT (dev, then prod) by a human with gcloud ADC (gcloud auth application-default login).
# Each run lives in ONE GCP project and creates everything that environment's CI needs before it can run:
# its own state bucket, its own WIF pool and provider, and its own identities. Nothing is shared between environments,
# so a dev job can never hold a prod permission or touch prod state. Use one GCP project per environment: in a single
# project the project-level roles below would still cover both environments.
# Its own state stays LOCAL, one file per environment (terraform apply -var-file=<env>.tfvars -state=<env>.tfstate),
# gitignored, backed up by the operator.
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "github_repo" {
  type        = string
  description = "owner/repo, exact"
}
variable "github_repo_id" {
  type        = string
  description = "Numeric repository id (gh api repos/<owner>/<repo> --jq .id). Names can be re-registered, ids cannot."
}

variable "env" {
  type        = string
  description = "dev | staging | prod. Names every resource and picks the GitHub Environments: plan-<env> (planner) and tf-<env> (applier)."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "build_and_preview" {
  type        = bool
  default     = false
  description = "true ONLY in the environment that builds images and hosts PR previews (dev). Creates image-pusher and preview-deployer. Leave false for prod."
}

variable "build_environment" {
  type        = string
  default     = "dev"
  description = "GitHub Environment (main-only branch policy) that may assume image-pusher."
}

variable "preview_environment" {
  type        = string
  default     = "preview"
  description = "GitHub Environment that may assume preview-deployer. It has no reviewers and runs PR code."
}

locals {
  subject_base = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repo}:environment:"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "core" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# This environment's remote state bucket (one bucket per environment: IAM on it IS the state isolation).
# GCS backend locks natively; versioning is the state history.
resource "google_storage_bucket" "tfstate" {
  name                        = "${var.project_id}-tfstate-${var.env}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.core]
}

# Workload Identity Federation for GitHub Actions. No JSON keys anywhere. One pool per environment.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-${var.env}"
  depends_on                = [google_project_service.core]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.repo_id"    = "assertion.repository_id"
    "attribute.ref"        = "assertion.ref"
  }

  # Mandatory. GitHub uses ONE issuer for all orgs; without a condition any repo could try this pool.
  attribute_condition = "assertion.repository_id == '${var.github_repo_id}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Planner and applier of THIS environment. Each is bound to exactly one GitHub Environment subject
# (sub = repo:<owner>/<repo>:environment:<name>), so a job outside that Environment cannot assume it.
resource "google_service_account" "planner" {
  account_id   = "tf-planner-${var.env}"
  display_name = "Terraform plan, ${var.env} (read-only, runs on PRs)"
  depends_on   = [google_project_service.core] # iam.googleapis.com must be on before any account is created
}

resource "google_service_account" "applier" {
  account_id   = "tf-applier-${var.env}"
  display_name = "Terraform apply, ${var.env} (GitHub Environment tf-${var.env}, approval gated)"
  depends_on   = [google_project_service.core] # iam.googleapis.com must be on before any account is created
}

resource "google_service_account_iam_member" "planner_wif" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.subject_base}plan-${var.env}"
}

resource "google_service_account_iam_member" "applier_wif" {
  service_account_id = google_service_account.applier.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.subject_base}tf-${var.env}"
}

# Planner: read-only. It plans with -lock=false so it never needs write access to state.
# State must already exist (SKILL.md section 5, first apply by the operator): the GCS backend WRITES an empty
# state object when none exists, which this read-only identity cannot do.
resource "google_project_iam_member" "planner_viewer" {
  project = var.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "planner_state" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "applier_state" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.applier.email}"
}

# Applier: narrow roles for what the env roots create, in THIS project only. No Owner, Editor or project IAM admin
# (the modules grant IAM on single resources, never on the project). Extend per resource type you add.
# It is the ONLY writer of the Cloud Run services (image and traffic included): app deploys run through it.
resource "google_project_iam_member" "applier" {
  for_each = toset([
    "roles/run.admin",
    "roles/artifactregistry.admin",
    "roles/secretmanager.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser", # actAs to attach runtime SAs; gated by the tf-<env> Environment reviewers
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.applier.email}"
}

# ---- dev only: image build and PR previews ------------------------------------------------------------

# image-pusher: pushes images to the dev registry from the main-only `dev` Environment. No project roles:
# the env module grants artifactregistry.writer on that one repository (registry_writer_sas).
resource "google_service_account" "image_pusher" {
  count        = var.build_and_preview ? 1 : 0
  account_id   = "image-pusher"
  display_name = "Build and push images to the dev registry (main only)"
  depends_on   = [google_project_service.core] # iam.googleapis.com must be on before any account is created
}

resource "google_service_account_iam_member" "image_pusher_wif" {
  count              = var.build_and_preview ? 1 : 0
  service_account_id = google_service_account.image_pusher[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.subject_base}${var.build_environment}"
}

# preview-deployer: used ONLY by the `preview` Environment, which has no reviewers and no branch policy, so any
# same-repository PR workflow can assume it. It can write the separate api-preview service and nothing else
# (rights granted by modules/preview-service). It holds no rights on api-dev or any prod resource.
resource "google_service_account" "preview_deployer" {
  count        = var.build_and_preview ? 1 : 0
  account_id   = "preview-deployer"
  display_name = "PR preview deploy to the api-preview service only (PR code runs here)"
  depends_on   = [google_project_service.core] # iam.googleapis.com must be on before any account is created
}

resource "google_service_account_iam_member" "preview_deployer_wif" {
  count              = var.build_and_preview ? 1 : 0
  service_account_id = google_service_account.preview_deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.subject_base}${var.preview_environment}"
}

output "wif_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "planner_sa" { value = google_service_account.planner.email }
output "applier_sa" { value = google_service_account.applier.email }
output "image_pusher_sa" { value = try(google_service_account.image_pusher[0].email, null) }
output "preview_deployer_sa" { value = try(google_service_account.preview_deployer[0].email, null) }
output "state_bucket" { value = google_storage_bucket.tfstate.name }
