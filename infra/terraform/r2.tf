provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# -----------------------------------------------------------------------------
# celld fleet バケット (zeee-fleet)
# -----------------------------------------------------------------------------

# 2026-10-30 に手で作ったバケットを取り込みます。ID は <account_id>/<bucket_name>/<jurisdiction>。
import {
  to = cloudflare_r2_bucket.fleet
  id = "${var.cloudflare_account_id}/zeee-fleet/default"
}

resource "cloudflare_r2_bucket" "fleet" {
  account_id    = var.cloudflare_account_id
  name          = "zeee-fleet"
  location      = "APAC" # API は大文字で返すため、小文字にすると差分（再作成）になります
  storage_class = "Standard"

  # zeee の永続データはこのバケットだけです（celld の CELLD_DURABILITY=bucket の書き込み先）。
  # 削除や再作成（location の変更など）をすると全データが失われるため、destroy を拒否します。
  # bucket lock と期限削除のライフサイクルルールは付けません。ownership や deployment の更新を妨げます。
  lifecycle {
    prevent_destroy = true
  }
}
