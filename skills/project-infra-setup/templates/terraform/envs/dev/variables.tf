variable "project_id" { type = string }

variable "region" {
  type    = string
  default = "us-central1"
}

variable "env" {
  type        = string
  description = "Environment name, set per root in terraform.tfvars: dev here, prod in envs/prod. It drives resource names and prod deletion protection."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "image" {
  type        = string
  description = "Image to run, passed by CI on every plan as -var image=<repo>@sha256:<digest> (never set it in tfvars). The first apply by the operator uses the placeholder us-docker.pkg.dev/cloudrun/container/hello."

  validation {
    condition     = var.image == "us-docker.pkg.dev/cloudrun/container/hello" || can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by digest (<repo>@sha256:<64 hex>) or be the hello placeholder."
  }
}

variable "mount_secrets" {
  type        = bool
  default     = false
  description = "false for the first apply (secret containers only). Set true after every secret has an enabled version."
}

variable "secret_version" {
  type        = string
  default     = "latest"
  description = "dev: latest. prod: pin a version number (for example 3)."
}

variable "registry_writer_sas" {
  type        = list(string)
  default     = []
  description = "SA emails allowed to push to this env's registry. dev: image-pusher. prod: none."
}

variable "registry_reader_members" {
  type        = list(string)
  default     = []
  description = "IAM members allowed to pull from this env's registry. dev: the prod project's Cloud Run service agent AND tf-applier-prod (prod deploys the dev-built digest)."
}

variable "preview_deployer_sa" {
  type        = string
  default     = null
  description = "dev only: preview-deployer email. Setting it creates the separate api-preview service. prod: leave null."
}
