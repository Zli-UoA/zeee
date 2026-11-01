variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API Token with R2 permissions (Account.R2 Storage:Edit)"
  sensitive   = true
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare Account ID"
  default     = "c9918f2caa050736a07867e6f968c0a2"
}

variable "state_passphrase" {
  type        = string
  description = "Passphrase for OpenTofu state/plan encryption (infra/terraform/state-passphrase.sops.yaml)"
  sensitive   = true
}
