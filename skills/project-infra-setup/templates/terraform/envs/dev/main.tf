# EXPERIMENTAL (project-infra-setup): validated statically, not yet run against a live GCP project. Prove the gates first.
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "api" {
  source = "../../modules/cloud-run-service"

  project_id              = var.project_id
  region                  = var.region
  name                    = "api"
  env                     = var.env
  image                   = var.image
  secret_names            = ["DATABASE_URL"]
  mount_secrets           = var.mount_secrets
  secret_version          = var.secret_version
  env_vars                = { NODE_ENV = "production" }
  ingress                 = "INGRESS_TRAFFIC_ALL" # still IAM-private. Prod: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER
  max_instances           = 2
  registry_writer_sas     = var.registry_writer_sas
  registry_reader_members = var.registry_reader_members
}

# PR previews live on their own service, written only by preview-deployer. dev root only.
module "api_preview" {
  count  = var.preview_deployer_sa == null ? 0 : 1
  source = "../../modules/preview-service"

  project_id          = var.project_id
  region              = var.region
  name                = "api"
  preview_deployer_sa = var.preview_deployer_sa
}

output "api_url" { value = module.api.url }
output "image_repo" { value = module.api.image_repo }
output "secret_ids" { value = module.api.secret_ids }
