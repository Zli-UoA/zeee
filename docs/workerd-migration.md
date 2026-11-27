# workerd 移行調査レポート（2026-11-27）

対象: Zeee (`https://zeee.zli.works`) / 現行デプロイ: self-hosted celld v0.6.2 + R2 `zeee-fleet`
目的: Cloudflare による Deno 買収・celld 開発終了・workerd への celld 相当機能追加を踏まえ、workerd への移行を検討する。

> 調査方法: 4 並列調査（プロジェクト構成マップ / celld→workerd 統合の最新状況 / コード監査 / 意思決定とリスク分析）に加え、一次情報（workerd PR #7994、workerd README、`docs/r2-operations-investigation.md`）を直接照合。コード変更はなし。

---

## 0. 結論（要約）

1. **買収・統合は事実。しかも「予定」ではなく、すでに workerd に実装が入り始めている。** 2026-10-29 に Ryan Dahl 自身が PR [#7994](https://github.com/cloudflare/workerd/pull/7994) をマージしており、説明文は _"This is the beginning of merging celld's functionality into workerd"_ 。以降約 1 ヶ月で 20 本以上の関連 PR が入り、最新リリースは `workerd@1.20261127.1`（調査日）。
2. **ただし本番で使える状態ではない。** クラスタモードは今も `--experimental`。書き込みはバケット同期完了まで ACK されず（遅い・S3 課金が重い）、無停止デプロイ（#8155 / #8176）や一部の整合性バグが未解決。**celld も v0.6.3（10/21）で事実上凍結**（PR 受付停止、未解決 issue 104 件）。
3. **このプロジェクトは「Deno アプリ」ではなく、すでに Workers アプリ。** `Deno.*` は 0 件。D1 + Durable Objects + 静的アセットだけを使い、`nodejs_compat` も実質不要。**アプリコードの移行作業はほぼゼロ**で、作業の 9 割はデプロイ基盤とデータ移行。
4. **推奨: 本番を self-hosted workerd に今すぐ載せ替えるのはやめ、段階移行にする。** 今は「本番は celld 継続 or Cloudflare Workers、ローカル / CI は workerd」のハイブリッドにし、1〜3 ヶ月でクラスタのパイロット、6〜12 ヶ月でゲート基準を満たしたら本番カットオーバー。**待つことのコストはほぼゼロ**（Deno Deploy 停止や Deno runtime EOL はこのアプリに直接影響しない）。

---

## 1. ニュースの整理（事実関係）

| 日付                | 出来事                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-05          | celld v0.1.0 公開。Workers / DO を「1 Rust バイナリ + オブジェクトストレージ 1 つ」で自前運用する実装                                                                                                                                         |
| **2026-10-09**      | Cloudflare が Deno チーム全体の合流を発表（[Deno blog](https://deno.com/blog/cloudflare) / [Cloudflare blog](https://blog.cloudflare.com/deno-joins-cloudflare/)）。Ryan Dahl + Bert Belder が celld を workerd に統合する新取り組みをリード  |
| 10-09 時点の予定    | Deno runtime: 1 年間の月次バグ修正 / セキュリティ修正の後、開発終了（OSS は残る）。Deno Deploy: 6 ヶ月後に停止（≈2027-04-09）、有料顧客は Workers へ移行支援。JSR: 継続（インフラは Cloudflare へ）。rusty_v8: 継続支援＋workerd 統合を目指す |
| 2026-10-21          | celld **v0.6.3** が最後のリリース。以降 `main` にコミットなし。beta のまま、PR は停止（パッチはメール提出）                                                                                                                                   |
| 2026-10-24          | Cloudflare Connect のセッションで「nascent plans」。GA 日付の発表なし                                                                                                                                                                         |
| **2026-10-26 → 29** | workerd PR #7994 がマージ。**クラスタモードの実装が workerd に入る**                                                                                                                                                                          |
| 11 月               | クラスタ関連 PR が連続マージ（§2）                                                                                                                                                                                                            |
| 2026-11-25          | Kubernetes サンプル (#8274) がマージ（3 Pod、DO ハンドオフ、RustFS バケット代替）                                                                                                                                                             |
| **2026-11-27**      | 最新リリース `v1.20261127.1`。公式ブログでの続報・GA 発表は**まだなし**                                                                                                                                                                       |

Kenton Varda の説明は率直: workerd の DO は「シングルインスタンス＝ローカル検証用でスケールしない」のが最大の穴で、Cloudflare 本番のルーティングは自前運用には向かない "beast"。そこへ celld が入る、という構図です。

---

## 2. workerd 側に実際に何が入ったか

PR #7994 の実装（一次本文確認済み）:

- 複数 workerd プロセスが **同一の S3 互換バケット** を見ることでクラスタを形成 (`Config.cluster`, `--experimental`)
- **各 Durable Object は常に 1 オーナー**。任意のノードがリクエストを受け取り、オーナー死亡時は別ノードがバケットから引き継ぐ
- コミットログは **Cap'n Proto フレーム (`frames.capnp`)**。celld の LTX と概念は同じだが形式は別（workerd 側は Litestream のアルゴリズム / フォーマットを採用）
- 起動: `workerd serve --experimental config.capnp --cluster-addr 10.0.0.1:7000`
- **作者自身の但し書き**: _"an object acknowledges a write only once it is fully synced to the bucket; that is much too slow and expensive for most uses"_

### 続くマージ（11 月）

| 日            | PR                    | 内容                                                                                                                   |
| ------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 10-30 / 10-31 | #8090 / #8113         | DO alarms / DO facets（facet ごとの DB をルートログの 1 レーンとして扱う）                                             |
| 11-05         | #8166                 | デプロイをバケットへ格納 + `workerd deploy` コマンド                                                                   |
| 11-06         | #8168 / #8173         | 移動した DO の再解決 / 停止ノードの DO をピアへ移譲 + `/ready`                                                         |
| 11-07         | #8172                 | 組み込み KV（各ネームスペース = 1 DO）— "Part of merging celld into workerd"                                           |
| 11-09 / 11-10 | #8235 / #8328         | Cron Triggers / Queues                                                                                                 |
| 11-11 / 11-13 | #8322 / #8331         | GCS バケット / Workflows                                                                                               |
| **11-16**     | **#8486**             | **組み込み D1**（各 DB = 1 DO）                                                                                        |
| **11-19**     | **#8507**             | **R2 バケット**                                                                                                        |
| 11-20         | #8508 / #8631 / #8637 | クラスタ共通 Cache API / リース専用スレッド / イベントループ停止ノードのフェンシング                                   |
| 11-23         | #8752 / #8753         | `WORKERD_CLUSTER_KEY` / `WORKERD_CLUSTER_BUCKET` 環境変数、**Wrangler プロジェクトが `--cluster-addr` でクラスタ参加** |
| 11-24         | #8504                 | リリースごとのコンテナイメージ公開                                                                                     |
| 11-25         | #8274                 | Kubernetes サンプル（3 Pod、ローリング時の DO 移譲、2,699 req 無失敗）                                                 |

### 未解決（移行判断の关键点）

- [#8155](https://github.com/cloudflare/workerd/issues/8155) 無停止の JS / バイナリ更新（Bert Belder が 7 段階の計画を提示、**まだ open**）、[#8176](https://github.com/cloudflare/workerd/pull/8176) `workerd deploy --wait` も open。設定カタログは起動時にしか読まないため、ローリング再起動は WebSocket を切ります。
- [#8350](https://github.com/cloudflare/workerd/issues/8350) 12 秒以上の同期 JS がプロセス全体を止め得る問題、#8351 alarm 再試行、#8275 大きな SQLite トランザクション、#8830 時刻ずれ、など。
- workerd README 上の制約: `workerd serve wrangler.jsonc` が受け付けるのは限定的なフィールドのみ（`d1_databases` 等は `--experimental` 必須）。**"not a hardened sandbox"**。KV / D1 は 1 つ 1 つが単一 DO ＝ スループット上限。rate limits はメモリのみで再起動で消えます。
- `rusty_v8` の workerd 統合は**まだ未実装**（workerd は今も Bazel で上流 V8 を直接ビルド中、v15.9.128.39）。

---

## 3. このプロジェクトの実態（コード監査結果）

### 3.1 すでに Workers ネイティブ

- `void.config.ts:4` で `target: 'cloudflare'`。Void 1.3.0 + Vite+ 1.4.0 + `@cloudflare/vite-plugin` + Wrangler 4.155 + workerd / Miniflare は**ロックファイルに既に存在**。
- 使用プリミティブは **`DB` (D1)** と **`PAGE_ROOM` (Durable Object)** と静的アセットのみ。
  - D1: `src/server/db.ts`（約 926 行、ユーザー / セッション / ページ / リビジョン / 監査 / FTS5 trigram 検索）、`src/server/schema.ts`、`src/server/backlinks.ts`、ほぼ全ルート
  - DO: `durable-objects/page-room.ts` — **1 ページ = 1 DO**。Yjs 本文は DO 内の SQLite (`doc_snapshot` / `doc_update` / `doc_actor`)、alarm で D1 へ materialize、hibernatable WebSocket で共同編集
- **`Deno.*` は 0 件**。`node:` import はビルド / テストツールのみ。ランタイムは Web Crypto / fetch / `Response.json` など標準 API。`jose` v6 も Web Crypto ベース。
- **アプリから R2 は使っていません。** R2 は celld の永続化先 (`zeee-fleet`) とデプロイ先であり、アプリのバインディングではありません。KV / Queues / Cron も未使用（定期処理は DO alarm）。

### 3.2 celld 固有なのは「デプロイ基盤」だけ

| 箇所                                                            | celld 依存の中身                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `celld/vite.ts`                                                 | ビルド後に `dist/ssr/wrangler.json` を `dist/wrangler.json` へ書き換える Vite プラグイン |
| `package.json:9-11`                                             | `build:celld` / `watch:celld` / `dev:celld` (`celld dev dist`)                           |
| `.github/workflows/deploy.yml:138-152`                          | celld 0.6.2 をダウンロードして `celld deploy dist`                                       |
| `scripts/spike-check.mjs`                                       | `celld dev` を起動する E2E スパイク                                                      |
| `docs/spike.md`, `docs/r2-operations-*.md`, `infra/terraform/*` | celld + R2 の運用設計                                                                    |

**重要な好材料**: `celld/vite.ts` が生成する `dist/wrangler.json` のキー集合（`name`, `main`, `vars`, `durable_objects`, `migrations`, `d1_databases`, `assets`, `compatibility_*`）は、そのまま **`workerd serve --experimental dist/wrangler.json` が受け付ける形**。`void.lock.json` にも `PAGE_ROOM` / `PageRoomDurableObject` / migration tag `void-durable-page-room-v1` が記録済み。**ランタイム切替はほぼ設定差し替えで済む**見込みです。

### 3.3 移行の動機はすでに数字に出ている

`docs/r2-operations-investigation.md`（2026-11-12）: 月間 **Class A 約 115 万回**、バケット 197MB のうち **109MB が celld の死んだ LTX epoch**。アイドル時でも node lease + rebalance で **72 ops/分**。アプリの書き込みは 1% 未満。D1 が 10 分の idle eviction のたびに DB 全体（322KB）を R2 へコピーしています。

---

## 4. 移行の REAL なブロッカー

コードではなく**データ**です。

1. **DO の状態移動が最大の難所。** Yjs 本文は D1 ではなく DO の SQLite にあります。ホストを変えても勝手に移りません。
   - 救い: `GET /api/pages/:id/state` が生の Yjs update (`application/octet-stream`) を返す（`durable-objects/page-room.ts:91-100`）ので、**エクスポート用フックは既にある**
   - 問題: 現在の `/replace` は Markdown のみを受け付け（同 `:259-293`）。これで取り込むと **Yjs のクライアント ID / undo 履歴を失う**。生 update を適用する一時インポートエンドポイントを足すか、「Markdown を正とみなして履歴は捨てる」と明示的に割り切る必要がある
2. **DO のアイデンティティ罠。** ID は (deployment 名, クラス名, storage key)。workerd クラスタではさらに deployment 名が `uniqueKey` に入ります。**名前を変えると DO が空から始まる（黙ってデータが消える）**。`zeee` / `PageRoomDurableObject` / migration tag は絶対に維持する
3. **D1 の FTS5 仮想テーブル。** エクスポートは 2026-11-12 の改善で可能になったが、そのダンプの**インポートは依然非対応**。論理エクスポート → インポート → `page_fts` を `page_body` から再構築、のリハーサルが必須。加えて hosted D1 は LIKE パターンが 50 バイト制限なのに `src/server/db.ts:781,819` の `searchPages` は最大 500 文字を許す — 日本語 7 文字以上で LIKE フォールバックが例外を投げ得る（FTS 側は無影響）
4. **絵文字アカウント URL。** `void.config.ts:25-27` の celld ビルド既定値は `http://emoji.emoji.svc.cluster.local:3001/accounts` で、`docs/account-emojis.md:7` も「単体 Cloudflare Worker からは接続不可」と明記。移行先で `EMOJI_ACCOUNT_PROFILE_URL` を到達可能な値に設定し直す必要がある
5. **WebSocket の切断。** ローリング再起動・DO 移動で 1012 が飛ぶ。クライアント (`src/client/provider.ts:126-220`) は再接続＋IndexedDB outbox を持つので耐性はあるが、無停止デプロイが solve されるまでは切替タイミングを低トラフィック時に取る

---

## 5. 選択肢の比較

| 案                                                               | 評価                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Workers（ホステッド）へ今すぐ**                     | **今の最善**。アプリコード変更ゼロ、`void deploy` がそのまま使える。D1 / DO / 静的アセットは第一級。残作業は credential / CI / データ移行のみ。出口（workerd）も残る |
| **self-hosted workerd を今すぐ本番化**                           | ❌ まだ早い。クラスタは生後 1 ヶ月の experimental、無停止デプロイ未解決、書き込みはバケット ACK、運用は全部自分持ち                                                  |
| **celld 継続**                                                   | 短期的には動くが、新規ベットには最適ではない。v0.6.3 で凍結、104 issue、パッチはメール、mixed version 不可、TLS 終端なし                                             |
| **待つ（統合完了を待つ）**                                       | デフォルト戦略。ただし受け身ではなく、§6 のゲート監視＋パイロットを行うこと                                                                                          |
| **ハイブリッド（開発 / CI は workerd、本番は Workers / celld）** | ✅ **今日から採用すべき**。Miniflare は既に workerd。同じ `dist/wrangler.json` で適合性を継続検証できる                                                              |

---

## 6. 推奨ロードマップ

### 今〜1 ヶ月（可逆性を確保）

- 本番は celld 継続、または可能なら hosted Workers へ。新しい本番を workerd クラスタに載せない
- CI に `workerd serve --experimental dist/wrangler.json` でのスモークテストを追加
- D1 論理ダンプ + DO 生 Yjs state エクスポートのリハーサルを自動化（**これが全ての前提**）
- `zeee` / `PageRoomDurableObject` / migration tag を不変と明文化

### 1〜3 ヶ月（非本番パイロット）

- [K8s サンプル](https://github.com/cloudflare/workerd/pull/8274) または systemd で 3 ノード構築。R2 バケット + ライフサイクル設定（未完成マルチパート破棄）+ プライベートネットワーク + TLS 終端
- 実際の Wiki ワークロードで計測: 1 ノード vs 2 ノード以上の書き込みレイテンシ、S3 リクエスト数、D1 単一 DO のスループット上限、フェイルオーバー時間
- SIGKILL / ローリング再起動 / バケット障害 / 時刻ずれ / ロールバックの障害注入を 30 日間

### 3〜6 ヶ月（ゲート次第で低リスク workloads を移行）

- 下記ゲートが概ね満たれば、非本番 Wiki または再構築可能な読み取り系を self-hosted workerd へ。Workers を正本として並行稼働を継続

### 6〜12 ヶ月（本番判断）

- cluster が non-experimental または公式サポート方針が出て、無停止デプロイが実証されていれば、DNS / ルート切替 → 読み取り → 書き込み、の段階的カットオーバー。**ワンコマンドで Workers に戻せる状態を維持**

### Go / No-Go ゲート（全部必須）

1. `--experimental` が外れる、または公式な self-hosting GA / サポート発表がある
2. #8155 / #8176 がクローズされ、`workerd deploy --wait` が WebSocket・in-flight 含めて無停止を実証
3. バケット形式の安定性と upgrade / mixed-version 方針・rollback 手順が文書化
4. ピア ACK 書き込みが入る、または実測レイテンシ / コストが受容可能
5. 既知の整合性バグ（#8351, #8275, #8830 等）がクローズ
6. SLO・バックアップ / リストア手順・独立した本番事例がある

### 監視する場所

- `cloudflare/workerd` の [cluster issues / PRs](https://github.com/cloudflare/workerd/pulls?q=is%3Apr+is%3Amerged+cluster+created%3A%3E2026-10-20)、#8155 / #8176、README、npm リリース、コンテナイメージ
- Cloudflare blog / Kenton Varda / Ryan Dahl、Connect 2027
- `denoland/celld` の README（workerd 指向のアナウンス）と issue #267

---

## 7. 反論（なぜ移行しない方がいいか）

workerd は**ランタイムであってプラットフォームではありません**。 celld のベンチマークしていないコスト比較には運用人件費が含まれていません。クラスタキー保持者は全サービスへのフルアクセスを持ち、ピア間通信は平文、信頼できないコードを動かすには VM 分離が必須です。D1 / R2 / DO のセマンティクス、バケット形式、`uniqueKey` 命名は依然として「実質的なロックイン」です。そして**このプロジェクトを移行しなければならない期限は存在しません**（Deno のイベントは Workers アプリには直撃しない）。早期移行は「二度移行する」結果になりがちです。

---

## 8. 一次情報

- https://deno.com/blog/cloudflare （2026-10-09）
- https://blog.cloudflare.com/deno-joins-cloudflare/ （2026-10-09）
- https://github.com/cloudflare/workerd/pull/7994 （cluster 実装、2026-10-26 → 29）
- https://github.com/cloudflare/workerd/blob/main/README.md
- https://github.com/cloudflare/workerd/releases/tag/v1.20261127.1
- https://github.com/cloudflare/workerd/issues/8155 , https://github.com/cloudflare/workerd/pull/8176
- https://github.com/cloudflare/workerd/pull/8274 （Kubernetes サンプル）
- https://github.com/denoland/celld （README / releases / limitations / cloudflare-compat / guarantees / issues #267）
- https://github.com/denoland/rusty_v8
- HN: https://news.ycombinator.com/item?id=49185430 （celld ローンチ）, https://news.ycombinator.com/item?id=50019911 （買収）
- ローカル: `docs/spike.md`, `docs/r2-operations-investigation.md`, `docs/r2-operations-plan.md`, `docs/operations.md`, `void.config.ts`, `void.lock.json`, `celld/vite.ts`
