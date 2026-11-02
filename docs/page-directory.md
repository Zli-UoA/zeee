# ページディレクトリ設計 contract（パス方式）

状態: 設計のみ（実装前）。Base は `origin/main` の `f048ddf`。`0001_scale` はマージ済みで、この設計はその後ろに `0002_path_uniqueness.sql` を置く。

このドキュメントは、PR #20 で一度決めた `parent_id` 方式を置き換え、ページタイトルを `/` 区切りのパスとして扱う方式の contract を定める。コード変更、schema 変更、PR 分割の単位は末尾にまとめる。

## 0. 決定事項

| 項目                  | 決定                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| 階層の表現            | `page.title` を `/` 区切りのフルパスとして扱う（例: `a/b/c`）。`parent_id` も directory テーブルも持たない |
| `/` の意味            | タイトル文字ではなく階層区切り。タイトルに `/` を入れたい需要はない                                        |
| ディレクトリ          | `a` / `a/b` はページではなく仮想ディレクトリ。実体は配下の active page のパスから導出する                  |
| ページとディレクトリ  | 完全に別物。同名共存は禁止                                                                                 |
| active パスの不変条件 | 完全一致の重複禁止、かつ prefix-free（`a` と `a/b` は共存不可、`a/b` と `a/c` は可）                       |
| 一意性の保証          | backend の partial unique index + prefix trigger。UI の事前チェックだけにしない                            |
| 作成・rename          | 1 つのパス入力。ディレクトリ autocomplete あり。ページ作成 / ディレクトリ作成のモード切替はない            |
| 空ディレクトリ        | MVP 外。ディレクトリは配下に active page がある間だけ存在する                                              |
| ディレクトリ rename   | MVP 外。配下ページを個別に rename する以外の一括操作は提供しない                                           |
| 既存データ            | `/` 入りタイトルはそのままパスとして解釈する。データ書き換えはしない                                       |
| 一覧の scope          | 「すべてのページ」と `?dir=a%2Fb` は同じ PageTree の scope 違い                                            |
| 検索                  | ページのフルパスを対象・表示にする                                                                         |
| Wiki リンク           | `[[a/b]]` のフルパス解決。`[[b]]` は `a/b` に解決しない                                                    |
| migration             | `migrations/0002_path_uniqueness.sql` を `0001_scale` の後に適用する                                       |

## 1. 用語と不変条件

- **パス**: `page.title` に入る文字列。`a/b/c` のように `/` で区切る。ページの表示名と同一で、別の「表示タイトル」列は持たない。
- **セグメント**: パスを `/` で分割した各要素。`a/b/c` のセグメントは `a`, `b`, `c`。
- **ページ**: `page` 行を持つ実体。パスは active なページのフルパス。
- **ディレクトリ**: 実体を持たない仮想ノード。active なページパスの proper prefix（セグメント境界）としてのみ存在する。
- **active**: `deleted_at IS NULL` のページ。
- **scope**: PageTree が見せる範囲。全ページか、特定ディレクトリ配下の subtree。

active なページパスには次の不変条件を課す。

1. **完全一致の一意性**: 同じパスの active ページは 1 つだけ。
2. **prefix-free**: ある active パスが別の active パスのセグメント境界 prefix になってはいけない。`a` と `a/b` は共存不可。`a/b` と `a/c`、`a` と `ab`、`a/b` と `a/bc` は共存可。
3. **ページは葉**: 1 と 2 により、ページの下にページは置けない。`a/b` がページなら `a/b/c` は存在しない。`a` がページなら `a/b` は存在しない。
4. **ページとディレクトリの排他**: ディレクトリ `a` は「active な `a/...` が存在する」ことと同値。したがってページ `a` とディレクトリ `a` は同時に存在しない。
5. **削除済みは active 集合の外**: ソフトデリートされたページは 1〜4 の対象外。active と同じパスを持つことができる。復元時に再度検証する。
6. **自動改名しない**: 不変条件違反を見つけても、システムが勝手にパスを書き換えない。作成・rename・復元は失敗させ、既存データの衝突は人手で解消する。

## 2. データモデル

### 2.1 `title` がパス

`page` の schema は変えない。`title` がそのままフルパスになる。

```text
page.id      page.title
--------     ----------
p1           a
p2           a/b
p3           a/c
p4           x/y/z
```

この例は不正。`a` と `a/b` が prefix 衝突している。次の形なら正しい。

```text
p1           a/b
p2           a/c
p3           x/y/z
```

- `a` と `x/y` は仮想ディレクトリで、`page` 行を持たない。
- ディレクトリ一覧は `title` を `/` で分割して導出する。`directory` テーブル、`parent_id`、materialized path 列、closure table は追加しない。
- パスはページの同一性ではない。ページの同一性は従来どおり UUID の `id`。URL も `/pages/:id` のまま。
- `page_alias` は従来どおり旧タイトルを保存する。パス方式では旧フルパスを保存する。alias は active パスの一意性には含めない。

### 2.2 パスの正規形

作成・rename の入力は次の規則で検証する。

- 前後の空白は全体に対して `trim()` する（既存の作成・rename と同じ）。
- 空文字は作成時のみ既存どおり `Untitled` にフォールバックする。rename では 400。
- `/` で分割し、空セグメントを禁止する。先頭 `/`、末尾 `/`、`//` は 400。
- パス全体の長さ上限は既存の 200 文字を維持する。パス入力では超過を暗黙に切り捨てず 400 にする。
- セグメントは 1 文字以上。空白だけのセグメントは許可しない。
- Unicode 正規化・大小文字変換はしない。既存タイトルを書き換えないため、保存されている文字列をそのまま比較する。比較は case-sensitive。
- `.` / `..` はパス区切りとして特別扱いしない。URL やファイルシステムのパスではないため、文字列としてそのまま扱う。ただし既存データ監査では通常と異なる値を確認する。
- タイトルに `/` を文字として入れたい需要はない。エスケープ構文は導入しない。将来必要になったら別 contract にする。

### 2.3 ページが葉であることの帰結

- ページ `a/b` に子ページを作ることはできない。子を作りたい場合は `a/b/c` という別ページを作る。このとき `a/b` はページではなくディレクトリでなければならないため、既存のページ `a/b` は rename または削除が必要。
- ページの rename は自分自身のパスを変えるだけで、配下ページの一括更新は発生しない。
- ディレクトリ rename は「配下の全ページの prefix を書き換える」操作になるため MVP 外。UI にディレクトリ rename を出さない。
- 空ディレクトリは作れない。最後の配下ページが削除・移動された時点でディレクトリは消える。

## 3. 一意性の backend 保証

### 3.1 partial unique index

active パスの完全一致を DB で禁止する。

```sql
CREATE UNIQUE INDEX IF NOT EXISTS page_active_path_unique
  ON page(title)
  WHERE deleted_at IS NULL;
```

- `deleted_at IS NULL` の partial index なので、削除済みページは同じパスを保持できる。
- 完全一致の重複は `UNIQUE constraint failed: page.title` になる。
- 既存の `page_active_title_idx` は残してよいが、一意性の根拠にはしない。

### 3.2 prefix trigger

セグメント境界の prefix 衝突を DB で禁止する。文字列の単純な `LIKE 'a%'` ではなく、`a` と `ab` を誤検知しない比較にする。

```sql
CREATE TRIGGER IF NOT EXISTS page_path_prefix_insert
BEFORE INSERT ON page
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'page_path_prefix_conflict')
  WHERE EXISTS (
    SELECT 1
    FROM page p
    WHERE p.deleted_at IS NULL
      AND (
        substr(NEW.title, 1, length(p.title) + 1) = p.title || '/'
        OR substr(p.title, 1, length(NEW.title) + 1) = NEW.title || '/'
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS page_path_prefix_update
BEFORE UPDATE OF title, deleted_at ON page
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'page_path_prefix_conflict')
  WHERE EXISTS (
    SELECT 1
    FROM page p
    WHERE p.deleted_at IS NULL
      AND p.id <> NEW.id
      AND (
        substr(NEW.title, 1, length(p.title) + 1) = p.title || '/'
        OR substr(p.title, 1, length(NEW.title) + 1) = NEW.title || '/'
      )
  );
END;
```

- `substr(x, 1, length(prefix) + 1) = prefix || '/'` で「セグメント境界の prefix」を判定する。`%` や `_` を含むタイトルでも wildcard の影響を受けない。
- INSERT は新規作成、UPDATE は rename と復元（`deleted_at` を `NULL` に戻す）で発火する。
- ソフトデリート（`deleted_at` を非 NULL に更新）では `WHEN NEW.deleted_at IS NULL` が偽なので発火しない。
- 完全一致は partial unique index が担当する。trigger は prefix のみを担当する。
- 自分自身の rename は `p.id <> NEW.id` で除外する。

### 3.3 書き込み経路とエラー

| 操作           | 検証                                                              | 失敗時                                    |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| 作成           | `parsePagePath` → 事前衝突チェック → INSERT（index + trigger）    | 400 invalid_path / 409 path_conflict      |
| rename         | `parsePagePath` → 事前衝突チェック → UPDATE（index + trigger）    | 400 invalid_path / 409 path_conflict      |
| ソフトデリート | active 集合から外れるだけ。衝突チェックなし                       | なし                                      |
| 復元           | UPDATE で `deleted_at = NULL`。trigger が active 集合に対して検証 | 409 path_conflict。ページは削除済みのまま |
| 完全削除       | パス不変条件に影響しない                                          | なし                                      |

- UI の事前チェックは即時フィードバックのためだけに使う。最終保証は index と trigger。
- 事前チェックと書き込みの間に別リクエストが割り込んでも、D1 は single writer であり、trigger が最終的に拒否する。
- SQLite の `UNIQUE constraint failed: page.title` と `page_path_prefix_conflict` は API で 409 にマップする。可能なら 409 の body に衝突相手のパスと id を含める。事前チェックで取得した衝突一覧を返し、race で trigger に倒れた場合も再取得して返す。
- 復元の 409 は「自動で別名にしない」。UI は「同じパスの active ページがあるため復元できません。先に rename するか、既存ページを削除してください」と表示する。

### 3.4 性能上の注意

- 完全一致は partial unique index で O(log n)。
- prefix trigger の `substr` 比較は active page の走査になる。現行規模（数百〜数千）では許容するが、書き込みごとに O(n) になる。
- 将来、書き込み頻度やページ数が増えた場合は、祖先パスの別テーブルや正規化列を検討する。ただし「directory テーブルを持たない」contract を変える場合は別 PR で設計する。MVP では trigger の単純さと正しさを優先する。

## 4. Migration `0002_path_uniqueness.sql`

### 4.1 適用順

`ensureSchema` は次の順で動く。

1. 基礎スキーマ `SCHEMA`（`CREATE TABLE IF NOT EXISTS`）。
2. `meta['migration:0001_scale']` がなければ `migrations/0001_scale.sql` を D1 `batch` で適用。
3. パスの事前監査（後述）を行い、active の重複・prefix 衝突があれば **migration を中止**する。
4. `meta['migration:0002_path_uniqueness']` がなければ `migrations/0002_path_uniqueness.sql` を D1 `batch` で適用。
5. `page_fts` を準備する（現行どおり）。

`0002_path_uniqueness.sql` は `0001_scale` の後ろに固定する。`0001_scale` の `page_last_editor` と索引を前提にしてよい。

### 4.2 ファイル内容

`migrations/0002_path_uniqueness.sql` は DDL と marker のみで、`UPDATE page SET title = ...` を含めない。

- `page_active_path_unique`（partial unique index）
- `page_path_prefix_insert` / `page_path_prefix_update`（trigger）
- `INSERT OR REPLACE INTO meta (key, value) VALUES ('migration:0002_path_uniqueness', '1')`

`0002` は `ALTER TABLE` を含まないため、`PRAGMA table_info` のガードは不要。再実行は `IF NOT EXISTS` と marker で no-op になる。

### 4.3 migration runner の変更点

既存の runner は SQL を `;` で分割している。trigger は `BEGIN ... END;` の中に `;` を含むため、単純分割すると壊れる。`0002` を入れる PR では、runner に trigger を意識した statement splitter を追加する。

- `BEGIN` / `END` のネストを数え、trigger 定義を 1 statement として扱う。
- 分割した各 statement を `db.prepare(...)` し、marker と一緒に `db.batch(...)` に入れる。D1 `batch` は transactional なので、途中失敗時は marker ごと rollback される。
- trigger の `CREATE` を別 statement として実行する実装でもよいが、migration ファイルと実行内容がずれないようにする。
- `schemaPromises` は DB binding ごとの `WeakMap` キャッシュを維持する。グローバルな単一 Promise に戻さない。
- splitter の単体テストに、trigger を含む SQL、文字列リテラル内の `;`、コメント行を入れる。

### 4.4 事前監査を migration に組み込む

runner は `0002` の DDL を実行する前に、active の完全一致重複と prefix 衝突を SELECT で確認する。1 件でもあれば例外を投げ、DDL も marker も適用しない。

- 自動改名はしない。衝突を解消するのは運用者。
- migration を「衝突があっても index/trigger だけ作る」状態にしない。既存の不変条件違反を残したまま起動しない。
- 削除済みページと active ページの衝突は migration を止めない。復元時に 409 になる既知の状態として監査レポートに出す。

### 4.5 バックアップ・適用・検証

1. D1 の Time Travel bookmark を取得し、`wrangler d1 export` などでバックアップを取る。
2. 読み取り専用で監査 SQL を実行し、結果を保存する。
3. 衝突がゼロであることを確認する。
4. 通常のデプロイで `ensureSchema` に `0002` を適用させる。Wrangler の migrations 管理とアプリの `meta` marker を同じ DB に二重適用しない。
5. 次を検証する。
   - `meta['migration:0002_path_uniqueness']` が存在する。
   - `sqlite_master` に `page_active_path_unique`、`page_path_prefix_insert`、`page_path_prefix_update` が存在する。
   - active page 数と title の内容が migration 前後で変わっていない。
   - 作成・rename・ソフトデリート・復元の smoke test が通る。
6. 失敗時は D1 `batch` の rollback で marker ごと戻る。手動で rollback する場合は trigger → index → marker の順に削除するが、不変条件が失われるため通常は行わない。

## 5. 既存データ監査と移行手順

### 5.1 監査 SQL

すべて読み取り専用。`deleted_at` の有無を明示して実行する。

**A. `/` を含むタイトルの棚卸し（active / deleted 両方）**

```sql
SELECT id, title, deleted_at
FROM page
WHERE instr(title, '/') > 0
ORDER BY title, id;
```

`/` 入りはそのままパスとして解釈する。ここに出すだけでデータは書き換えない。

**B. active の完全一致重複**

```sql
SELECT title, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
FROM page
WHERE deleted_at IS NULL
GROUP BY title
HAVING COUNT(*) > 1
ORDER BY title;
```

**C. active の prefix 衝突**

```sql
SELECT
  p1.id AS page_id,
  p1.title AS page_path,
  p2.id AS other_id,
  p2.title AS other_path
FROM page p1
JOIN page p2
  ON p1.deleted_at IS NULL
 AND p2.deleted_at IS NULL
 AND p1.id < p2.id
 AND (
   substr(p2.title, 1, length(p1.title) + 1) = p1.title || '/'
   OR substr(p1.title, 1, length(p2.title) + 1) = p2.title || '/'
 )
ORDER BY p1.title, p2.title;
```

`p1.id < p2.id` は同じペアの二重表示を避けるため。`a` と `ab` は衝突しない。

**D. 正規形でないパス**

```sql
SELECT id, title, deleted_at
FROM page
WHERE title = ''
   OR substr(title, 1, 1) = '/'
   OR substr(title, -1, 1) = '/'
   OR instr(title, '//') > 0
ORDER BY title, id;
```

空白だけのセグメントなど、より細かい異常はアプリの `parsePagePath` と同じ規則で別途確認する。

**E. 削除済みページと active ページの衝突（復元が 409 になる候補）**

```sql
SELECT
  d.id AS deleted_id,
  d.title AS deleted_path,
  p.id AS active_id,
  p.title AS active_path,
  CASE WHEN d.title = p.title THEN 'duplicate' ELSE 'prefix' END AS kind
FROM page d
JOIN page p
  ON d.deleted_at IS NOT NULL
 AND p.deleted_at IS NULL
 AND (
   d.title = p.title
   OR substr(d.title, 1, length(p.title) + 1) = p.title || '/'
   OR substr(p.title, 1, length(d.title) + 1) = d.title || '/'
 )
ORDER BY d.title, p.title;
```

これは migration を止めない。復元時に衝突することを事前に把握するためのレポート。

**F. ディレクトリ名と同名の alias（リンク解決の曖昧さ候補）**

```sql
SELECT a.alias, a.page_id, p.id AS active_page_id
FROM page_alias a
JOIN page p
  ON p.deleted_at IS NULL
 AND substr(p.title, 1, length(a.alias) + 1) = a.alias || '/'
ORDER BY a.alias, p.title;
```

alias は active パスの一意性には含めない。ここに出たものは「ディレクトリ名と同名の旧ページ alias」であり、Wiki リンクの解決で紛らわしくなり得る。MVP では自動削除しない。

**G. migration 前後の件数確認**

```sql
SELECT
  COUNT(*) AS all_pages,
  SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_pages,
  SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_pages
FROM page;
```

### 5.2 手順

1. 書き込みを止めるか、メンテナンス時間を取る。監査と解消の間は書き込みを再開しない。
2. バックアップを取る（Time Travel bookmark + export）。
3. 5.1 の A〜G を実行し、結果を保存する。
4. B / C / D に 1 件でもあれば、migration を適用せずに人手で解消する。
5. 解消後、B / C / D を再実行してゼロを確認する。
6. `0002_path_uniqueness.sql` を適用する。
7. 4.5 の検証と smoke test を行う。
8. E の結果を関係者に共有する。復元が必要なページは、復元前にパスを rename する運用にする。

### 5.3 衝突の解消例（自動化しない）

- `a`（ページ）と `a/b`（ページ）が共存している。
  - `a` をページとして残すなら、`a/b` を `x/b` などへ rename するか削除する。
  - `a` をディレクトリにしたいなら、ページ `a` を `a/index` などへ rename するか、内容を `a/b` に統合してから `a` を削除する。
- 同じ `a/b` が 2 件ある。
  - どちらを canonical にするかを決め、もう片方を rename または削除する。本文・履歴・バックリンクの統合が必要なら手動で行う。
- `a//b` や `/a` がある。
  - 正規形へ rename する。rename 時に旧パスが alias に残る。
- 削除済み `a/b` と active `a/b` がある。
  - すぐに復元しないなら放置してよい。復元するなら削除済み側を先に rename する。

**自動改名しない方針**: migration SQL に `UPDATE page SET title` を入れない。アプリも衝突時に勝手に別名を付けない。一括修正が必要な場合も、dry-run、差分確認、バックアップ、監査イベント記録を伴う明示的な運用にする。どちらを残すかは内容・履歴・リンクの意味を知っている人間が決める。

## 6. 読み取り側と UI の contract

### 6.1 型

`title` は常にフルパス。既存の型名を維持し、`parentId` は追加しない。

```ts
type PageNavigation = {
  id: string;
  title: string; // full path
  updatedAt: number;
};

type PageSummary = {
  id: string;
  title: string; // full path
  // 既存フィールドは変更しない
};

type SearchResult = {
  id: string;
  title: string; // full path
  // 既存フィールドは変更しない
};
```

PageTree のノードは、ページと仮想ディレクトリを判別できる形にする。

```ts
type PageTreeNode =
  | { kind: 'page'; id: string; path: string; name: string; updatedAt: number }
  | { kind: 'directory'; path: string; name: string; children: PageTreeNode[] };

type PageTreeScope = { kind: 'all' } | { kind: 'directory'; path: string };
```

- `path` はフルパス。`name` は最後のセグメント。
- ディレクトリノードは `id` を持たない。React の key は `path` を使う。
- ページノードは葉なので `children` を持たない。
- `listPageNavigation` は従来どおり全 active page の軽量カタログを返す。`title` がフルパスになるだけで、新しい tree endpoint は必須ではない。

### 6.2 PageTree と scope

- クライアントの純粋関数 `buildPageTree(pages)` が、`PageNavigation[]` のフルパスを `/` で分割してディレクトリノードを合成する。
- 同じ階層の兄弟は表示名（最後のセグメント）で決定的に並べる。`Intl.Collator('ja', { numeric: true, sensitivity: 'base' })` を使い、同値なら `path`、`updatedAt`、`id` で tie-break する。ページとディレクトリは同名共存できないため、表示名の重複は起きない。
- `scope: { kind: 'all' }` は root のページとディレクトリを表示する。
- `scope: { kind: 'directory', path: 'a/b' }` は `a/b` 配下の subtree を表示する。ディレクトリ自身はヘッダー / パンくずに出し、子として繰り返さない。
- どちらの scope も同じ `PageTree` コンポーネントを使う。「すべてのページ」は `kind: 'all'`、ディレクトリリンクは `kind: 'directory'`。
- ディレクトリは配下に active page がある間だけ存在する。空ディレクトリは MVP 外なので、存在しないディレクトリへのリンクは 404 にする（後述）。
- 深いパスでも表示が壊れないように、折りたたみとインデントで対応する。ページは葉なので、ページノードに展開ボタンは付けない。
- サイドバーの「すべてのページ」も同じ `buildPageTree` を使う。ページ詳細では active page を `aria-current="page"` で示す。
- 「最近見たページ」はフラットなまま。`id` で `PageNavigation` と照合し、表示はフルパスにする。
- コマンドパレット / 検索結果 / パンくずもフルパス表示に統一する。

### 6.3 作成・rename の UI

- 作成ダイアログと rename は、どちらも 1 つのパス入力だけを出す。「ページ作成 / ディレクトリ作成」のモード切替はない。
- 入力値はフルパス。例: `a/b/c`。`a/b/` のような末尾 `/` はエラーにする。
- ディレクトリ autocomplete は、既存の `PageNavigation[]` から `deriveDirectories(pages)` で全ディレクトリパスを導出して出す。候補を選ぶと `a/b/` まで入力し、最後のセグメントをユーザーが入力する。専用の directory API は作らない。
- 新しいディレクトリ名を直接入力して保存すると、その配下のページ作成と同時にディレクトリが生まれる。空ディレクトリだけを作る操作は提供しない。
- rename はページのパス編集として扱う。ページは葉なので、配下ページの一括更新は起きない。ディレクトリノードには rename 操作を出さない。
- 入力中に `parsePagePath` と `pathConflicts` で即時エラーを出す。保存時は backend の 409 を表示する。409 の body に衝突相手があれば、そのパスをエラー内に出す。
- 既存の「Untitled」フォールバックは作成時のみ維持する。rename の空入力は 400。

### 6.4 検索

- `page_fts` の `title` はフルパスなので、`a/b` を検索すると `a/b` のページに当たる。本文検索も従来どおり。
- 検索結果はフルパスを表示する。同名の葉（別ディレクトリの `index` など）を区別できるようにする。
- MVP では検索はグローバル。`?dir` の scope で検索結果を絞らない。ディレクトリ内検索が必要になったら、`dir` を `searchPages` の追加オプションにする別 PR にする。
- 検索結果のリンクは従来どおり `/pages/:id`。パスは表示と検索のためで、URL にはしない。

### 6.5 Wiki リンク

- `[[a/b]]` はフルパス `a/b` の完全一致で解決する。
- `[[b]]` は、active ページまたは alias に完全一致の `b` がある場合だけ解決する。`a/b` には解決しない。basename フォールバックは導入しない。
- `[[a/b|表示名]]` の label は従来どおり。
- rename で旧フルパスを `page_alias` に保存するため、`[[a/b]]` は rename 後も旧パス alias として解決できる。新しいリンクは新パスで作る。
- active パスが alias より優先する。既存の `listLinkTargets` が「active title と同名の alias を除外する」挙動を維持する。
- alias 同士が衝突した場合は `updatedAt DESC, id ASC` で決定的に解決する。`createWikiResolver` の比較に `id` を追加する。
- Wiki リンクの autocomplete はフルパスを候補にし、`[[a/b]]` を挿入する。
- ディレクトリ名はページではないため、`[[a]]` は「`a` というページまたは alias がある」場合だけ解決する。`a` がディレクトリであることだけを理由に解決しない。

### 6.6 ゴミ箱・復元

- ゴミ箱の表示はフルパス。ディレクトリは active page から導出するため、削除済みページだけではディレクトリを作らない。
- 復元は `deleted_at = NULL` の UPDATE で trigger が走る。active の完全一致または prefix 衝突があれば 409 で失敗し、ページは削除済みのまま残る。自動 rename はしない。
- 復元に成功すると、そのパスを含むディレクトリが再び現れる。
- 完全削除はパスの不変条件に影響しない。従来どおり削除済みページのみ対象。

### 6.7 URL

- ページの canonical URL は `/pages/:id` のまま。パスをページ URL にしない。
- ディレクトリの URL は `/?dir=<encodeURIComponent(fullPath)>`。例: `/?dir=a%2Fb`。
- `dir` がない `/` は「すべてのページ」scope。`dir=`（空）も同じ扱いにする。
- `dir` はフルパスの正規形として検証する。不正なら 400。
- `dir` が active ページの proper prefix になっていない場合（配下に active page がない、または `dir` 自身が active page）は 404。空ディレクトリを作らない MVP では「ディレクトリが存在する = 配下に active page がある」ため。
- パンくずはディレクトリ階層を `/?dir=...` のリンクにし、現在ページは `/pages/:id` にする。
- `?dir` はあくまで表示 scope。ページの同一性、共有 URL、Wiki リンクの解決には使わない。

### 6.8 API

| Method   | Path                      | 変更                                                                                       |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `POST`   | `/api/pages`              | body は `{ title }`。`title` はフルパス。不正は 400、衝突は 409。`parentId` は受け取らない |
| `PATCH`  | `/api/pages/:id`          | body は `{ title }`。rename / 移動を同じパス編集として扱う。400 / 404 / 409                |
| `GET`    | `/api/pages`              | 既存の cursor 契約のまま。`title` がフルパスになる                                         |
| `GET`    | `/api/pages/:id`          | 既存のまま。`title` がフルパス                                                             |
| `DELETE` | `/api/pages/:id`          | 既存のソフトデリート。子のガードは不要（ページは葉）                                       |
| `POST`   | `/api/pages/:id/undelete` | 既存の復元。衝突時は 409 `path_conflict`                                                   |
| `GET`    | `/api/search`             | 既存のまま。結果の `title` がフルパス                                                      |

- `GET /api/pages/tree` は追加しない。`listPageNavigation` の全件カタログをクライアントでツリー化し、scope で絞る。
- `GET /api/pages/directories` も追加しない。ディレクトリは `PageNavigation[]` から導出する。
- `PageSummary` / `PageRecord` / `DeletedPageSummary` / `SearchResult` に `parentId` を足さない。
- 409 の body は `{ error: 'path_conflict', path, conflicts: [{ id, path }] }` を基本形にする。完全一致と prefix を区別する場合は `kind` を足す。

## 7. 実装順と PR 分割

### PR 1: 設計ドキュメント（この PR）

- `docs/page-directory.md` のみ。
- コード、schema、migration は変更しない。
- 旧 `parent_id` 方式を置き換える contract をレビューで固定する。

### PR 2: backend のパス検証・一意性・migration

ブランチ例: `feat/page-path-uniqueness`。Base は `f048ddf` 以降の main。

- `src/server/pagePath.ts`（新規）: `parsePagePath`、`pathConflicts`、`deriveDirectories`、`isDirectoryPath`。client と共有できる純粋関数にする。
- `migrations/0002_path_uniqueness.sql`: partial unique index、prefix trigger、marker。`UPDATE` を含めない。
- `src/server/schema.ts`: `0001_scale` の後に `0002_path_uniqueness` を適用。trigger を扱う statement splitter、事前監査、marker、`WeakMap` キャッシュ。
- `src/server/db.ts`: `createPage` / `updatePageTitle` / `undeletePage` のパス検証と 409 マッピング。`listPageNavigation` / `listPages` / `searchPages` は `title` がフルパスになるだけで、cursor 契約は変えない。
- `routes/api/pages/index.ts`、`routes/api/pages/[id].ts`、`routes/api/pages/[id]/undelete.ts`: 400 / 409 のレスポンス。
- `tests/pagePath.test.ts`: 検証、衝突、ディレクトリ導出。
- `tests/pagePathMigration.test.ts`: `tests/helpers/d1.ts` で migration、index、trigger、復元衝突、再実行 no-op、事前監査の失敗を検証。
- `tests/http.test.ts` の fake DB は `migration:0002_path_uniqueness` marker も返すよう更新する。
- UI はまだ変えない。既存 UI は `title` をそのまま表示するため、`/` 入りタイトルがパスとして見える以外は動く。

### PR 3: PageTree / scope / autocomplete

ブランチ例: `feat/page-path-ui`。PR 2 のマージ後。

- `src/client/pageTree.ts`（新規）: `buildPageTree`、`scopeTree`、`findDirectory`、`deriveDirectories` の client 側利用。
- `src/client/pagePath.ts` など、PR 2 の純粋関数を共有する。重複実装しない。
- `src/components/PageTree.tsx`（新規）: ページ / ディレクトリノード、折りたたみ、scope 表示、アクセシビリティ。
- `src/components/AppShell.tsx`: サイドバーの「すべてのページ」を PageTree にし、パンくずをパスから組み立てる。
- `pages/index.server.ts` / `pages/index.tsx`: `?dir` の parse、400 / 404、scope 付き PageTree。`?dir` がない場合は all scope。
- `pages/pages/[id].server.ts` / `[id].tsx`: パンくず、サイドバーの active 表示、フルパス表示。
- `CreatePageDialog` / rename UI: 1 パス入力、ディレクトリ autocomplete、409 表示。モード切替は作らない。
- `tests/pageTree.test.ts`: ツリー構築、scope、孤児、深いパス、並び順。
- `tests/discovery.test.ts` / `tests/http.test.ts`: サイドバーと scope の期待値を更新。

### PR 4: 検索・Wiki リンクのフルパス統一

PR 2 と同時でもよいが、UI の表示変更と分けたい場合は独立させる。

- `src/markdown/wiki.ts`: `createWikiResolver` の tie-break に `id` を追加。フルパス完全一致のテストを追加。basename フォールバックがないことを固定する。
- Wiki autocomplete: 候補をフルパスにし、`[[a/b]]` を挿入。
- 検索結果 / コマンドパレット: フルパス表示。
- `tests/wikiLinks.test.ts` / `tests/aliases.test.ts`: `[[a/b]]` 解決、`[[b]]` 非解決、旧パス alias、active 優先。
- ディレクトリ内検索はこの PR に入れない（MVP 外）。

### PR 5（任意）: 運用ツールと UX の仕上げ

- 監査 SQL を `scripts/audit-page-paths.sql` などに固定し、dry-run を用意する。自動改名はしない。
- 409 の衝突相手表示、復元失敗の説明、ディレクトリ 404 の空状態。
- 深いツリーの折りたたみ、キーボード操作、モバイル幅の確認。

### 将来（MVP 外）

- 空ディレクトリの永続化（directory テーブルまたは sentinel page）。
- ディレクトリ rename（配下パスの一括更新）。
- ディレクトリ内検索。
- パス URL（`/a/b`）とリダイレクト。canonical は `/pages/:id` のまま。
- パスに `/` 以外の予約文字を入れる需要が出た場合のエスケープ contract。

## 8. テスト計画

### 8.1 純粋関数

`parsePagePath`:

- `a`、`a/b`、`a/b/c`、日本語、空白を含むセグメント、`%` / `_` を含むセグメントを受理する。
- `''`、`/a`、`a/`、`a//b`、`///` を拒否する。
- 200 文字超を拒否する。
- `a` と `ab`、`a/b` と `a/bc` を衝突扱いにしない。

`pathConflicts(candidate, pages)`:

- 完全一致を検出する。
- `a` vs `a/b` を検出する。
- `a/b` vs `a/c` を検出しない。
- 削除済みページを無視する（呼び出し側で active のみ渡す契約も固定する）。
- 自分自身を除外する（rename 用）。

`deriveDirectories(pages)`:

- `a/b`、`a/c`、`x/y/z` から `a`、`x`、`x/y` を重複なく返す。
- active page のフルパスをディレクトリ候補に含めない。
- 並び順が決定的。

`buildPageTree` / `scopeTree`:

- 正常系、孤児（active ページの prefix が欠けている状態は不変条件上起きないが、防御的に扱う）、深いパス。
- all scope と directory scope の差。
- 存在しないディレクトリの scope が 404 相当になる。
- ページノードが葉であること。

### 8.2 SQLite 統合テスト（`tests/helpers/d1.ts`）

- `ensureSchema` が `0001_scale` → `0002_path_uniqueness` の順で適用し、marker を立てる。
- `0002` の再実行が no-op で、index / trigger が二重作成されない。
- active の完全一致 INSERT が unique index で失敗する。
- `a/b` の後に `a` を INSERT すると prefix trigger で失敗する。
- `a` の後に `a/b` を INSERT すると prefix trigger で失敗する。
- `a/b` の後に `a/c`、`a` の後に `ab`、`a/b` の後に `a/bc` は成功する。
- `a/b` をソフトデリートすると、同じ `a/b` を新規作成できる。
- 新規 `a/b` がある状態で旧 `a/b` を復元すると 409 相当で失敗し、旧ページは削除済みのまま。
- rename で `a/b` → `a/c` が成功し、旧パスが alias に残る。
- rename で他の active ページの prefix になるパスへ変更すると失敗する。
- 同じパスへの rename（no-op）が成功する。
- migration 前に active の重複があると、`ensureSchema` が失敗し、index / trigger / marker が作られない。
- migration 前に active の prefix 衝突があると、同様に失敗する。
- migration 前後で `page` の行数と title が変わらない（クリーンな fixture）。
- trigger を含む SQL の splitter が、文字列リテラル内の `;` を壊さない。

### 8.3 HTTP / UI

- `POST /api/pages` に `a/b` を送ると 201、`a` と `a/b` の衝突で 409。
- `PATCH /api/pages/:id` の rename で 400 / 404 / 409。
- `POST /api/pages/:id/undelete` の衝突で 409、成功時は 200。
- `GET /?dir=a%2Fb` が 200 で subtree を返す。
- `GET /?dir=a` で `a` が active page の場合は 404、`a/...` がある場合は 200。
- `GET /?dir=` が all scope。
- `GET /?dir=a//b` が 400。
- 検索結果と Wiki リンクの表示がフルパス。
- `[[a/b]]` が解決し、`[[b]]` が `a/b` に解決しない。
- 旧パス alias が `[[a/b]]` で解決する。
- サイドバー / PageTree の active 表示、折りたたみ、`aria-current`。

### 8.4 手動 / spike

- 本番相当の D1 で監査 SQL を dry-run し、実行時間と結果を確認する。
- バックアップから復元できることを確認する。
- `a/b`、`a/c`、`x/y/z` を作り、`?dir=a` と `?dir=a%2Fb` の scope、パンくず、autocomplete を確認。
- `a/b` を `a/d` に rename し、旧 `[[a/b]]` が alias で解決することを確認。
- `a/b` を削除して `a/b` を新規作成し、旧 `a/b` の復元が 409 になることを確認。
- `%` / `_` / 日本語 / 空白を含むパスで trigger が誤検知しないことを確認。
- 267 件以上の fixture で、一覧の cursor、PageTree、検索が独立して動くことを確認。
- `pnpm check` / `pnpm test` / `pnpm build:celld`。余裕があれば `pnpm spike`。

## 9. 残リスク

1. **prefix trigger の O(n)**: `substr` 比較は active page の走査になる。現行規模では許容するが、大規模化すると書き込みが遅くなる。必要になったら祖先パスの別テーブルを別 contract で検討する。
2. **D1 の trigger と runner**: D1 / SQLite の trigger 構文と、`BEGIN ... END;` を含む SQL の分割に依存する。runner の splitter と統合テストで固定する。本番 D1 で trigger が期待どおり動くことを spike で確認する。
3. **既存データの人手解消**: 重複・prefix 衝突・不正パスは自動で直さない。件数が多いと移行コストが高い。監査 SQL と dry-run を先に用意する。
4. **削除済みパスの再利用**: active から消えたパスを新規ページが使える。旧ページを復元すると 409 になる。ゴミ箱 UI で理由を説明する必要がある。
5. **ディレクトリ rename がない**: 配下ページをまとめて動かせない。MVP の割り切りとして UI でディレクトリに rename を出さない。
6. **空ディレクトリがない**: 最後のページを削除するとディレクトリが消える。`?dir` のブックマークは 404 になり得る。
7. **alias とディレクトリ名の衝突**: 旧 alias がディレクトリ名と同じ場合、Wiki リンクがその alias に解決し得る。active パス優先の規則で緩和するが、自動削除はしない。監査 F で可視化する。
8. **検索が scope 非対応**: `?dir` 表示中も検索はグローバル。ディレクトリ内検索が欲しくなったら別 PR。
9. **パスは URL ではない**: ページ共有 URL は `/pages/:id` のまま。パスをコピーしてもページ URL にはならない。ディレクトリだけ `?dir` で共有できる。
10. **Wiki リンクの特殊文字**: `|`、`[`、`]`、改行を含むパスは Wiki リンクで表現しにくい。既存タイトルと同じ制約として残る。必要なら別 contract。
11. **case / Unicode**: 比較は case-sensitive で、Unicode 正規化をしない。`A` と `a`、NFC と NFD は別パスになる。既存データを書き換えないための割り切り。
12. **UI の深いパス**: 深いツリー、長いセグメント、モバイル幅で折りたたみとインデントが破綻しないか確認する。
13. **409 の UX**: 衝突相手を表示しないと、ユーザーがなぜ保存できないか分からない。API の `conflicts` を UI で必ず表示する。
14. **migration の二重適用**: アプリの `meta` marker と Wrangler の migrations 管理を同じ DB に二重適用しない。自動適用を正とする。
15. **自動改名しない運用負担**: 衝突解消の判断を人間に残すため、移行時に内容・履歴・リンクを確認するコストがかかる。これはデータを壊さないための意図的な選択。

## 10. 次のアクション

1. このドキュメントをレビューし、パス方式の contract を固定する。
2. PR 2 で `parsePagePath`、`0002_path_uniqueness.sql`、trigger-aware runner、監査 preflight、409 マッピングを実装する。
3. 本番相当データで監査 SQL を dry-run し、衝突件数と解消計画を確認する。
4. PR 3 で PageTree / `?dir` scope / autocomplete / パンくずを実装する。
5. PR 4 で検索・Wiki リンクのフルパス表示と解決を固定する。
6. 空ディレクトリ、ディレクトリ rename、scope 検索、パス URL は必要になった時点で別 contract にする。
