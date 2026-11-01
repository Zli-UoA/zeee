# Wave 3.1 Scale

`99bb3a4` を起点とするページ一覧・検索の keyset pagination。OFFSET は使用しない。

## API contract

認証は従来どおり必須（未ログインは 401）。既存の `pages` / `results` 配列キーを維持し、ページ情報を追加する。

- `GET /api/pages?sort=updated|created|title&limit=50&cursor=...`
  - `{ pages: PageSummary[], sort, limit, nextCursor: string | null }`
  - 既定は `sort=updated`, `limit=50`。
- `GET /api/search?q=...&limit=20&cursor=...`
  - `{ query: string, results: SearchResult[], limit, nextCursor: string | null }`
  - `query` は trim 後。空白のみは空配列。最大500 UTF-16 code units。
  - 既定 `limit=20`。3文字以上は従来の FTS phrase / 関連度順、短語は LIKE / 更新順。LIKE の `%` / `_` の既存ワイルドカード動作も維持する。
  - FTS を利用できない最初の要求は LIKE にフォールバック。cursor は方式も保持し、途中で方式を切り替えない。FTS continuation の DB 障害は通常のサーバーエラーになる。
- `GET /api/trash?limit=50&cursor=...`
  - `{ pages: DeletedPageSummary[], limit, nextCursor: string | null }`
  - 削除日時の降順。同時刻は ID 昇順。

`limit` は1〜100の整数。`nextCursor=null` は終端。続きは返された cursor をそのまま渡し、検索語・並び順を変えたら cursor を捨てる。途中で limit を変えてもよい。総件数は返さない。改ざん・破損・異なる検索語／sort・形式の異なる cursor、不正な limit / sort は 400 `{ error: string }`。cursor は不透明な versioned base64url で、認可トークンではない（すべての取得で認証する）。

`PageSummary` / `PageRecord` / `DeletedPageSummary` / `SearchResult` は `updatedBy: string | null`, `updatedByName: string` を持つ。名前不明は空文字、画面では「不明なユーザー」。`createdByName` は作成者として維持する。更新順・タイトル順・検索結果・ゴミ箱では最終更新者、作成順では作成者を表示する。

## 順序・loader contract

- 更新順: `updated_at DESC, created_at DESC, id ASC`。
- 作成順: `created_at DESC, updated_at DESC, id ASC`。
- タイトル順: 既存の `Intl.Collator('ja', { numeric: true, sensitivity: 'base' })`、更新日時降順、ID 順。SQLite の BINARY / NOCASE に置き換えない。
- FTS 検索: `rank ASC, id ASC`。LIKE 検索: `updated_at DESC, id ASC`。
- cursor は境界値そのものを保持するため、境界ページを削除しても続行できる。

DB の `listPages`, `searchPages`, `listDeletedPages` は `{ items, nextCursor, limit }` を返す。`/` loader は API と同じ URL パラメーターを受け、現在の `pages` または `results`、`cursor`, `nextCursor`, `limit` を返す。検索と sort の変更は最初から取得する。件数表示は現在のページの件数であり、全件数を装わない。日付グループ・抜粋・検索ハイライトは維持する。「次のページ」「最初のページ」とブラウザの戻るで移動でき、URL は再読み込み可能。

`sidebarPages` / ページ詳細・ゴミ箱 loader の `pages` は全 active page の軽量 `PageNavigation[]`（id/title/updatedAt）。本文や作者は含まない。最近見たページの照合とサイドバーを、現在の表示範囲や検索条件から独立させる。リンク候補・別名も200件制限を撤去する。既存の別名解決で足りるため `page_link` は追加しない。

## Migration と適用

`migrations/0001_scale.sql` は追加のみで、既存ユーザー・セッション・本文・履歴・別名を削除／再作成しない。`page_last_editor`、active page の複合索引、削除日時索引、rename audit の索引を追加する。最終更新者は記録された最新の revision / rename audit から補完し、記録がなければ作成者を使う。revision の author が null の場合は不明のまま。実行済みの更新者行を再実行で上書きしない。

アプリの `ensureSchema` は従来の基礎スキーマを準備後、`meta['migration:0001_scale']` がなければ SQL 全文を D1 `batch` で実行する。マーカーも同じ transaction に含めるため失敗時は全体を戻し、次回要求で再試行する。DB binding ごとに初期化をキャッシュする。celld の既存デプロイ経路もこの自動適用で動作する。新規 DB でも先に基礎テーブルが作られる。

既存の Cloudflare D1 へ事前適用する場合は、対象 DB のバックアップを確保してから、ビルド済み構成に対して運用者が実行する:

```sh
pnpm build:celld
pnpm exec wrangler d1 migrations apply DB --remote --config dist/wrangler.json
```

`migrations_dir` を構成し、celld build に `dist/migrations/DB/0001_scale.sql` が含まれる。空の DB に SQL ファイル単独を適用する場合は先に既存の基礎スキーマが必要。自動適用済み DB への Wrangler 適用も SQL が再実行可能なため安全。Wrangler の migration 管理表とアプリの meta マーカーは別物。適用の一般仕様は [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) を参照。

ロールバックはアプリの旧版へ戻し、追加テーブル・索引は残す。旧版は更新者表を更新しないので、旧版稼働中の編集者情報は再デプロイだけでは補完されない。必要ならその期間の revision / audit から別途復旧する。本 PR では本番 migration / デプロイは実行しない。

本文の更新者は認証済み WebSocket attachment または replace API のユーザーを使い、クライアント申告の actor は使わない。Durable Object 内の `doc_actor` に保存し、hibernation / snapshot compaction 後も保持する。旧接続で attachment がない場合は不明として扱い、再接続後に確定する。内容不変の snapshot / alarm は直近のタイトル変更者を上書きしない。

## 性能・残る制約

- 更新順・作成順は複合索引で範囲検索し `limit + 1` 行だけ取得する。
- タイトル順は D1 に JavaScript の ICU 照合順序を登録できないため、全件の薄いタイトル情報を比較して境界より後を選ぶ。本文の取得は最大 limit 件。タイトル順の計算と、全件表示を維持するサイドバー／リンク候補は引き続き件数に比例した負荷がある。非常に大きなデータセットには永続的な照合キー・ナビゲーションの追加読み込みが別途必要。
- FTS の rank 計算／LIKE の部分一致は検索候補数に依存する。ページ分割は検索エンジン自体の全負荷を一定にはしない。
- snapshot isolation は提供しない。閲覧中に更新日時・タイトル・検索 rank が変わると、境界をまたいだページが再登場／未表示になる可能性がある。最初から再取得すると現在の順序に戻る。
- 既存データの更新者は残っている履歴からの復元なので、未記録の過去の編集者は厳密に再現できない。
- 初回 migration の索引作成・backfill は DB サイズに応じて時間がかかる。大規模 DB は本番コピーで所要時間を測り、事前適用する。

## 検証

SQLite/FTS5 統合テストで267件の全順序走査、同値境界、削除された境界、FTS / LIKE、認証と400、loader・recent sidebar、更新者、migration 再実行・rollback/retry を検証。`EXPLAIN QUERY PLAN` で更新順／作成順の索引 range seek を検証する。PageRoom テストで actor 偽装の無視、再起動後の保持、snapshot の作者分離を検証する。

ブラウザとローカル D1 でも205件作成して一覧／検索 API、タイトル自然順、ページ送り、更新者表示を確認する。`pnpm check` / `pnpm test` / `pnpm build:celld` を実行する。本番 D1 上の負荷試験は含まない。
