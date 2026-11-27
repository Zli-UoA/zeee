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

## ページパス一意性 migration（0002_path_uniqueness）

ページタイトルは `/` 区切りのパスとして扱う。`migrations/0002_path_uniqueness.sql` は次を DB で保証する。

- active なページの完全重複を禁止する partial unique index
- active なページの prefix 衝突（`a` と `a/b`）を禁止する INSERT / title UPDATE / deleted_at UPDATE の trigger
- 削除済みページは対象外。復元（`deleted_at` を `NULL` に戻す UPDATE）時に再チェックする

既存データは自動改名しない。適用前に次の監査 SQL を実行し、1 行でも返ったら migration を適用せず、対象ページを手動で改名・整理する。

完全重複:

```sql
SELECT title, count(*) AS n, group_concat(id) AS ids
FROM page
WHERE deleted_at IS NULL
GROUP BY title
HAVING count(*) > 1
ORDER BY title;
```

prefix 衝突（`p.title` と `q.title` のどちらかが親パス）:

```sql
SELECT p.id AS ancestor_id, p.title AS ancestor_path,
       q.id AS descendant_id, q.title AS descendant_path
FROM page p
JOIN page q
  ON q.id > p.id
 AND p.deleted_at IS NULL
 AND q.deleted_at IS NULL
 AND (
   substr(q.title, 1, length(p.title) + 1) = p.title || '/'
   OR substr(p.title, 1, length(q.title) + 1) = q.title || '/'
 )
ORDER BY p.title, q.title;
```

手順:

1. D1 のバックアップを取得する。
2. 上の 2 つの監査 SQL を実行する。結果が空であることを確認する。
3. 結果がある場合は **blocker** として扱い、デプロイを止める。`page_alias` を残したまま、対象ページのタイトルを手動で変更する。自動改名はしない。
4. アプリをデプロイする。`ensureSchema` が `0001_scale` の後に `0002_path_uniqueness` を適用する。
5. `SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness';` が `1` になることを確認する。
6. migration が衝突で失敗した場合、D1 batch は rollback され marker は立たない。監査 SQL で対象を直してから再デプロイする（`schemaPromises` は失敗時にキャッシュを破棄するため、同じ isolate でも再試行される）。

migration 自体も、既存の active ページに完全重複または prefix 衝突がある場合は `PATH_CONFLICT: existing active page paths conflict` で安全に失敗する。この場合、index / trigger / marker は作られない。

API では `createPage`、`updatePageTitle`、undelete の衝突を `409` と `{ "error": "PATH_CONFLICT" }` で返す。パス構文の違反（空、先頭・末尾 `/`、空セグメント、空白のみのセグメント、200 文字超）は `400` と `{ "error": "INVALID_PATH" }` で返す。既存の 401 / 403 / 404 は変更しない。

## 失敗時の確認

- `pnpm check` / `pnpm test` / `pnpm build:celld` の失敗: CI と同じ手順をローカルで再現する
- `dist/wrangler.json` の検証失敗: `void.config.ts` と celld 用ビルド設定を確認する
- R2 secrets の skip: Environment `production` の secrets 名を確認する
- `celld deploy` の失敗: R2 の credential / bucket / endpoint と celld の状態を確認する
- health check の失敗: 30 回のリトライ後も `/api/health` が通らない場合、デプロイは失敗扱い。celld / ingress / tunnel の状態を確認する

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

## 移行前バックアップ（workerd 移行の前提条件）

移行前に **D1 の論理ダンプ** と **各ページの Durable Object (DO) 内 Yjs 生 state** の2種類を取得する。D1 にはユーザー・セッション（トークンを含む）・本文・リビジョンといった PII が入るため、保存先はリポジトリ外の暗号化済みディスクに限定し、以下を守る。

- ダンプを Git 管理下（`dist/` 含む）に置かない。ファイルモードは `chmod 600` にする
- セッショントークンはそのまま他人のログインに使える。バックアップ自体を credential と同等に扱う
- 取得後は暗号化して保管し、リハーサル完了後に消す。保持期間を決めておく
- コマンド中のトークンや実ホスト名をシェル履歴・Issue・PR に貼らない。環境変数名だけを残す

### D1 の論理ダンプ

`dist/wrangler.json` の D1 binding 名は `DB`。Wrangler は対象アカウントへの認証済みであること（credential はリポジトリに置かない）。以降の Wrangler 呼び出しは [docs/scale.md](scale.md) と同じく `pnpm exec wrangler` を使う。

本番 D1 には仮想テーブル `page_fts`（FTS5 trigram、`src/server/schema.ts`）が必ず存在する。既定 compatibility の `wrangler d1 export` は仮想テーブル込みの DB をエクスポートできない。**可能になったのは 2026-11-12 の changelog で `--compatibility sqlite3_cli_only` が追加されたとき**で、`wrangler >= 4.159.0` かつ `--remote` 専用。非対話実行のため `-y` も付ける。

```sh
# wrangler >= 4.159.0 / --compatibility sqlite3_cli_only は --remote 専用
pnpm exec wrangler d1 export DB --remote --config dist/wrangler.json \
  --compatibility sqlite3_cli_only -y --output "$BACKUP_DIR/d1.sql"
```

`sqlite3_cli_only` のダンプは `PRAGMA writable_schema=ON` と `INSERT INTO sqlite_schema` を含む。**`page_fts` と shadow テーブルの DDL/INSERT だけを除去すると再投入が `SQLITE_AUTH` で止まる**ので、前処理では次もすべて無効化する。

- `PRAGMA writable_schema=ON` / `PRAGMA writable_schema=OFF`
- `sqlite_schema` / `sqlite_master` への `INSERT` / `UPDATE` / `DELETE`
- `page_fts` と shadow テーブル（`page_fts_data` / `page_fts_idx` / `page_fts_content` / `page_fts_docsize` / `page_fts_config`）の DDL / INSERT / DELETE

行単位の例（ダンプを目視確認してから適用し、生成結果を確認する）:

```sh
sed -E \
  -e '/PRAGMA writable_schema/I s/^/-- /' \
  -e '/(INSERT|UPDATE|DELETE).* (sqlite_schema|sqlite_master)/I s/^/-- /' \
  -e '/(CREATE VIRTUAL TABLE|INSERT INTO|DELETE FROM|DROP TABLE).*page_fts(_(data|idx|content|docsize|config))?/I s/^/-- /' \
  "$BACKUP_DIR/d1.sql" > "$BACKUP_DIR/d1.clean.sql"
```

前処理済み SQL をリストア先の空の D1 に流す（`d1 import` は使わない）:

```sh
pnpm exec wrangler d1 execute DB --remote --config dist/wrangler.json --file "$BACKUP_DIR/d1.clean.sql"
```

`page_body` から FTS を再構築する。FTS5 の `rebuild` は **仮想テーブル本体 `page_fts` を指定する**（`page_fts_data` などの shadow テーブル名を指定しない）。trigram tokenizer が使えない環境では `tokenize='trigram'` を外した DDL（`src/server/schema.ts` の fallback と同じ）を使う。

```sql
-- 仮想テーブルは D1 のダンプから import できないので作り直す
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts
  USING fts5(page_id UNINDEXED, title, body, tokenize='trigram');

-- page_body を正として再投入（削除済みページは対象外）
DELETE FROM page_fts;
INSERT INTO page_fts (page_id, title, body)
SELECT p.id, p.title, COALESCE(b.markdown, '')
FROM page p
LEFT JOIN page_body b ON b.page_id = p.id
WHERE p.deleted_at IS NULL;

-- FTS5 の実テーブル名は page_fts。インデックスを作り直す
INSERT INTO page_fts(page_fts) VALUES('rebuild');
-- 必要なら低頻度で optimize も実行: INSERT INTO page_fts(page_fts) VALUES('optimize');
```

復元後、`SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness';` が `1` であることと、検索がヒットすることを確認する。

### DO の Yjs 生 state のエクスポート

`scripts/export-do-state.mjs` が `GET /api/pages` と `GET /api/trash` の cursor をそれぞれ辿って ID を統合列挙し、各 `GET /api/pages/:id/state` の `application/octet-stream` を `<outdir>/<pageId>.yjs` に保存する。`/api/pages` は `deleted_at IS NULL` の active のみを返すが、`softDeletePage` は DO の state を消さないため、ゴミ箱のページの生 update（クライアント ID / undo 履歴）も対象に含める。4xx は即座に失敗、ネットワークエラー / 429 / 5xx は再試行する（既定 2 回、`--retries` で変更）。

各ファイルの ID・バイト数・SHA-256 を `<outdir>/manifest.json` に記録する。再実行時は内容が一致するファイルをスキップし、不一致（stale）なファイルは再取得して上書きする。書き込みは一時ファイル + rename の atomic write なので途中で切れても出力が壊れない。途中失敗時は `N/M` の進捗を表示し、完了済みファイルは次回実行で再利用される。

```sh
export ZEEE_BASE_URL='https://<deployment-host>'
# ブラウザの DevTools から Cookie ヘッダー値（zeee_session=... / __Host-zeee_session=...）をコピー
export ZEEE_SESSION_COOKIE='<cookie-header-value>'

node scripts/export-do-state.mjs --out "$BACKUP_DIR/state" --dry-run   # ID と保存先だけ確認
node scripts/export-do-state.mjs --out "$BACKUP_DIR/state"             # active + ゴミ箱を書き出し
# pnpm backup:state -- --out "$BACKUP_DIR/state" --limit 10 でも実行可能（active 優先）
```

ローカル開発（`ZEEE_DEV_AUTH=1`）ではセッション cookie をスクリプトが `GET /auth/dev` から取得する。**loopback（localhost / 127.0.0.1 / ::1）以外に `ZEEE_DEV_AUTH=1` を渡してはならない**。`ZEEE_DEV_AUTH` は `void.config.ts` に定義されていない（deploy workflow が `Object.hasOwn(config.vars, 'ZEEE_DEV_AUTH')` でキーの存在自体を拒否する）。ローカルの `dist/.dev.vars` だけで使い、本番ビルド・本番デプロイには絶対に含めない。

```sh
ZEEE_BASE_URL='http://127.0.0.1:8787' ZEEE_DEV_AUTH=1 \
  node scripts/export-do-state.mjs --out "$BACKUP_DIR/state" --dry-run
```

エクスポートした `.yjs` は元の Yjs クライアント ID / undo 履歴を含む生 update なので、`/replace`（Markdown のみ）で取り込むと失われる。必ず次の `/import-state` を使う。

### Yjs state の復元

`/api/pages/:id/import-state` は移行専用エンドポイント。`void.config.ts` は `ZEEE_MIGRATION_IMPORT: ''` をハードコードしているので、一時的な移行デプロイではビルド後に `dist/wrangler.json` をパッチして celld から直接デプロイする。**本番 deploy workflow の `workflow_dispatch` は使わない**（本番 config の検証に当たり、PR #42 のガードで失敗する）。完了後は移行デプロイを停止し、通常のビルドに戻す。フラグが `1` でないデプロイでは 404 になる。

```sh
pnpm build:celld
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const path = "dist/wrangler.json";
const config = JSON.parse(readFileSync(path, "utf8"));
config.vars.ZEEE_MIGRATION_IMPORT = "1";
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
'
celld deploy dist
```

`dist/wrangler.json` は Git 管理外の一時生成物。パッチした config を本番 deploy に流用しない。

**重要**: import 前にそのページへの WebSocket 接続をすべて切る。接続が残っていると DO が `409 close websockets before importing` を返す（旧クライアントの update と混ざらないための意図的な拒否）。ページを開いているブラウザ・エディタを閉じ、トラフィックを止めてから実行する。

```sh
set -euo pipefail

# Origin は PUBLIC_ORIGIN と完全一致させる。末尾の / を落とす。
BASE_URL="${ZEEE_BASE_URL%/}"
ORIGIN="$BASE_URL"
FAILURES="$BACKUP_DIR/import-failures.txt"
: > "$FAILURES"

for file in "$BACKUP_DIR/state"/*.yjs; do
  [ -e "$file" ] || continue
  id=$(basename "$file" .yjs)
  ok=0
  for attempt in 1 2 3 4; do
    # 409 を判定するため --fail-with-body は使わず HTTP ステータスを取得する
    code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      -X POST \
      -H "Cookie: $ZEEE_SESSION_COOKIE" \
      -H "Origin: $ORIGIN" \
      -H 'Content-Type: application/octet-stream' \
      --data-binary "@$file" \
      "$BASE_URL/api/pages/$id/import-state") || {
        echo "curl error for $id" >&2
        break
      }
    case "$code" in
      2*) ok=1; break ;;
      409) sleep "$((attempt * 2))" ;; # WebSocket が残っている場合だけ backoff
      *) echo "$id: HTTP $code" >&2; break ;;
    esac
  done
  if [ "$ok" -ne 1 ]; then
    echo "$id" >> "$FAILURES"
  fi
done

if [ -s "$FAILURES" ]; then
  echo "failed imports recorded in $FAILURES" >&2
  exit 1
fi
```

- `409 close websockets before importing` のみ backoff リトライする。401 / 403 / 404 / 400 / 413 はリトライせず失敗として記録する。
- `set -euo pipefail` で想定外のコマンド失敗を止めつつ、失敗ページは `import-failures.txt` に残して最後に非ゼロ終了する。`--fail-with-body` は 409 判定に必要なステータスコードを隠すので使わない。
- `ZEEE_BASE_URL` が `/` で終わると `Origin` が `PUBLIC_ORIGIN` と一致せず 403 になる。`${ZEEE_BASE_URL%/}` で除去する。

1 リクエストあたり最大 5 MiB / 30 秒（超過は 413、不正な update は 400）。すべての試行は `page.state_import` 監査ログに残る。取り込み後は `GET /api/pages/:id/state` が元のバイト列と一致することと、ページ本文が表示されることを確認してから移行デプロイを停止する。
