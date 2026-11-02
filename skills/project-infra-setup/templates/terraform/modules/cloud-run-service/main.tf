# Dedicated runtime SA. The service never runs as the default compute SA, and this SA never gets roles/editor.
# Grant it only per-secret secretAccessor (below) and per-bucket access (buckets.tf).
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.name}-${var.env}"
  display_name = "Runtime identity for ${var.name} (${var.env})"
}

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name}-${var.env}"
  format        = "DOCKER"

  # KEEP wins over DELETE: the newest keep_count versions are never deleted. Everything else older than
  # retention_days IS deleted (KEEP alone never deletes anything). Rollback window = the last keep_count versions,
  # plus anything younger than retention_days. An image a service still runs must satisfy one of the two, so
  # redeploy (or promote to prod) within retention_days.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_count
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "${var.retention_days * 86400}s"
    }
  }
}

# Secret containers only. Versions (values) never appear in code or state.
# The secret_id is namespaced by service and env so dev and prod can coexist in one project;
# the env var name inside the container stays the bare name (for example DATABASE_URL).
resource "google_secret_manager_secret" "this" {
  for_each  = toset(var.secret_names)
  project   = var.project_id
  secret_id = "${var.name}-${var.env}-${each.value}"

  replication {
    auto {}
  }
}

# Per-secret access, never project-level secretAccessor.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.this
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "this" {
  project             = var.project_id
  name                = "${var.name}-${var.env}"
  location            = var.region
  ingress             = var.public ? "INGRESS_TRAFFIC_ALL" : var.ingress
  deletion_protection = var.env == "prod"

  # Terraform is the ONLY writer of this service: image (a digest passed as var.image by the deploy pipeline) and
  # traffic included. No ignore_changes anywhere, so the next apply always shows what differs.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  template {
    service_account = google_service_account.runtime.email
    timeout         = "${var.timeout_seconds}s"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      # Mounted only after mount_secrets = true (second apply, once every secret has an ENABLED version).
      # Cloud Run reads env-var secrets before the instance starts; a missing version blocks startup.
      dynamic "env" {
        for_each = var.mount_secrets ? google_secret_manager_secret.this : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = var.secret_version
            }
          }
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.runtime]
}

# Private by default. No allUsers binding unless public = true.
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
