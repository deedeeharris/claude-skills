# Backend blocks cannot use variables. Replace the placeholder, or pass -backend-config in CI.
# One bucket per environment (created by the bootstrap of that environment): <project>-tfstate-<env>.
# The GCS backend locks natively, no extra database needed.
terraform {
  backend "gcs" {
    bucket = "REPLACE-PROJECT_ID-tfstate-dev"
    prefix = "envs/dev"
  }
}
