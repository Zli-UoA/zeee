# Cloudflare R2 OpenTofu 構成

zeee が使う Cloudflare R2 バケットを OpenTofu でコード管理します。

## 管理対象リソース

- `zeee-fleet`（Location: `APAC`、Storage class: `Standard`）

`zeee-fleet` は celld の fleet バケットです。zoo2-infra の `kubernetes/apps/zeee/runtime/` にある celld StatefulSet が `CELLD_DURABILITY=bucket` で書き込む先で、zeee の永続データはこのバケットにしかありません。
デプロイ（`.github/workflows/deploy.yml`）も同じバケットに成果物を置きます。

- `lifecycle { prevent_destroy = true }` で、削除や再作成になる変更を拒否します。
- bucket lock は設定しません。ownership や deployment の更新を妨げます。
- 期限でオブジェクトを消すライフサイクルルールも設定しません。

バケットの認証情報（S3 API トークン）はこの構成では扱いません。celld 用は zoo2-infra の sops Secret `zeee-r2`、デプロイ用は GitHub Environment `production` の Secrets です。

## State

| 項目 | 値 |
| --- | --- |
| バケット | `zoo-terraform-state`（Zli-UoA の共有 state バケット。この構成の管理外） |
| key | `zeee/r2.tfstate` |
| endpoint | `https://c9918f2caa050736a07867e6f968c0a2.r2.cloudflarestorage.com` |
| ロック | `use_lockfile = true`（同じバケットに `.tflock` を置く） |
| 暗号化 | pbkdf2 + AES-GCM。state と plan の両方で必須（`enforced = true`） |

暗号化の passphrase は [`state-passphrase.sops.yaml`](state-passphrase.sops.yaml) に sops + age で暗号化して置いています。zoo2 や zoo2-infra とは別の値です。
passphrase を失うと state を復号できなくなります。値を変える場合は OpenTofu の `fallback` を使って state を再暗号化してから差し替えます。

## 必要な環境変数

| 変数 | 内容 |
| --- | --- |
| `TF_VAR_cloudflare_api_token` | Cloudflare API トークン（`Account` > `Workers R2 Storage` > `Edit`） |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `zoo-terraform-state` を読み書きできる R2 の S3 API トークン |
| `TF_VAR_state_passphrase` | state の暗号化 passphrase（下記の手順で sops から取り出す） |

`TF_VAR_cloudflare_account_id` は既定値（`c9918f2caa050736a07867e6f968c0a2`）があるので不要です。

## age 鍵の登録（plan / apply する人は最初に一度）

OpenTofu で plan / apply するには passphrase の復号が必要で、そのためにはあなたの公開鍵（age 鍵、無ければ SSH の ed25519 鍵）が [`.sops.yaml`](../../.sops.yaml) に登録されている必要があります。

1. 自分の鍵を用意します。age 鍵（zoo2-infra で作った鍵があればそれを使えます）を作るか、既存の SSH ed25519 鍵を使います。

   ```sh
   # age 鍵
   mkdir -p ~/.config/sops/age
   age-keygen -o ~/.config/sops/age/keys.txt
   age-keygen -y ~/.config/sops/age/keys.txt   # 公開鍵（age1…）

   # age 鍵が無ければ SSH ed25519 鍵の公開鍵
   cat ~/.ssh/id_ed25519.pub                   # ssh-ed25519 AAAA…
   ```

   SSH 鍵の場合、復号時は sops が `~/.ssh/id_ed25519` を使います。別の場所なら `SOPS_AGE_SSH_PRIVATE_KEY_FILE` で指定します。
   パスフレーズ付きの SSH 鍵は端末が無いと復号できないため、CI などの非対話環境では使えません。

2. 公開鍵（`age1…` または `ssh-ed25519 AAAA…` の行そのまま）を `.sops.yaml` の `age:` に追加する PR を出します。秘密鍵は Git・Issue・チャットに貼りません。
3. 既存のメンバーがその PR のブランチで再暗号化し、コミットしてからマージします。

   ```sh
   sops updatekeys -y infra/terraform/state-passphrase.sops.yaml
   ```

4. マージ後は passphrase を取り出せます。

   ```sh
   export TF_VAR_state_passphrase="$(sops decrypt --extract '["passphrase"]' infra/terraform/state-passphrase.sops.yaml)"
   ```

`sops` と `age` は `nix shell nixpkgs#sops nixpkgs#age` などで用意してください。

## 手動実行手順

```sh
cd infra/terraform
export TF_VAR_cloudflare_api_token="<CLOUDFLARE_API_TOKEN>"
export AWS_ACCESS_KEY_ID="<STATE_ACCESS_KEY_ID>"
export AWS_SECRET_ACCESS_KEY="<STATE_SECRET_ACCESS_KEY>"
export TF_VAR_state_passphrase="$(sops decrypt --extract '["passphrase"]' state-passphrase.sops.yaml)"

tofu init
tofu plan
tofu apply
```

## 既存バケットの取り込み（初回のみ）

`zeee-fleet` は 2026-10-30 に手で作ったバケットです。[`r2.tf`](r2.tf) の `import` ブロックで取り込みます。
provider v5 の import ID は `<account_id>/<bucket_name>/<jurisdiction>` で、jurisdiction は `default` です。

1. 上の環境変数を設定して `tofu init` します。
2. `tofu plan` で `1 to import, 0 to add, 0 to change, 0 to destroy` になることを確認します。
   変更や再作成が出たら apply せず、`r2.tf` を実際の設定に合わせます（`location` は大文字の `APAC` で一致します）。
3. `tofu apply` で state に取り込みます。
4. もう一度 `tofu plan` して `No changes.` になることを確認します。

取り込み後も `import` ブロックは残して構いません（state にあるリソースには何もしません）。

## GitHub Actions

`.github/workflows/terraform-r2.yaml` で次を実行します。apply は CI では行いません。

- `infra/terraform/**` の変更時: `tofu fmt -check`、`tofu init -backend=false`、`tofu validate`
- 下記 Secrets がすべてあるときだけ: backend 付きの `tofu plan`（fork PR などでは skip）

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API トークン |
| `TF_STATE_AWS_ACCESS_KEY_ID` / `TF_STATE_AWS_SECRET_ACCESS_KEY` | state バケット用の R2 S3 API トークン |
| `TF_STATE_PASSPHRASE` | `state-passphrase.sops.yaml` の `passphrase` |
