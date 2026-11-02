variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }

variable "env" {
  type        = string
  description = "dev | staging | prod"
}

variable "image" {
  type        = string
  description = "Full image reference, normally <repo>/<name>@sha256:<digest>. Required: the deploy pipeline passes it on every plan, so Terraform never reverts a shipped image."
}

variable "secret_names" {
  type        = list(string)
  default     = []
  description = "Env var names, for example DATABASE_URL. One Secret Manager container per name, created empty with the ID <name>-<env>-<NAME>; values are added out of band, never in Terraform."
}

variable "mount_secrets" {
  type        = bool
  default     = false
  description = "false on the first apply (containers only). Set true in a later apply, after every secret has an enabled version, to mount them as env vars."
}

variable "registry_writer_sas" {
  type        = list(string)
  default     = []
  description = "Emails of identities allowed to push images to this service's Artifact Registry repo. Dev: image-pusher. Prod: none (prod runs the digest built into the dev repo)."
}

variable "registry_reader_members" {
  type        = list(string)
  default     = []
  description = "IAM members (for example serviceAccount:...) allowed to pull from this repo. Dev: the prod project's Cloud Run service agent AND tf-applier-prod."
}

variable "keep_count" {
  type        = number
  default     = 20
  description = "Newest image versions that are never deleted."
}

variable "retention_days" {
  type        = number
  default     = 90
  description = "Image versions older than this (and not among the newest keep_count) are deleted."
}

variable "secret_version" {
  type        = string
  default     = "latest"
  description = "Env-var secrets are read at instance start. Pin a number in prod (for example 3), latest is fine in dev."
}

variable "env_vars" {
  type    = map(string)
  default = {}
}

variable "public" {
  type        = bool
  default     = false
  description = "true only after app-level auth exists"
}

variable "ingress" {
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  description = "Secure default. Use INGRESS_TRAFFIC_ALL (still IAM-private when public = false) for dev previews."
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 3
}

variable "timeout_seconds" {
  type    = number
  default = 300
}

variable "bucket_names" {
  type        = list(string)
  default     = []
  description = "Globally unique names of app data buckets to create (private, versioned, public access prevention enforced). The runtime SA gets objectAdmin on each, nothing project-wide."
}
