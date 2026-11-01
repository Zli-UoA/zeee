output "fleet_bucket_name" {
  description = "celld fleet R2 bucket name"
  value       = cloudflare_r2_bucket.fleet.name
}

output "fleet_bucket_endpoint" {
  description = "S3-compatible R2 endpoint"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
