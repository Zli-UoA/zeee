# CI / CD 運用メモ

Zeee のアプリケーションは GitHub Actions で検証・デプロイする。インフラ（R2 bucket、D1、celld の StatefulSet、Traefik、Cloudflare Tunnel）は [zoo2-infra](https://github.com/Zli-UoA/zoo2-infra) 側で管理する。

## パイプライン

### CI

`.github/workflows/ci.yml`

- トリガー: pull request、`main` への push、`workflow_dispatch`
- ランナー: GitHub-hosted `ubuntu-latest`
- 実行内容: `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm test` → `pnpm build:celld`
- Node.js 24.11.0 / pnpm 12.16.1 を使用

### CD

`.github/workflows/deploy.yml`

- トリガー: `main` の CI 成功後（`workflow_run`）、または `workflow_dispatch`
- 手動実行時は `ref` に commit SHA / branch / tag を指定できる（既定は `main`）
- GitHub Environment `production` を使用
- 本番 URL: <https://zeee.zli.works>（初回デプロイ前は 404）

デプロイの流れ:

1. 対象 ref を checkout
2. `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test`、`pnpm build:celld`
3. `dist/wrangler.json` を検証（Worker 名、`PUBLIC_ORIGIN`、D1 / Durable Object binding、開発用変数の混入なし）
4. R2 secrets の有無を確認
5. celld 0.6.2 を取得して `celld deploy dist`
6. `https://zeee.zli.works/api/health` を最大 30 回確認

## 初回デプロイ

1. GitHub の Environment `production` を作成する
2. 次の secrets を登録する
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
3. 必要に応じて次の variables を登録する。未設定なら workflow 内の既定値を使う
   - `CELLD_BUCKET`
   - `S3_ENDPOINT`
   - `AWS_REGION`
4. Actions の Deploy workflow を `workflow_dispatch` で実行する
5. health check が通ったことを確認する

R2 secrets が未設定のままデプロイすると、deploy は skip される。workflow 自体は成功扱いになり、Summary に設定手順が表示される。secrets を設定してから `workflow_dispatch` で再実行する。

## 手動デプロイ

- 通常は `main` の CI 成功後に自動で実行される
- 特定の commit を出したいときは `workflow_dispatch` の `ref` に SHA を指定する
- 同じ ref の再実行が必要なときも `workflow_dispatch` を使う

## 失敗時の確認

- `pnpm check` / `pnpm test` / `pnpm build:celld` の失敗: CI と同じ手順をローカルで再現する
- `dist/wrangler.json` の検証失敗: `void.config.ts` と celld 用ビルド設定を確認する
- R2 secrets の skip: Environment `production` の secrets 名を確認する
- `celld deploy` の失敗: R2 の credential / bucket / endpoint と celld の状態を確認する
- health check の失敗: 30 回のリトライ後も `/api/health` が通らない場合、デプロイは失敗扱い。celld / ingress / tunnel の状態を確認する

## D1 の additive migration

`src/server/schema.ts` は基礎スキーマの後に `0001_scale`、`0002_directory` の順で適用する。各 migration の SQL と `meta['migration:...']` の marker は同じ D1 `batch` に入るため、失敗時は marker ごと rollback され、次回リクエストで再試行される。

`0002_directory` は `page.parent_id` と `page_parent_idx` を追加する。SQLite には `ADD COLUMN IF NOT EXISTS` がないため、runner は `PRAGMA table_info(page)` で `parent_id` の有無を確認し、未追加のときだけ `ALTER TABLE` を含める。`0002_directory.sql` を Wrangler で単体再適用しない（アプリの `meta` marker と Wrangler の migration 管理表は別物）。

本番適用時は次を守る。

1. 適用前に D1 のバックアップ（Time Travel の bookmark または export）を取得する。
2. 新しい Worker をデプロイし、初回リクエストで `0002_directory` を自動適用する。
3. `meta['migration:0002_directory']`、`PRAGMA table_info(page)`、`page_parent_idx` を確認する。
4. 既存ページがすべて `parent_id IS NULL` のままであることを確認する。

`ON DELETE SET NULL` は `PRAGMA foreign_keys` が有効な接続でだけ動く。D1 / celld の本番挙動は spike で確認する。

## ロールバック

`workflow_dispatch` の `ref` に戻したい commit SHA を指定して再デプロイする。

- D1 のスキーマや本文、Durable Object の状態は自動では戻らない
- R2 の object versioning は前提にしていない。有効化状況は zoo2-infra 側の設定を確認し、データの巻き戻しは別途バックアップから行う
- アプリケーションのロールバックとデータの復旧は分けて判断する

## セキュリティ

- secrets は GitHub Environment `production` にだけ置き、リポジトリや `.dev.vars` に書かない
- `.dev.vars` と `dist/` は Git 管理外
- 本番ビルドに `ZEEE_DEV_AUTH` を入れない（deploy workflow でも検証している）
- credential をローテーションしたら Environment secrets を更新し、`workflow_dispatch` で再デプロイする
