# Zeee

Zli sharEd knowlEdgE。Zli のメンバーが使う、esa 的な Markdown ドキュメントツール。

いまは **celld を使った共同編集のスパイク**。本番配備はまだない。設計判断と検証範囲は [docs/spike.md](docs/spike.md) にまとめている。

## 動くもの

- AuthZ OIDC（authorization code + PKCE、public client）でログイン
- ローカル開発用の `/auth/dev`（`ZEEE_DEV_AUTH=1` のときだけ）
- ページの作成・一覧・タイトル変更・削除（soft delete）
- CodeMirror 6 + Yjs の Markdown 共同編集
- 1 ページ = 1 Durable Object。Yjs の更新は DO の SQLite に保存
- D1 の本文 materialize と FTS5 trigram による日本語検索
- 10 分ごとの自動 revision、手動の「版を保存」、任意の版への restore
- celld dev を再起動しても本文が残る

コメント、添付、通知、タグ、スペース、ページ単位 ACL はまだない。編集権限は「ログインした全員が全ページを編集」で、AuthZ グループによる絞り込みもしない。

## 動かす

```sh
pnpm install
pnpm build:celld
mkdir -p dist
printf 'ZEEE_DEV_AUTH=1\nPUBLIC_ORIGIN=http://127.0.0.1:9876\n' > dist/.dev.vars
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" celld dev dist
```

[開発画面](http://127.0.0.1:9876/auth/dev?name=alice&next=/) を開く。`/auth/login` は AuthZ の実クライアント設定がないと 503 になる。

`pnpm dev` は Vite+（`vp dev`）+ workerd（HMR）。`pnpm dev:celld` はビルド watch と `celld dev` を同時に起動する。`dev:celld` でも `dist/.dev.vars` に `ZEEE_DEV_AUTH=1` と `PUBLIC_ORIGIN=http://127.0.0.1:9876` を置くこと。

## Toolchain

Vite+ 1.4.0（Vite 8.3.5 / Vitest 5.0.5 / Oxlint / Oxfmt / Rolldown）と pnpm 12.16.1。`vite` は `@voidzero-dev/vite-plus-core` に alias し、`vite-plus` を devDependency に持つ。

- `pnpm dev` / `pnpm build` = `vp dev` / `vp build`
- `pnpm check` = `vp check`（format / lint / type）+ `tsc --noEmit`
- `pnpm test` = `vp test`（Vitest 5。test mode では Void / Cloudflare のプラグインを外す）
- `pnpm spike` = `build:celld` + `celld dev` の統合確認
- `build:celld` / `watch:celld` は celld 用の env を付けて `vp build` する

## スパイク検証

```sh
pnpm check
pnpm test
pnpm spike
```

`pnpm spike` は `pnpm build:celld` のあと、`celld dev` を 9877 で起動して次を確認する。

- `/auth/dev` でセッションを作る
- 2 つの WebSocket クライアントが同じページに書き込んで収束する
- D1 の本文と FTS5 検索に反映される
- 手動 revision と restore が動く
- `celld dev` を再起動しても Yjs の本文が残る

## AuthZ に繋ぐ

AuthZ の **public client** は登録済み。`client_id` と issuer は `void.config.ts` の `vars` に置いている。

- client_id: `ocfGoISXBgnRMqogOLEdYsZUXusTBczV`
- redirect: `https://zeee.zli.works/auth/callback`
- post logout: `https://zeee.zli.works/`
- scope: `openid profile`
- PKCE S256 / RS256

本番では `PUBLIC_ORIGIN` を設定する。

```text
PUBLIC_ORIGIN=https://zeee.zli.works
```

celld は既定で `X-Forwarded-*` を信用しないため、Traefik / Cloudflare Tunnel の後ろではこれがないと redirect URI がずれる。`ZEEE_DEV_AUTH` は本番では設定しない。

ローカルで実 AuthZ のログインまで試す場合は、AuthZ の client に `http://127.0.0.1:9876/auth/callback` を追加し、`.dev.vars` に `PUBLIC_ORIGIN=http://127.0.0.1:9876` を入れる。開発用の `/auth/dev` を使うなら不要。

## 名前変更に伴う外部更新

プロダクト名を Zen から **Zeee** に変更した。コードと local 設定は更新済み。外部で次を更新する。

- AuthZ client: 表示名を `Zeee`、redirect を `https://zeee.zli.works/auth/callback`、post logout を `https://zeee.zli.works/` に変更。client_id はそのまま
- Cloudflare Tunnel / DNS: `zeee.zli.works`
- R2 bucket: `zeee-fleet`
- GitHub repository: `Zli-UoA/zeee`
- Worker 名は `zen` から `zeee` に変更した。DO の ID は Worker 名に依存するため、本番データを作る前に実施した。ローカルの古い状態は `rm -rf dist/.celld` で捨てられる

## R2

- bucket: `zeee-fleet`
- endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- region: `auto`
- credential: Account API token（Object Read & Write、`zeee-fleet` のみ）
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` は k8s Secret と GitHub Actions にだけ置く
- R2 に object versioning はない。fleet bucket に bucket lock は付けない

storage test:

```sh
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export AWS_REGION=auto
export S3_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com'

celld diagnose   --bucket s3://zeee-fleet   --endpoint "$S3_ENDPOINT"   --region "$AWS_REGION"
```

## 構成

```text
Browser
  │ HTTPS / WSS
  ▼
Cloudflare → Traefik → celld (Worker + Durable Object)
                         ├─ D1 zeee: users / sessions / pages / bodies / revisions / FTS
                         └─ PageRoom DO: Yjs + SQLite snapshot/update
```

`voidCelld()` が `dist/ssr/wrangler.json` から celld 用の `dist/wrangler.json` を生成する。`dist` が唯一の成果物で、生成物は手で書き換えない。

## 検証と制約

- celld は 0.6.2。`celld deploy` / `celld dev` と Durable Object SQLite を使う。
- celld-operator は使わない。本番は StatefulSet を自分で持つ前提（manifest は未作成）。
- 本番の durability はまず `CELLD_DURABILITY=bucket` で 2 pods。R2 が必要。zli の Garage は conditional write 非対応なので使えない。
- celld の R2 は fleet bucket 内の `r2/<bucket_name>/` に置かれる。
- R2 は object versioning 非対応。backup は D1 + Markdown の論理 export と別 bucket の bucket lock で設計する。fleet bucket に bucket lock を付けると celld の ownership / deploy が壊れるので付けない。
- AuthZ の実 OIDC 交換、2 ノード fleet、Cloudflare / Traefik 越しの WSS、`celld d1 migrations apply` の実行経路は未検証。R2 の storage test は `celld diagnose` で pass。
- 詳細と次の作業は [docs/spike.md](docs/spike.md)。
