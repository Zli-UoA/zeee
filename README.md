# Zeee

Zli sharEd knowlEdgE。Zli のメンバー向けの、esa 的な Markdown ドキュメントツール。

本番: <https://zeee.zli.works>

## 機能

- AuthZ OIDC（public client + PKCE S256）でログイン。ローカルでは `/auth/dev` を使える
- ページの作成・一覧・タイトル変更・削除（ソフトデリート）
- CodeMirror 6 + Yjs + Durable Object による共同編集と在席表示
- Markdown の閲覧 / 編集ビュー。GFM、コードハイライト、目次（TOC）
- `[[ページ名]]` の内部リンクとバックリンク。未作成ページはその場で作成できる
- D1 FTS5（trigram）による検索。2 文字以下は LIKE にフォールバック
- コマンドパレット（`⌘K` / `Ctrl+K`）。検索・新規作成・最近見たページ
- 最近見たページのサイドバー表示（ユーザーごとにブラウザ保存）
- 10 分ごとの自動 revision、手動保存、履歴のプレビューと復元
- ゴミ箱。削除済みページの復元と完全削除
- デスクトップ / モバイルのレスポンシブなサイドバーとナビゲーション

コメント、添付、通知、タグ、スペース、ページツリー、ページ単位 ACL はまだない。ログインした全員が全ページを編集できる。

## ローカル開発

必要なもの:

- Node.js 24.11 以上
- pnpm 12.16.1
- celld 0.6.2（`celld dev` を使う場合）

```sh
pnpm install

mkdir -p dist
printf 'ZEEE_DEV_AUTH=1\nPUBLIC_ORIGIN=http://127.0.0.1:9876\n' > dist/.dev.vars

pnpm dev:celld
```

<http://127.0.0.1:9876/auth/dev?name=alice&next=/> を開くと開発用セッションが作られる。`pnpm dev:celld` は celld 用のビルド、watch、`celld dev` をまとめて起動する。

`celld` が `CELLD_ESBUILD` の相対パスを解決できない環境では、絶対パスで直接起動する。

```sh
pnpm build:celld
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" celld dev dist
```

- `.dev.vars` と `dist/` は Git 管理外。`ZEEE_DEV_AUTH` は本番に含めない
- `dist` はビルド成果物。生成物を直接編集しない
- D1 のスキーマは初回アクセス時に作成される

## 検証

```sh
pnpm check       # フォーマット / lint / 型チェック（vp check + tsc）
pnpm test        # 単体テスト
pnpm build:celld # 本番と同じ celld 向けビルド
```

`pnpm spike` を使うと、celld を起動して共同編集・検索・履歴・再起動後の保持まで確認できる。celld が必要。

## CI / CD

### CI

`.github/workflows/ci.yml`。GitHub-hosted の `ubuntu-latest` で、PR と `main` への push、手動実行時に動く。

1. Node.js 24.11.0 / pnpm 12.16.1 をセットアップ
2. `pnpm install --frozen-lockfile`
3. `pnpm check`
4. `pnpm test`
5. `pnpm build:celld`

### CD

`.github/workflows/deploy.yml`。CI が `main` で成功したあと、または `workflow_dispatch` で本番へデプロイする。`workflow_dispatch` には任意の `ref` 入力を渡せる。

- GitHub Environment `production` を使用
- Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- Vars: `CELLD_BUCKET`, `S3_ENDPOINT`, `AWS_REGION`（未設定時は workflow 内の既定値）
- `pnpm build:celld` の成果物を検証してから `celld deploy dist` を実行
- デプロイ後に `https://zeee.zli.works/api/health` を最大 30 回確認

R2 の secrets が未設定の場合、deploy は失敗ではなく skip され、GitHub Actions の Summary に案内が出る。初回は Environment `production` の secrets を設定したうえで `workflow_dispatch` を実行する。

本番 URL は <https://zeee.zli.works>。R2 bucket、D1、celld の StatefulSet、Traefik、Cloudflare Tunnel などのインフラは [zoo2-infra](https://github.com/Zli-UoA/zoo2-infra) 側で管理する。このリポジトリはアプリケーションとデプロイ定義だけを持つ。

秘密情報や実際の credential はリポジトリに置かない。運用手順は [docs/operations.md](docs/operations.md) を参照。

## 構成

```text
Browser
  │ HTTPS / WSS
  ▼
Cloudflare → Traefik → celld (Worker + PageRoom Durable Object)
                         ├─ D1: users / sessions / pages / revisions / search
                         └─ R2: deployments / DO SQLite / D1
```

- 本文は Yjs の `Y.Text`。メタデータ、revision、検索は D1
- 1 ページ = 1 Durable Object。Worker 名と DO クラス名は固定
- 設計判断と制約は [docs/spike.md](docs/spike.md)
