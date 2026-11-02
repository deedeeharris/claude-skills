variable "project_id" { type = string }
variable "region" { type = string }

variable "name" {
  type        = string
  default     = "api"
  description = "Service base name. The preview service is <name>-preview."
}

variable "preview_deployer_sa" {
  type        = string
  description = "Email of the preview-deployer identity (bootstrap output preview_deployer_sa). The ONLY identity that may write this service."
}

variable "max_instances" {
  type    = number
  default = 2
}
