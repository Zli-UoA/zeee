# ページディレクトリ設計 contract

状態: 設計のみ（実装前）。基準は `main` の `99bb3a4` と、Wave 3.1 Scale の PR #19（`feat/scale`, `139903b`）の contract。

このドキュメントは、Zeee のフラットなページ一覧に親子関係（ディレクトリ）を追加するための最小 contract を定める。コード変更、schema 変更、PR 分割の単位は末尾にまとめる。PR #19 で `listPages` の cursor 化、`listPageNavigation`、migration runner、SQLite 統合テストが入っているため、ディレクトリはそれらを前提に設計する。

## 1. 結論

| 項目                | 決定                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 階層の持ち方        | `page.parent_id`（nullable、自己参照）だけ。materialized path は使わない                                               |
| URL                 | 既存の `/pages/:id` を維持する。パス URL は導入しない                                                                  |
| 子の並び順          | 同じ親の中ではタイトル順。手動並べ替えは MVP 外                                                                        |
| 移動                | `PATCH /api/pages/:id` に `parentId` を追加。循環はサーバーで拒否                                                      |
| 親の削除            | 生存中の子がいる削除は 409 で拒否。子を先に削除または移動させる                                                        |
| 復元                | 親が存在しない / 削除済みならルートに戻す                                                                              |
| 完全削除            | 子は `ON DELETE SET NULL` でルートに戻す                                                                               |
| タイトル重複        | 許容する。Wiki リンクの解決規則は現状のまま（更新日時が新しい方）                                                      |
| 既存ページ          | すべて `parent_id = NULL` のルートとして移行。データ書き換えなし                                                       |
| ツリーの取得        | `listPageNavigation` を `parentId` 付きに拡張し、専用 `GET /api/pages/tree` を追加。`listPages` の cursor とは分離する |
| 検索 / バックリンク | ディレクトリの影響を受けない。フラットなまま                                                                           |

最重要の前提は **「ディレクトリはメタデータであり、ページの同一性・URL・Wiki リンク解決を変えない」** こと。これにより、既存の本文、履歴、共有 URL、バックリンクを壊さずに段階導入できる。

## 2. 現状の確認

- `page` は `id, title, created_by, created_at, updated_at, deleted_at` のみで、階層情報はない（`src/server/schema.ts`）。
- ページの同一性は UUID の `id`。URL は `/pages/:id`（`pages/pages/[id].server.ts`）。
- PR #19 で `PAGE_LIST_LIMIT` は撤去され、`listPages` は `PageSlice<T>`（`items`, `nextCursor`, `limit`）を返す cursor 一覧になった。`sort` は `updated` / `created` / `title`（`src/server/db.ts`, `src/server/types.ts`, `src/server/pagination.ts`）。
- PR #19 の `listPageNavigation` は、表示中のページ・sort・検索に依存せず、全 active page の `{ id, title, updatedAt }` を返す。サイドバーと最近見たページの照合に使う（`src/server/db.ts`）。
- PR #19 で `PageSummary` / `PageRecord` / `DeletedPageSummary` / `SearchResult` に `updatedBy` / `updatedByName` が追加され、`page_last_editor` に最終更新者が保存される（`src/server/types.ts`, `migrations/0001_scale.sql`）。
- Wiki リンク `[[タイトル]]` はタイトルと旧タイトル（`page_alias`）を全体で解決する。重複時は `updated_at` が新しいページを優先する（`src/markdown/wiki.ts`）。
- バックリンクはタイトル / alias の LIKE 検索で、ページ階層を見ない（`src/server/backlinks.ts`）。PR #19 でも `page_link` は導入していない。
- サイドバーは「最近見たページ」と「すべてのページ」のフラットな 2 リスト（`src/components/AppShell.tsx`）。データ源は `listPageNavigation`。
- パンくずは現状「ページ / 現在のタイトル」の 2 要素だけ（`src/components/AppShell.tsx`）。
- 削除はソフトデリート。復元と完全削除はゴミ箱から行う（`src/server/db.ts`, `pages/trash.tsx`）。
- `ensureSchema` は基礎スキーマの後に `migrations/0001_scale.sql` を適用し、`meta['migration:0001_scale']` で実行済みを判定する。marker は migration と同じ D1 `batch` に入り、失敗時は全体が rollback される（`src/server/schema.ts`）。

## 3. データモデル

### 3.1 `parent_id` を選ぶ

`page` に次の 1 列を追加する。

```sql
parent_id TEXT NULL REFERENCES page(id) ON DELETE SET NULL
```

- `NULL` はルートページ。
- 親は同じ `page` テーブルの生存ページ。
- インデックスは `(parent_id, title, id)` または `(parent_id, updated_at)` を追加する。ツリー取得と子件数チェックで使う。

materialized path（`/a/b/c` のような文字列）を選ばない理由:

1. 移動のたびに子孫の path を一括更新する必要があり、D1 の write amplification が大きい。
2. path の一意性・エスケープ・タイトル変更との整合が増える。
3. URL を `/pages/:id` のまま維持するため、path を URL に使う利点がない。
4. 循環防止は `parent_id` の祖先探索でも再帰 CTE で実装できる。

closure table も、MVP の規模と操作数では過剰。

### 3.2 マイグレーション

PR #19 の migration runner をそのまま拡張する。`ensureSchema` は次の順で動く。

1. 基礎スキーマ `SCHEMA` を `CREATE TABLE IF NOT EXISTS` で準備する。
2. `meta['migration:0001_scale']` がなければ `migrations/0001_scale.sql` を D1 `batch` で適用する。
3. ディレクトリ用に `meta['migration:0002_directory']` がなければ `migrations/0002_directory.sql` を同じ方式で適用する。

runner の contract:

- migration の SQL と marker の `INSERT` を同一の `batch` に入れる。D1 `batch` は transactional なので、途中で失敗したら marker ごと rollback され、次回リクエストで再試行される。
- `schemaPromises` は DB binding ごとに `WeakMap` でキャッシュする（#19 の方式）。グローバルな単一 Promise に戻さない。
- 適用順は `0001_scale` → `0002_directory` に固定する。directory は #19 の `page_last_editor` と索引を前提にしてよい。
- `0002_directory.sql` の内容は追加のみとする。
  - `ALTER TABLE page ADD COLUMN parent_id TEXT REFERENCES page(id) ON DELETE SET NULL`
  - `CREATE INDEX IF NOT EXISTS page_parent_idx ON page(parent_id, title, id)`
  - 既存行は `NULL` のまま（全ページがルート）。データの書き換えはしない。
- SQLite には `ADD COLUMN IF NOT EXISTS` がない。`0002` は marker で一度しか実行されないが、手動適用や将来の再実行に備え、runner 側で `PRAGMA table_info(page)` を確認し、`parent_id` が未追加のときだけ ALTER を含む batch を組む。SQL ファイル単体を Wrangler で再適用する運用はしない。
- Wrangler の `migrations_dir` に `0002_directory.sql` を追加する場合、アプリの `meta` marker と Wrangler の migration 管理表は別物であることに注意する。自動適用を正とし、Wrangler は空 DB / 事前適用のときだけ使う。両方を同じ DB に適用しない。
- `PRAGMA foreign_keys` が有効でないと `ON DELETE SET NULL` は動かない。`tests/helpers/d1.ts` は `PRAGMA foreign_keys = ON` を設定しているので、ディレクトリのテストもこの helper で FK を検証する。本番 D1 / celld の実効性は spike で確認する。
- 本番 D1 のバックアップと `0002` の適用手順は `docs/operations.md` に追記する。

### 3.3 並び順

同じ親を持つ兄弟は、次の順で決定的に並べる。

1. `title` の `localeCompare('ja', { numeric: true, sensitivity: 'base' })`
2. `updated_at DESC`
3. `id ASC`

- ルート同士も同じ規則。
- 手動のドラッグ並べ替え、`sibling_order` 列は MVP 外。必要になったら `position INTEGER NULL` を追加し、`NULL` はタイトル順にフォールバックする。
- サイドバーのツリーはこの順、一覧ページの既存 sort（更新順 / 作成順 / タイトル順）はそのまま維持する。ツリーと一覧で順序が違ってよい。

### 3.4 移動と循環防止

移動は `PATCH /api/pages/:id` の `parentId` で行う。

- `parentId: null` はルートへ移動。
- 移動先は生存ページであること。削除済みなら 404。
- 自分自身を親にできない。
- 移動先の祖先に自分が含まれる場合は 409。再帰 CTE で祖先をたどり、`pageId` が見つかったら更新しない。
- 深さ上限は 32。超える移動は 400。
- 移動は `updated_at` を変更しない（後述の Scale contract）。
- 子の `parent_id` は変更しない。サブツリーは自動的に付いてくる。

循環チェックと更新の間に別リクエストが割り込む可能性はあるが、D1 は single writer であり、Zeee の同時編集頻度では許容する。厳密にするなら `UPDATE ... WHERE NOT EXISTS (再帰 CTE で自分が祖先にいる)` の 1 文にする。

### 3.5 削除・ゴミ箱・復元

**ソフトデリート（`DELETE /api/pages/:id`）**

- 生存中の子が 1 件以上ある場合は 409 `has_children`。子の件数を返す。
- 子を先に削除するか、別の親へ移動してから削除する。
- これにより「親を消したら子も一括でゴミ箱」という暗黙の一括操作を導入しない。子の復元順序や部分復元の複雑さを避けるための意図的な制約。
- 削除されたページの `parent_id` は保持する。ゴミ箱で親子関係を表示するために使える。

**復元（`POST /api/pages/:id/undelete`）**

- 親が存在しない、または `deleted_at IS NOT NULL` の場合は `parent_id = NULL` にしてルートへ復元する。
- 復元結果に `reparentedToRoot: true` を含め、UI で「親が削除済みのためルートに戻しました」と表示する。
- 親が後から復元されても、子を自動で元の親に戻さない。必要なら手動で移動する。

**完全削除（`DELETE /api/pages/:id/permanent`）**

- 対象は削除済みページのみ（現状どおり）。
- 生存中の子がいる状態はソフトデリートの時点で作れない。
- 削除済みの子がいる場合は、`ON DELETE SET NULL` により子の `parent_id` を `NULL` にする。子はゴミ箱に残り、復元時はルートになる。
- 監査イベントは現状の `page.permanent_delete` を維持する。

この contract により、一括削除・一括復元・カスケードの新規実装を不要にする。

## 4. URL

- 正規 URL は `/pages/:id` のまま。
- パス URL（`/pages/folder/page`）は導入しない。
- タイトル変更・移動・重複タイトルで URL は変わらない。
- パンくずの各要素も `/pages/:id` へのリンクにする。
- 将来パス URL を出す場合も、`/pages/:id` を canonical とし、パスはリダイレクト用の別名に留める。

## 5. 読み取り側の contract

### 5.1 型

PR #19 の `PageNavigation` / `PageSlice<T>` を前提に、ディレクトリ用のフィールドを追加する。`PageSummary`、`PageRecord`、`DeletedPageSummary` は `parentId` を持ち、既存の `updatedBy` / `updatedByName` はそのまま維持する。

```ts
type PageNavigation = {
  id: string;
  title: string;
  parentId: string | null;
  updatedAt: number;
};

type PageSlice<T> = { items: T[]; nextCursor: string | null; limit: number };

type PageSummary = {
  // PR #19 の既存フィールド
  id: string;
  title: string;
  createdAt: number;
  createdByName: string;
  updatedBy: string | null;
  updatedByName: string;
  excerpt: string;
  updatedAt: number;
  // 追加
  parentId: string | null;
};
```

`PageBreadcrumb` は `{ id: string; title: string }` とし、ページ詳細の loader で祖先チェーンを返す。`PageTreeNode` は `PageNavigation` と同じ形（`parentId` を含む）とする。

### 5.2 ツリー取得

`listPages` は cursor 一覧であり、ツリーには使わない。PR #19 の `listPageNavigation` を `parentId` 付きに拡張し、これをツリーの唯一のデータ源にする。

- SSR の loader は `listPageNavigation(env.DB)` を呼び、`PageNavigation[]` を `AppShell` に渡す。表示中の sort / limit / cursor / 検索語に依存しない。
- クライアント側の再取得用に `GET /api/pages/tree` を追加する。返り値は `{ pages: PageTreeNode[] }`。`PageTreeNode` は `{ id, title, parentId, updatedAt }` のみで、本文・抜粋・作者は含めない。
- `GET /api/pages/tree` は cursor / limit を使わない。`listPages` / `GET /api/pages` の cursor 契約とは完全に分離する。
- PR #19 で `PAGE_LIST_LIMIT` は撤去され、`listPageNavigation` は全 active page を返す。ディレクトリは 200 件上限を再導入しない。件数に比例する負荷は #19 の既知の制約と同じで、非常に大きな規模では navigation の追加読み込みを別途設計する。
- ツリーの深さ上限は 32。`parentId` が存在しない孤児はルート扱いにする。

### 5.3 パンくず

- ページ詳細 loader で祖先を取得し、`ancestors: PageBreadcrumb[]` を返す。ルートから現在の親までを順に並べ、現在ページは含めない。
- 再帰 CTE 1 回で取得し、N+1 を避ける。深さ上限 32。
- `AppShell` は「ページ / 祖先 / 現在タイトル」を表示する。祖先が多い場合は先頭 1 件 + 省略 + 末尾 3 件に畳む。
- 祖先が見つからない（データ不整合）場合は現在の深さで打ち切る。

### 5.4 サイドバー

- 「すべてのページ」をツリー表示にする。ルートは折りたたみ可能。
- データ源は `listPageNavigation` を拡張した `PageNavigation[]`。`listPages` の現在のページや cursor には依存しない。
- 「最近見たページ」はフラットなまま。`PageNavigation` との ID 照合でタイトルを解決する。
- 展開状態はユーザーごとに `localStorage` に保存する。現在ページの祖先は自動展開する。
- 子を持つページは `aria-expanded` を持つボタン、持たないページはリンクにする。`aria-current="page"` は現状どおり。
- 削除・移動・作成後は `GET /api/pages/tree` を再取得するか、`zeee:page-moved` / `zeee:page-created` などのイベントでツリーを更新する。既存の `zeee:page-renamed` も維持する。
- ルートから外れたページ（`parent_id` が存在しないページを指す）はルート扱いにして表示し、データ不整合を隠さない。

### 5.5 一覧ページ（`/`）

- PR #19 のフラット一覧、sort、cursor / `nextCursor` は維持する。`listPages` をツリー用に転用しない。
- サイドバーのツリーは `listPageNavigation` 由来で、一覧の現在ページ・sort・検索条件から独立している。
- 各ページに任意で祖先パスを表示する場合は、ツリーから組み立てたパスを副次表示に使う。MVP では省略可。
- 一覧の action（`POST`）はルート作成のまま。子ページ作成はページ詳細またはツリーのコンテキスト操作から行う。

### 5.6 検索

- PR #19 の `searchPages`、`page_fts`、検索 cursor は変更しない。検索結果はフラットなまま。
- ディレクトリ名やパスは検索対象にしない。
- 重複タイトル対策として、将来 `SearchResult` に `parentId` / `path` を足して結果を区別できるようにする。MVP では `id` リンクで足りる。

### 5.7 バックリンク

- `listBacklinks` は変更しない。タイトル / alias のグローバル解決のまま。
- ディレクトリはバックリンクのスコープを変えない。別ディレクトリの同名ページ間でリンクが曖昧になる問題は、既存の「更新日時が新しい方」規則を維持する。
- 将来 `page_link` を導入するときも、この解決規則を共通 contract とする。

### 5.8 Wiki リンク

- `[[タイトル]]` は引き続きグローバル解決。`[[Folder/Title]]` のようなパス指定は MVP 外。
- タイトル重複は許容し、`updated_at DESC, id ASC` で決定的に解決する。現状の `createWikiResolver` は更新日時のみで比較しているため、同値時の `id` 比較を追加して決定性を上げる。
- 移動はタイトルも alias も変えないため、既存リンクに影響しない。

## 6. 既存ページの移行と重複タイトル

- 既存ページはすべて `parent_id = NULL` のルートとして移行する。本文・履歴・alias・FTS は変更しない。
- `page.title` に UNIQUE 制約は付けない。同名ページは許可する。
- 新規作成時に同名チェックはしない。既存の Wiki リンク解決規則を変えないため。
- 同じ親の下でタイトルを一意にしたくなるのは、パス URL やパスリンクを導入する時の話。MVP では持ち込まない。
- タイトル変更時は既存どおり `page_alias` に旧タイトルを保存する。移動時は alias を追加しない。
- PR #19 で `listLinkTargets` の 200 件上限は撤去されている。ディレクトリはこの上限を再導入しない。alias 解決の規則も変更しない。

## 7. Wave 3.1 Scale（PR #19）との関係

PR #19（`feat/scale`）で「一覧の cursor 化」と「最終更新者」は実装済み。`page_link` は PR #19 では追加せず、既存の alias / title 解決を維持する方針。ディレクトリは次の contract を前提にする。

| 論点             | PR #19 の現状                                                                                        | ディレクトリ側の contract                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一覧 cursor      | `listPages` は `PageSlice<PageSummary>` を返し、`PAGE_LIST_LIMIT` はない                             | `listPages` をツリーに使わない。`listPageNavigation` を `parentId` 付きに拡張し、ツリー専用 `GET /api/pages/tree` を追加する                                |
| ツリーの取得     | `listPageNavigation` が全 active page の軽量カタログを返す                                           | 同じ関数に `parentId` を足し、SSR と `GET /api/pages/tree` の共通データ源にする。cursor / limit は使わない                                                  |
| ツリーの上限     | 200 件上限は撤去済み。navigation は件数に比例する                                                    | 200 件上限を再導入しない。深さ上限 32。非常に大きな規模では navigation の追加読み込みを別途設計する                                                         |
| 最終更新者       | `page_last_editor` と `updatedBy` / `updatedByName` が入る。内容不変の snapshot は作者を上書きしない | 移動は `updated_at` / `updated_by` / `page_last_editor` を変えない。復元・削除は現行の `updated_at` 更新を維持し、`page_last_editor` は変えない             |
| `page_link`      | PR #19 では追加しない。バックリンクは引き続き title / alias の LIKE 検索                             | ディレクトリも `page_link` に依存しない。将来導入する場合も、リンク解決はグローバルな title / alias 規則（`updated_at DESC, id ASC`）を共通 contract にする |
| 削除とリンク     | `page_link` がないため、現時点で削除時のリンク整合は不要                                             | 将来 `page_link` を入れる場合、完全削除は `ON DELETE CASCADE`、ソフトデリートはリンクを残して表示時に生存ページのみ解決する                                 |
| 一覧の並び       | 一覧は `updated` / `created` / `title` の cursor 順                                                  | ツリーの兄弟順はタイトル順で固定。一覧の sort / cursor とは独立させる                                                                                       |
| バックリンク     | PR #19 でも既存 `listBacklinks` を維持                                                               | ディレクトリ導入時点でも `listBacklinks` を変更しない。`page_link` への移行は別 PR                                                                          |
| schema migration | `meta['migration:0001_scale']` と D1 `batch` の migration runner                                     | `meta['migration:0002_directory']` を追加し、`0001_scale` の後に順序固定で適用する。marker は同じ batch に入れる                                            |

特に、**`listPages` の cursor 一覧とツリー表示を同じ関数に載せない**ことを最初に決める。PR #19 で `listPages` は cursor 化済みなので、ディレクトリ側は `listPageNavigation` + ツリー専用 endpoint に固定する。ここを混ぜると、ディレクトリ PR と Scale PR のどちらかが必ず手戻りになる。

## 8. API contract（実装時の最小形）

### 8.1 型

```ts
type PageNavigation = { id: string; title: string; parentId: string | null; updatedAt: number };
type PageSummary = { /* PR #19 の既存フィールド */ parentId: string | null };
type PageBreadcrumb = { id: string; title: string };
type PageTreeNode = PageNavigation;
```

### 8.2 エンドポイント

| Method   | Path                      | 変更                                                                                                                                        |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/pages`              | body に任意の `parentId`。省略時はルート。親が不正なら 400 / 404                                                                            |
| `PATCH`  | `/api/pages/:id`          | body は `{ title?: string; parentId?: string \| null }`。両方省略は 400。title がある場合は現行の 1〜200 文字検証。移動時は 400 / 404 / 409 |
| `GET`    | `/api/pages/:id`          | レスポンスに `ancestors: PageBreadcrumb[]` を追加（ページ本体は現行どおり）                                                                 |
| `GET`    | `/api/pages/tree`         | 新規。`{ pages: PageTreeNode[] }`。`listPageNavigation` を `parentId` 付きで返す。cursor / limit は使わない                                 |
| `DELETE` | `/api/pages/:id`          | 生存中の子がいれば 409 `{ error: 'has_children', childCount }`                                                                              |
| `POST`   | `/api/pages/:id/undelete` | 親が無効ならルートへ復元し、`{ ok: true, reparentedToRoot: boolean }`                                                                       |

既存の `GET /api/pages` は PR #19 の cursor 契約のまま変更しない。`GET /api/pages/tree` は一覧とは別経路で、`sort` / `cursor` / `limit` を受け取らない。

`PATCH` の title と parentId を同時に受けるのは、既存のタイトル保存経路を増やさないため。UI はどちらか片方だけを送ってよい。

### 8.3 監査

- 既存の `page.create` / `page.rename` / `page.delete` / `page.undelete` / `page.permanent_delete` を維持する。
- 移動は `page.move` を追加し、`target_id` はページ ID、親 ID は別途記録できないため `audit_event` の拡張はしない。必要なら `action = 'page.move'` のみで開始する。

## 9. frontend / backend の PR 分割

### PR 1: 設計ドキュメント（この PR）

- `docs/page-directory.md` のみ。
- コード・schema は変更しない。

### PR 2: backend contract

ブランチ例: `feat/page-directory-api`。PR #19 のマージ後、または `feat/scale` に rebase して開始する。

- `migrations/0002_directory.sql`: `parent_id`、`page_parent_idx`。追加のみ。
- `src/server/schema.ts`: `0001_scale` の後に `0002_directory` を適用する runner。`meta['migration:0002_directory']` と `PRAGMA table_info(page)` のガード。
- `src/server/types.ts`: `PageNavigation.parentId`、`PageSummary.parentId`、`PageBreadcrumb`、`PageTreeNode`。
- `src/server/db.ts`: `listPageNavigation` に `parent_id` を追加（`listPages` には触れない）、`createPage` の `parentId`、`updatePageParent`、祖先取得、子件数チェック、`undeletePage` のルート復帰、`permanentlyDeletePage` の確認。
- `routes/api/pages/tree.ts`、`routes/api/pages/index.ts`、`routes/api/pages/[id].ts`、`routes/api/pages/[id]/undelete.ts`。
- `tests/pageDirectory.test.ts`: `tests/helpers/d1.ts` を使い、migration、祖先探索、循環判定、タイトル順、ルート復帰、FK `SET NULL` を検証。
- UI は変更しない。既存 UI は `parentId` を無視して動く。

### PR 3: frontend tree / breadcrumbs

ブランチ例: `feat/page-directory-ui`。backend PR のマージ後に開始する。

- `src/client/pageTree.ts`: 隣接リストからツリーを組む純粋関数、祖先パス、展開状態のキー。
- `tests/pageTree.test.ts`: 並び順、孤児、循環データ、深いチェーン。
- `src/components/AppShell.tsx`: サイドバーのツリー、パンくずの祖先表示。`PageNavigation[]` を使う。
- 各 loader（`pages/index.server.ts`, `pages/pages/[id].server.ts`, `pages/trash.server.ts`）: 既存の `listPageNavigation` 経由で `parentId` と `ancestors` を通す。
- `tests/discovery.test.ts` の `sidebarPageLists` 期待値をツリー対応に更新。
- 作成ダイアログはルート作成のまま。子ページ作成はページ詳細のメニューに置く場合は PR 4。

### PR 4（任意）: 移動・削除ガードの UX

- ツリーの「ここへ移動」、ページメニューの「子ページを作成」。
- 親削除時の 409 をダイアログで説明し、子ページ一覧へのリンクを出す。
- 復元時の `reparentedToRoot` 通知。

backend を先に出すことで、frontend は API の形だけに依存できる。逆順にすると、ツリー表示のために一時的なクライアント側推測（タイトルから親を決める等）が必要になり、捨て実装が増える。

## 10. fixture とテスト計画

### 10.1 純粋関数の fixture

隣接リストで次を用意する。

```ts
// 正常系
[
  { id: 'a', title: 'Alpha', parentId: null },
  { id: 'b', title: 'Beta', parentId: 'a' },
  { id: 'c', title: 'Gamma', parentId: 'a' },
  { id: 'd', title: 'Delta', parentId: null },
  { id: 'e', title: 'Epsilon', parentId: 'd' },
];
```

追加ケース:

- 孤児: `parentId` が存在しない → ルートに表示。
- 循環: `a -> b -> a` → ツリー構築が無限ループしない。循環ノードはルートに退避するか、表示から除外する（決めた方にテスト）。
- 深さ 33: 移動・祖先取得が 400 / 打ち切りになる。
- タイトル重複: 別ディレクトリの同名ページが両方表示され、リンク解決は `updated_at DESC, id ASC`。
- 削除済みの親 + 生存中の子: 通常操作では作れないが、データ不整合時は子をルート扱い。
- cursor 境界: `listPages` の `PageSlice` と `listPageNavigation` の全件ツリーが混ざらないこと。
- 267 件: PR #19 の `tests/scale.test.ts` と同じ規模で、`listPages` の全走査とツリーの全件取得が独立して動くこと。

### 10.2 単体・統合テスト

PR #19 で `tests/helpers/d1.ts` が追加されている。`node:sqlite` の in-memory DB を D1 互換の `prepare` / `batch` / `exec` で包み、`PRAGMA foreign_keys = ON`、FTS5、batch の rollback を再現する。`tests/scale.test.ts` は 267 件の cursor 全走査、同値境界、削除された境界、migration の再実行 / rollback / retry を検証している。

ディレクトリは同じ helper を使う。

- `tests/pageDirectory.test.ts`
  - `ensureSchema` が `0001_scale` → `0002_directory` の順で適用し、`meta['migration:0002_directory']` を立てること。
  - `0002` の再実行が no-op で、`parent_id` が二重に追加されないこと。
  - `parent_id` が既存ページで `NULL` のままであること。
  - 再帰 CTE による祖先取得と循環拒否。
  - 子を持つページのソフトデリートが 409 相当になること。
  - 親が削除済み / 不在のときのルート復帰。
  - 完全削除で `ON DELETE SET NULL` が効き、削除済みの子がルートになること。
- `tests/pageTree.test.ts`（純粋関数）
  - `buildPageTree`: 親子関係、兄弟のタイトル順、決定性、孤児、循環。
  - `findAncestors`: ルートから親までの順序、深さ上限。
  - `canMovePage`: 自分自身、子孫への移動、削除済み親、深さ超過。
  - `resolveRestoreParent`: 親が生存 / 削除済み / 不在の 3 分岐。
  - `sortSiblings`: `ja` の数値比較と `updatedAt` / `id` の tie-break。
- `tests/http.test.ts` の fake DB は `first()` で migration marker を返している。`0002_directory` の marker も返すよう更新し、`ensureSchema` が追加 migration を要求しても既存テストが落ちないようにする。

### 10.3 手動 / spike

- ルートに A、A の子 B、B の子 C を作成し、パンくずとサイドバーを確認。
- C を A の下へ移動し、循環（A を C の下へ）が 409 になることを確認。
- 子 B がいる A の削除が 409 になり、B 削除後に A を削除できることを確認。
- A と B を削除し、A を復元、B を復元したときに B がルートへ戻ることを確認。
- B を完全削除し、A の `parent_id` が `NULL` になることを確認（逆方向のケースも）。
- 別ディレクトリの同名ページを作り、`[[タイトル]]` が更新日時の新しい方を指すことを確認。
- 267 件の fixture で、一覧の cursor 送りとツリーの全件表示が同時に動くことを確認。
- `pnpm check` / `pnpm test` / `pnpm build:celld`。余裕があれば `pnpm spike`。

## 11. リスク

1. **navigation の全件負荷**: `listPageNavigation` は cursor に依存しない全 active page の軽量カタログで、件数に比例する。PR #19 の既知の制約と同じ。非常に大きな規模では navigation の追加読み込みを別途設計する。
2. **`ALTER TABLE` の再実行性**: SQLite に `ADD COLUMN IF NOT EXISTS` がない。`meta['migration:0002_directory']` と `PRAGMA table_info(page)` の両方でガードしないと、適用経路によっては二重追加で失敗する。
3. **FK の実効性**: `ON DELETE SET NULL` は `PRAGMA foreign_keys` が有効でないと動かない。`tests/helpers/d1.ts` は有効にしているが、本番 D1 / celld での挙動を spike で確認する。
4. **循環の競合**: チェックと更新が別文だと同時移動で循環し得る。D1 の single writer で実害は小さいが、可能なら 1 文の `UPDATE ... WHERE NOT EXISTS` にする。
5. **復元の驚き**: 親が消えている子がルートに戻る仕様は、ユーザーには位置変更に見える。通知とドキュメントが必要。
6. **タイトル重複の曖昧さ**: ディレクトリを入れると「同じ名前の別ページ」が増え、Wiki リンクの解決が直感に反しやすくなる。PR #19 でも `page_link` は未導入なので、既知の制約として明示する。
7. **Scale とのコンフリクト**: PR #19 が `db.ts`, `types.ts`, `schema.ts`, `AppShell.tsx` を変更済み。directory branch は `feat/scale` に rebase するか、#19 のマージ後に開始する。`listPages` ではなく `listPageNavigation` を触る。
8. **cursor とツリーの混同**: `listPages` をツリーに使う、あるいは tree endpoint に cursor を足すと、#19 の一覧契約と二重になる。`listPageNavigation` + `GET /api/pages/tree` に固定する。
9. **パンくずの N+1**: 祖先をページごとに引くと遅い。再帰 CTE 1 回か、ツリーから組み立てる。
10. **サイドバーの操作性**: 深いツリー、折りたたみ、キーボード操作、モバイル幅の確認が必要。`Sidebar` の既存 ARIA を壊さない。
11. **完全削除と子の整合**: `SET NULL` で子がルートに残ることを、ゴミ箱の表示と復元通知で説明する。

## 12. 推奨する実装順と最初の PR

1. **この PR**: `docs/page-directory.md`。contract をレビューで固定する。
2. **PR #19 の取り込み**: `feat/scale` を main にマージするか、directory branch を `feat/scale` に rebase する。`listPageNavigation` / `PageSlice` / migration runner / `tests/helpers/d1.ts` を前提にする。
3. **migration + backend API**: `migrations/0002_directory.sql`、`meta['migration:0002_directory']`、`PRAGMA table_info` ガード、`TypeScript` の `parentId`、`listPageNavigation` 拡張、`GET /api/pages/tree`、`updatePageParent`、祖先取得、削除ガード、復元のルート復帰。`tests/pageDirectory.test.ts` を SQLite integration で同時に入れる。
4. **frontend tree / breadcrumbs**: backend PR のマージ後に、`pageTree.ts` と `AppShell` を実装する。loader は既存の `listPageNavigation` 経由で `parentId` を渡す。
5. **移動・削除 UX**: 409 の説明、子ページ作成、移動メニュー。
6. **将来の `page_link`**: PR #19 では未導入。導入する場合も、リンク解決はグローバルな title / alias 規則を共通 contract とし、ディレクトリの `parentId` には依存させない。

最初に切るブランチは `docs/page-directory`（この PR）。実装の最初のブランチは `feat/page-directory-api` とし、`feat/page-directory-ui` はその後。`feat/scale`（PR #19）と並行する場合は、**migration runner と `PageNavigation` 型を先に main へ入れてから**、directory の `0002_directory` を別 PR に分ける。
