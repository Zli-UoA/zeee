terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }

  # state は Zli-UoA の共有 R2 バケット zcp-terraform-state に置きます（リポジトリごとに key を分けます）。
  # 認証情報は環境変数 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（R2 の S3 API トークン）で渡します。
  backend "s3" {
    bucket = "zcp-terraform-state"
    key    = "zeee/r2.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://c9918f2caa050736a07867e6f968c0a2.r2.cloudflarestorage.com"
    }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  # state と plan は passphrase で暗号化します（state-passphrase.sops.yaml、README 参照）。
  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase
      # state には PBKDF2 のメタデータがこの名前で保存されます。既定の provider 名だと、
      # passphrase の入れ替え時に旧値の provider を改名すると既存 state を読めなくなるため固定します。
      # 入れ替えるときは新しい値に別の alias（zeee-v2 など）を付けます（README 参照）。
      encrypted_metadata_alias = "zeee-v1"
    }

    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.passphrase
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
