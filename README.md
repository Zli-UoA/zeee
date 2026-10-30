# Zeee

Zli sharEd knowlEdgE。Zli のメンバーが使う、esa 的な Markdown ドキュメントツール。

現在は celld を使った共同編集のスパイク。設計判断・検証範囲・未確定事項は [docs/spike.md](docs/spike.md) にまとめている。

## できること

- AuthZ OIDC（public client + PKCE S256）でログイン
- ページの作成・一覧・タイトル変更・削除（soft delete）
- CodeMirror 6 + Yjs の Markdown 共同編集
- 1 ページ = 1 Durable Object。本文は DO の SQLite に保存
- D1 の本文 materialize と FTS5 trigram による日本語検索
- 10 分ごとの自動 revision、手動保存、任意の版への restore
- celld dev を再起動しても本文が残る

コメント、添付、通知、タグ、スペース、ページ単位 ACL はまだない。編集権限は「ログインした全員が全ページを編集」で、AuthZ グループによる絞り込みもしない。

## 開発

Vite+ 1.4.0 / Vite 8.3.5 / pnpm 12.16.1。CodeMirror は Markdown ソースをそのまま編集する。

```sh
pnpm install
pnpm dev        # Vite+ + workerd
pnpm check      # vp check + tsc
pnpm test       # Vitest
pnpm spike      # celld dev で共同編集・検索・履歴・再起動を確認
```

## celld で動かす

```sh
pnpm build:celld

printf 'ZEEE_DEV_AUTH=1\nPUBLIC_ORIGIN=http://127.0.0.1:9876\n' > dist/.dev.vars
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" celld dev dist
```

[開発画面](http://127.0.0.1:9876/auth/dev?name=alice&next=/) を開く。`dist` が唯一の成果物で、生成物は手で書き換えない。

## AuthZ

public client + PKCE S256 + RS256。実値は deployment 側に置き、リポジトリには入れない。

- `AUTHZ_ISSUER`
- `AUTHZ_CLIENT_ID`
- `PUBLIC_ORIGIN`
- client の redirect は `${PUBLIC_ORIGIN}/auth/callback`、post logout は `${PUBLIC_ORIGIN}/`
- scope は `openid profile`

ローカルだけ `/auth/dev` を使う。`ZEEE_DEV_AUTH=1` と `PUBLIC_ORIGIN=http://127.0.0.1:9876` を `.dev.vars` に置く。本番では `ZEEE_DEV_AUTH` を設定しない。

## 構成

```text
Browser
  │ HTTPS / WSS
  ▼
Cloudflare → Traefik → celld (Worker + PageRoom DO)
                         ├─ D1: users / sessions / pages / revisions / search
                         └─ R2: deployments / DO SQLite / D1
```

- 本文は Yjs。メタデータ・revision・検索は D1
- 本番の R2 bucket / endpoint / credential は private な infra 側で管理する
- celld の Worker 名と DO クラス名は固定。変更すると DO ID が変わる

## 検証と制約

- celld 0.6.2。`celld deploy` / `celld dev` と Durable Object SQLite を使う
- R2 は celld の qualified store。`celld diagnose` は pass 済み
- R2 に object versioning はない。backup は D1 + Markdown の論理 export と別 bucket で設計する
- 本番配備、実 AuthZ token exchange、2 ノード運用は未検証
