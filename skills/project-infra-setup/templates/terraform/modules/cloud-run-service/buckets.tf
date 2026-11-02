# App data buckets (optional, empty by default). Private by construction: uniform access, public access prevention
# enforced, versioning on (add a retention policy per project when the data demands it).
# The bootstrap applier has NO storage role: before setting bucket_names, add "roles/storage.admin" to the applier roles in
# templates/terraform/bootstrap/main.tf (or a narrower custom role), or the apply is denied.
# The runtime SA gets objectAdmin on its OWN buckets only, never project-wide storage roles.
# Serve private media with signed URLs and a short TTL (references/security-baseline.md).
resource "google_storage_bucket" "data" {
  for_each                    = toset(var.bucket_names)
  project                     = var.project_id
  name                        = each.value
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
}

resource "google_storage_bucket_iam_member" "runtime" {
  for_each = google_storage_bucket.data
  bucket   = each.value.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}
