# ページディレクトリ設計 contract

状態: 設計のみ（実装前）。基準は `main` の `99bb3a4`。

このドキュメントは、Zeee のフラットなページ一覧に親子関係（ディレクトリ）を追加するための最小 contract を定める。コード変更、schema 変更、PR 分割の単位は末尾にまとめる。

## 1. 結論

| 項目                | 決定                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| 階層の持ち方        | `page.parent_id`（nullable、自己参照）だけ。materialized path は使わない |
| URL                 | 既存の `/pages/:id` を維持する。パス URL は導入しない                    |
| 子の並び順          | 同じ親の中ではタイトル順。手動並べ替えは MVP 外                          |
| 移動                | `PATCH /api/pages/:id` に `parentId` を追加。循環はサーバーで拒否        |
| 親の削除            | 生存中の子がいる削除は 409 で拒否。子を先に削除または移動させる          |
| 復元                | 親が存在しない / 削除済みならルートに戻す                                |
| 完全削除            | 子は `ON DELETE SET NULL` でルートに戻す                                 |
| タイトル重複        | 許容する。Wiki リンクの解決規則は現状のまま（更新日時が新しい方）        |
| 既存ページ          | すべて `parent_id = NULL` のルートとして移行。データ書き換えなし         |
| ツリーの取得        | 当面は `listPages`（上限 200）を再利用。Scale 側で専用 endpoint を追加   |
| 検索 / バックリンク | ディレクトリの影響を受けない。フラットなまま                             |

最重要の前提は **「ディレクトリはメタデータであり、ページの同一性・URL・Wiki リンク解決を変えない」** こと。これにより、既存の本文、履歴、共有 URL、バックリンクを壊さずに段階導入できる。

## 2. 現状の確認

- `page` は `id, title, created_by, created_at, updated_at, deleted_at` のみで、階層情報はない（`src/server/schema.ts`）。
- ページの同一性は UUID の `id`。URL は `/pages/:id`（`pages/pages/[id].server.ts`）。
- 一覧は `listPages` が `updated_at DESC` で最大 `PAGE_LIST_LIMIT = 200` 件を返す（`src/server/db.ts`, `src/server/types.ts`）。
- Wiki リンク `[[タイトル]]` はタイトルと旧タイトル（`page_alias`）を全体で解決する。重複時は `updated_at` が新しいページを優先する（`src/markdown/wiki.ts`）。
- バックリンクはタイトル / alias の LIKE 検索で、ページ階層を見ない（`src/server/backlinks.ts`）。
- サイドバーは「最近見たページ」と「すべてのページ」のフラットな 2 リスト（`src/components/AppShell.tsx`）。
- パンくずは現状「ページ / 現在のタイトル」の 2 要素だけ（`src/components/AppShell.tsx`）。
- 削除はソフトデリート。復元と完全削除はゴミ箱から行う（`src/server/db.ts`, `pages/trash.tsx`）。
- `ensureSchema` は `CREATE TABLE IF NOT EXISTS` のみで、既存 DB への列追加マイグレーション機構はない（`src/server/schema.ts`）。

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

既存 DB には列がないため、`ensureSchema` に冪等な列追加を入れる。

- `PRAGMA table_info(page)` で `parent_id` の有無を確認し、なければ `ALTER TABLE page ADD COLUMN parent_id TEXT REFERENCES page(id) ON DELETE SET NULL` を実行する。
- 既存行は `NULL` のまま（全ページがルート）。データの書き換えはしない。
- 追加後に `CREATE INDEX IF NOT EXISTS page_parent_idx ON page(parent_id, title, id)` を作る。
- 将来の migration と衝突しないよう、`meta` に `schema_version` を置く方式へ移行するのが望ましい。少なくとも、列の存在確認は毎回行い、 isolate ごとの `schemaPromise` キャッシュに依存しない。
- 本番 D1 へは `celld deploy` 前に migration を適用する運用が必要。`docs/operations.md` の手順に追記する。

`ALTER TABLE ... ADD COLUMN ... REFERENCES` は SQLite の制約上、既定値が `NULL` であれば許可される。D1 / celld の実環境で `PRAGMA foreign_keys` が有効かを含め、spike で確認する。

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

`PageSummary` に `parentId: string | null` を追加する。`PageRecord`、`DeletedPageSummary` も継承して同じ値を持つ。

```ts
type PageSummary = {
  id: string;
  title: string;
  parentId: string | null;
  createdAt: number;
  createdByName: string;
  excerpt: string;
  updatedAt: number;
};
```

`ParentSummary` / `PageBreadcrumb` は `{ id: string; title: string }` とし、ページ詳細の loader で祖先チェーンを返す。

### 5.2 ツリー取得

MVP では既存の `listPages` に `parent_id` を含め、クライアントで隣接リストからツリーを組む。追加の endpoint は作らない。

- これにより `listPages` の上限 `PAGE_LIST_LIMIT = 200` をそのまま引き継ぐ。
- 200 件を超えるとツリーが不完全になるため、`pages.length >= PAGE_LIST_LIMIT` のとき UI に「一部のページのみ表示しています」と出す。
- Scale 側で cursor 一覧が入ったら、ツリー専用の軽量 endpoint（後述）を追加し、`listPages` の cursor 化とは分離する。MVP ではこの endpoint を作らない。

### 5.3 パンくず

- ページ詳細 loader で祖先を取得し、`ancestors: PageBreadcrumb[]` を返す。ルートから現在の親までを順に並べ、現在ページは含めない。
- 再帰 CTE 1 回で取得し、N+1 を避ける。深さ上限 32。
- `AppShell` は「ページ / 祖先 / 現在タイトル」を表示する。祖先が多い場合は先頭 1 件 + 省略 + 末尾 3 件に畳む。
- 祖先が見つからない（データ不整合）場合は現在の深さで打ち切る。

### 5.4 サイドバー

- 「すべてのページ」をツリー表示にする。ルートは折りたたみ可能。
- 「最近見たページ」はフラットなまま。
- 展開状態はユーザーごとに `localStorage` に保存する。現在ページの祖先は自動展開する。
- 子を持つページは `aria-expanded` を持つボタン、持たないページはリンクにする。`aria-current="page"` は現状どおり。
- 削除・移動・作成後はサーバー再取得またはイベントでツリーを更新する。既存の `zeee:page-renamed` と同様に、`zeee:page-moved` / `zeee:page-created` を使う。
- ルートから外れたページ（`parent_id` が存在しないページを指す）はルート扱いにして表示し、データ不整合を隠さない。

### 5.5 一覧ページ（`/`）

- 既存のフラット一覧と sort は維持する。
- 各ページに任意で祖先パスを表示する場合は、ツリーから組み立てたパスを副次表示に使う。MVP では省略可。
- 一覧の action（`POST`）はルート作成のまま。子ページ作成はページ詳細またはツリーのコンテキスト操作から行う。

### 5.6 検索

- `searchPages` と `page_fts` は変更しない。検索結果はフラットなまま。
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
- 既存の `listLinkTargets` の 200 件上限も維持する。ディレクトリはこの上限を悪化させない。

## 7. Wave 3.1 Scale との衝突点

Wave 3.1 Scale は「一覧の cursor 化」「最終更新者」「`page_link`」を扱う想定。ディレクトリと同時に進める前に、次の contract を先に固定する。

| 衝突点           | 衝突の内容                                                                         | 先に決める contract                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一覧 cursor      | `listPages` を cursor 化すると、全件を前提にしたツリーが壊れる                     | ツリーは cursor 一覧と別経路にする。`listPages` の返り値に `parentId` を足すのは互換。ツリー専用 `listPageTree` は全件（上限付き）を返す                                                                                    |
| ツリーの上限     | 現行 `PAGE_LIST_LIMIT = 200` を超えるとサイドバーが不完全                          | `GET /api/pages/tree` は `{ pages, truncated }` を返し、`pages` は `id,title,parentId,updatedAt` のみ。上限は 2000 件、深さ 32。cursor は使わない                                                                           |
| 最終更新者       | `updated_by` を入れると、移動・復元・削除が「最終更新」を書き換えるかが曖昧        | `updated_by` は本文保存とタイトル変更のみ更新。移動は `updated_at` / `updated_by` を変えない。復元・削除は現行の `updated_at` 更新を維持し、`updated_by` は変えない                                                         |
| `page_link`      | リンクを `target_page_id` で持つと、タイトル重複・rename・移動・削除で再解決が必要 | `page_link` は「source page id + 解決済み target page id」を持ち、解決は既存のグローバル title/alias 規則（`updated_at DESC, id ASC`）。title/alias/削除/復元の変更時に再解決する。ディレクトリはリンクのスコープを変えない |
| 削除とリンク     | ソフトデリート / 完全削除で `page_link` の target が消える                         | 完全削除は `page_link` を `ON DELETE CASCADE`。ソフトデリートはリンクを残し、表示時に生存ページのみ解決する                                                                                                                 |
| 一覧の並び       | Scale が `updated_at` 順の cursor を導入すると、ツリーのタイトル順と競合する       | ツリーの兄弟順はタイトル順で固定。一覧の sort とは独立させる                                                                                                                                                                |
| バックリンク     | `page_link` 導入で LIKE ベースのバックリンクを置き換える                           | ディレクトリ導入時点では既存 `listBacklinks` を維持し、`page_link` 移行は別 PR。両方の結果が一致することを fixture で確認する                                                                                               |
| schema migration | 両方が `page` と `page_link` を変更する                                            | 共通の migration runner（`meta.schema_version`）を先に入れる。順序は directory の `parent_id` → Scale の `updated_by` → `page_link`                                                                                         |

特に、**`listPages` の cursor 化とツリー表示を同じ関数に載せない**ことを最初に決める。ここを混ぜると、ディレクトリ PR と Scale PR のどちらかが必ず手戻りになる。

## 8. API contract（実装時の最小形）

### 8.1 型

```ts
type PageSummary = { /* 既存 */ parentId: string | null };
type PageBreadcrumb = { id: string; title: string };
type PageTreeNode = { id: string; title: string; parentId: string | null; updatedAt: number };
```

### 8.2 エンドポイント

| Method   | Path                      | 変更                                                                                                                                        |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/pages`              | body に任意の `parentId`。省略時はルート。親が不正なら 400 / 404                                                                            |
| `PATCH`  | `/api/pages/:id`          | body は `{ title?: string; parentId?: string \| null }`。両方省略は 400。title がある場合は現行の 1〜200 文字検証。移動時は 400 / 404 / 409 |
| `GET`    | `/api/pages/:id`          | レスポンスに `ancestors: PageBreadcrumb[]` を追加（ページ本体は現行どおり）                                                                 |
| `GET`    | `/api/pages/tree`         | Scale 期に新規。`{ pages: PageTreeNode[], truncated: boolean }`。MVP では実装しない                                                         |
| `DELETE` | `/api/pages/:id`          | 生存中の子がいれば 409 `{ error: 'has_children', childCount }`                                                                              |
| `POST`   | `/api/pages/:id/undelete` | 親が無効ならルートへ復元し、`{ ok: true, reparentedToRoot: boolean }`                                                                       |

`PATCH` の title と parentId を同時に受けるのは、既存のタイトル保存経路を増やさないため。UI はどちらか片方だけを送ってよい。

### 8.3 監査

- 既存の `page.create` / `page.rename` / `page.delete` / `page.undelete` / `page.permanent_delete` を維持する。
- 移動は `page.move` を追加し、`target_id` はページ ID、親 ID は別途記録できないため `audit_event` の拡張はしない。必要なら `action = 'page.move'` のみで開始する。

## 9. frontend / backend の PR 分割

### PR 1: 設計ドキュメント（この PR）

- `docs/page-directory.md` のみ。
- コード・schema は変更しない。

### PR 2: backend contract

ブランチ例: `feat/page-directory-api`

- `src/server/schema.ts`: `parent_id` の冪等 migration、index。
- `src/server/types.ts`: `PageSummary.parentId`、`PageBreadcrumb`、`PageTreeNode`。
- `src/server/db.ts`: `listPages` の select 追加、`listPageTree`（任意）、`createPage` の `parentId`、`updatePageParent`、祖先取得、子件数チェック、`undeletePage` のルート復帰、`permanentlyDeletePage` の確認。
- `routes/api/pages/index.ts`、`routes/api/pages/[id].ts`、`routes/api/pages/[id]/undelete.ts`。
- `tests/pageDirectory.test.ts`: 純粋関数（祖先探索、循環判定、タイトル順、ルート復帰判定）を fixture で検証。
- UI は変更しない。既存 UI は `parentId` を無視して動く。

### PR 3: frontend tree / breadcrumbs

ブランチ例: `feat/page-directory-ui`

- `src/client/pageTree.ts`: 隣接リストからツリーを組む純粋関数、祖先パス、展開状態のキー。
- `tests/pageTree.test.ts`: 並び順、孤児、循環データ、深いチェーン。
- `src/components/AppShell.tsx`: サイドバーのツリー、パンくずの祖先表示。
- 各 loader（`pages/index.server.ts`, `pages/pages/[id].server.ts`, `pages/trash.server.ts`）: `ancestors` と `parentId` を通す。
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
- 200 件 / 2000 件: `truncated` の境界。

### 10.2 単体テスト

- `buildPageTree`: 親子関係、兄弟のタイトル順、決定性、孤児、循環。
- `findAncestors`: ルートから親までの順序、深さ上限。
- `canMovePage`: 自分自身、子孫への移動、削除済み親、深さ超過。
- `resolveRestoreParent`: 親が生存 / 削除済み / 不在の 3 分岐。
- `sortSiblings`: `ja` の数値比較と `updatedAt` / `id` の tie-break。

既存のテストは D1 を直接叩かない方針なので、SQL の再帰 CTE 自体は単体テストしにくい。ロジックを純粋関数に寄せ、SQL は `pnpm spike` と手動確認で補う。D1 の統合テスト基盤を入れるのは別課題とする。

### 10.3 手動 / spike

- ルートに A、A の子 B、B の子 C を作成し、パンくずとサイドバーを確認。
- C を A の下へ移動し、循環（A を C の下へ）が 409 になることを確認。
- 子 B がいる A の削除が 409 になり、B 削除後に A を削除できることを確認。
- A と B を削除し、A を復元、B を復元したときに B がルートへ戻ることを確認。
- B を完全削除し、A の `parent_id` が `NULL` になることを確認（逆方向のケースも）。
- 別ディレクトリの同名ページを作り、`[[タイトル]]` が更新日時の新しい方を指すことを確認。
- 201 件以上で `truncated` 表示が出ることを確認（可能なら）。
- `pnpm check` / `pnpm test` / `pnpm build:celld`。余裕があれば `pnpm spike`。

## 11. リスク

1. **200 件上限**: 既存 `listPages` を再利用するため、大規模化するとツリーが不完全。Scale の cursor 化前に専用 endpoint を入れる必要がある。
2. **migration 機構がない**: `CREATE TABLE IF NOT EXISTS` だけでは既存 D1 に列が増えない。列存在チェックを忘れると本番で 500 になる。
3. **FK の実効性**: `ON DELETE SET NULL` は `PRAGMA foreign_keys` が有効でないと動かない。D1 / celld での挙動を spike で確認する。
4. **循環の競合**: チェックと更新が別文だと同時移動で循環し得る。D1 の single writer で実害は小さいが、可能なら 1 文の `UPDATE ... WHERE NOT EXISTS` にする。
5. **復元の驚き**: 親が消えている子がルートに戻る仕様は、ユーザーには位置変更に見える。通知とドキュメントが必要。
6. **タイトル重複の曖昧さ**: ディレクトリを入れると「同じ名前の別ページ」が増え、Wiki リンクの解決が直感に反しやすくなる。パスリンクは MVP 外なので、既知の制約として明示する。
7. **Scale とのコンフリクト**: `db.ts`, `types.ts`, `schema.ts`, `AppShell.tsx` は両方で触る。先に migration runner と型を固定し、PR の順序を守る。
8. **パンくずの N+1**: 祖先をページごとに引くと遅い。再帰 CTE 1 回か、ツリーから組み立てる。
9. **サイドバーの操作性**: 深いツリー、折りたたみ、キーボード操作、モバイル幅の確認が必要。`Sidebar` の既存 ARIA を壊さない。
10. **完全削除と子の整合**: `SET NULL` で子がルートに残ることを、ゴミ箱の表示と復元通知で説明する。

## 12. 推奨する実装順と最初の PR

1. **この PR**: `docs/page-directory.md`。contract をレビューで固定する。
2. **migration runner + `parent_id`**: backend PR の最初のコミット。`meta.schema_version` か列存在チェックを入れ、既存ページをルートとして移行する。
3. **backend API**: 型、`listPages` の `parentId`、`updatePageParent`、祖先取得、削除ガード、復元のルート復帰。純粋関数のテストを同時に入れる。
4. **frontend tree / breadcrumbs**: backend PR のマージ後に、`pageTree.ts` と `AppShell` を実装する。
5. **移動・削除 UX**: 409 の説明、子ページ作成、移動メニュー。
6. **Scale との統合**: `listPageTree`、`updated_by`、`page_link` の順で、migration runner を共有して進める。

最初に切るブランチは `docs/page-directory`（この PR）。実装の最初のブランチは `feat/page-directory-api` とし、`feat/page-directory-ui` はその後。`feat/scale` と並行する場合は、**migration runner と共通型を先に main へ入れてから**、directory と Scale の schema 変更を別 PR に分ける。
