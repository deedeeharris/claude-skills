output "service_name" { value = google_cloud_run_v2_service.this.name }
output "image_repo" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
