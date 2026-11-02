# The PR preview service. Separate from the dev service on purpose: the `preview` GitHub Environment has no reviewers
# and runs PR code, so its identity (preview-deployer) may write THIS service and nothing else.
# Terraform creates the shell (runtime SA, registry, IAM, scaling, ingress). preview.yml is the only writer of its
# revisions and tags, so the revision-level fields are under ignore_changes here and ONLY here.
# Previews get no secrets and no env vars: PR code cannot reach dev data.
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.name}-preview"
  display_name = "Runtime identity for ${var.name} PR previews (no secrets, no data access)"
}

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name}-preview"
  format        = "DOCKER"

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "${14 * 86400}s"
    }
  }
}

resource "google_cloud_run_v2_service" "this" {
  project             = var.project_id
  name                = "${var.name}-preview"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # still IAM-private: no invoker binding exists
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello" # placeholder; preview.yml deploys PR revisions with --no-traffic
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      traffic,
      client,
      client_version,
    ]
  }
}

# preview-deployer: update THIS service, act as THIS runtime SA, push to THIS registry. Nothing else.
resource "google_cloud_run_v2_service_iam_member" "deployer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${var.preview_deployer_sa}"
}

resource "google_service_account_iam_member" "deployer_act_as" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.preview_deployer_sa}"
}

resource "google_artifact_registry_repository_iam_member" "writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.preview_deployer_sa}"
}
