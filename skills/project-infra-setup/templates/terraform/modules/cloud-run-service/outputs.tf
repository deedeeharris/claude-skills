output "service_name" { value = google_cloud_run_v2_service.this.name }
output "url" { value = google_cloud_run_v2_service.this.uri }
output "runtime_sa" { value = google_service_account.runtime.email }
output "image_repo" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "secret_ids" { value = { for k, v in google_secret_manager_secret.this : k => v.secret_id } }
output "bucket_names" { value = [for b in google_storage_bucket.data : b.name] }
