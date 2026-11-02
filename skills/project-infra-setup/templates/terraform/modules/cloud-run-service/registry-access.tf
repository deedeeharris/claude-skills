# Registry access, per repository. No project-level role is ever granted to a CI identity, and no CI identity
# can write the Cloud Run service: Terraform (tf-applier-<env>) is its only writer.
# registry_writer_sas: may push images to THIS repository only (dev: image-pusher).
resource "google_artifact_registry_repository_iam_member" "writer" {
  for_each   = toset(var.registry_writer_sas)
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${each.value}"
}

# registry_reader_members: may pull from THIS repository. Use it when another project's Cloud Run runs the image built
# here (prod runs the digest built in dev). List BOTH the prod Cloud Run service agent and the prod applier:
#   serviceAccount:service-<PROD_PROJECT_NUMBER>@serverless-robot-prod.iam.gserviceaccount.com
#   serviceAccount:tf-applier-prod@<PROD_PROJECT_ID>.iam.gserviceaccount.com
resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each   = toset(var.registry_reader_members)
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.reader"
  member     = each.value
}
