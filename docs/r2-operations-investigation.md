# R2 オペレーション調査（2026-11-12）

対象: R2 `zeee-fleet` / celld v0.6.2 / StatefulSet 2 pods / `CELLD_DURABILITY=bucket`

## 結論

**1.15M Class A のほぼ全部は利用者の操作ではなく、celld の制御ループです。**
バケットの中身は 4,150 objects / 197 MB しかなく、保存済みオブジェクト 1 個あたり
約 440 回の操作が発生している計算になります。

さらに、**オペレーション数よりストレージの方が危険**です。197 MB のうち約 109 MB は
celld の「死んだ LTX epoch」で、`CELLD_LTX_RETENTION_SECS` が未設定のため削除されずに
溜まり続けています。D1 セルは **`CELLD_IDLE_EVICT_S=600` による 10 分 idle eviction** の
たびに新しい epoch を作り、そのたびに DB 全体（約 322 KB）を R2 にコピーしています。

## 観測値

| 項目                               | 値                                              |
| ---------------------------------- | ----------------------------------------------- |
| 平均ストレージ（30日）             | 113.22 MB                                       |
| Class A                            | 1.15M                                           |
| Class B                            | 908.42k                                         |
| リクエスト分布                     | 1.83M                                           |
| 取得データ                         | 0 B                                             |
| 実バケット（2026-11-12 21:34 JST） | 4,150 objects / 197.25 MB                       |
| うち LTX                           | 3,946 objects / 111.0 MB                        |
| うち deploy                        | 50 objects / 65.6 MB                            |
| うち deploy-blobs                  | 135 objects / 20.7 MB                           |
| うち PageRoom LTX                  | 1,889 objects / 5.0 MB（7 cells）               |
| うち D1 LTX                        | 2,057 objects / 106.0 MB（113 epochs, e1–e118） |

## 原因 1: アイドル時でも 72 ops/分 の制御プレーン

デフォルト設定の 2 ノードでは、リクエストが 1 件もなくても次の書き込みが続きます。

### node lease（`nodes/*.json`）

- `CELLD_TTL_MS` のデフォルトは 10 秒
- 更新間隔は `TTL / 3` = 約 3.33 秒
- 各ノードが 1 回の conditional PUT（Class A）
- **2 ノード × 18 回/分 = 36 Class A/分**

実測でも `nodes/node_*.json` の Last-Modified が約 3.3 秒ごとに進むことを確認。

### fleet capacity sample（`fleet/capacity-v1.json`）

- `CELLD_REBALANCE_INTERVAL_MS` のデフォルトは 5,000 ms
- 1 回のサンプル更新で、
  - claim の conditional PUT（Class A）
  - `nodes/` の LIST（Class A）
  - 各 node lease の GET（Class B × ノード数）
  - 確定 sample の conditional PUT（Class A）
- **36 Class A/分 + 約 60 Class B/分**

実測でも `fleet/capacity-v1.json` が約 5 秒ごとに更新されていることを確認。

### 合計

- Class A: 36 + 36 = **72/分**（≈ 3.1M/月、24h 稼働時）
- Class B: **約 60〜64/分**（≈ 2.7M/月）
- 実測 1.15M A / 13 日間 = **約 61/分**、908k B = **約 49/分** とほぼ一致
  （バケット作成が 10/30 のため、30 日 window のうち稼働は約 13 日）
- アプリのデータ書き込み（11/02・11/11 の編集バースト）は全体の 1% 未満

**つまり、113 MB のバケットに対して、誰も使っていなくても毎月 300 万回の
Class A が発生する構造です。** ノード数を増やすと線形に増えます。

## 原因 2: LTX epoch のリーク（本命）

D1 セルは 2026-11-11 11:20 UTC 以降、**約 10〜20 分おきに新しい epoch** を作っています。

- 11/11 11:20 以降だけで 64 epochs / 43.4 MB
- 1 日あたり **約 41 MB** のペース
- 各 epoch の開始時に DB 全体（322 KB）を書き、終了時にも compaction で
  322 KB を書く（合計 約 0.65 MB/回）
- 古い epoch は `CELLD_LTX_RETENTION_SECS` 未設定のため**一切削除されない**
- 現在 113 epochs / 106 MB。`celld cell gc --dry-run --grace-secs 3600` では
  **103.9 MB（D1）+ 4.8 MB（PageRoom）= 約 108.7 MB** が削除可能と報告された。
  24h grace の場合は直近 1 日分（約 40 MB）を残すため、回収量は約 60 MB になる

これは celld の既知の挙動です（denoland/celld#240）。v0.6.1 で
`CELLD_LTX_RETENTION_SECS` による epoch GC が追加されましたが、**デフォルトは無効**です。
現在のイメージは v0.6.2 なので利用可能です。

### 直接原因: `CELLD_IDLE_EVICT_S=600`

`zoo2-infra` の `kubernetes/apps/zeee/runtime/kustomization.yaml` の
`configMapGenerator` で **`CELLD_IDLE_EVICT_S=600`** が設定されています。
D1 セルは最終アクセスから 10 分で idle eviction され、次のリクエストで
新しい epoch として復元され、そのたびに DB 全体（322 KB）を R2 に書きます。
観測した「10〜20 分おきに新しい epoch」と一致します。
`fleet/capacity-v1.json` の `shed_cells` が node0=73 / node1=16 と多いのも、
頻繁な eviction と整合します。

補足:

- `rebalance_paused` は両ノードとも false。balancing も dormant cell を動かし得るが、
  10 分という規則的な間隔は idle eviction の設定値と一致する
- D1 は resident ではなく dormant になりやすく、次の health check / page view /
  session update で wake する
- wake のたびに全 DB コピーが発生するため、**idle eviction を長くする**ことが
  書き込み量の直接的な削減になる
- ただし idle eviction を無効にすると resident cell が増える。
  `CELLD_MAX_RESIDENT_CELLS=120` と 1 GiB limit の範囲で判断する

## 原因 3: 古い deploy bundle の蓄積

- deploy は 16 バージョン分、`index.js` だけで 65.4 MB
- 1 デプロイあたり約 4.1 MB。古いバージョンは削除されない
- deploy-blobs も 20.7 MB（content-addressed、古い deployment 用も残る）
- 現在の `deploy/current.json` は 11/03 の `e7b11dde4f005e98` のまま。
  11/11 以降のストレージ増加は deploy ではなく D1 epoch が原因

## 原因 4: アプリ側の書き込み増幅（二次要因）

- `/api/health` が毎回 `ensureSchema` + `SELECT 1` で D1 を activate する
- `getSession` が認証付きリクエストごとに `session.last_seen_at` を UPDATE する。
  この列は現在どこからも読まれておらず、**read-only のページ閲覧まで D1 書き込みにしている**
- DO は Yjs update（ほぼキーストローク）ごとに `doc_update` と `doc_actor` の
  2 つの SQL 書き込みを行う
- DO の alarm は 1 秒 debounce で `materializePage` を実行し、その中で
  `page_fts` を DELETE + INSERT（trigram FTS5）する
- 11/11 の編集バーストでは D1 に 537 segments / 21.75 MB / 74 分
  （約 0.3 MB/分）。FTS5 trigram の再構築が効いている

`CELLD_DURABILITY=bucket` ではこれらの書き込みが毎回 R2 の往復になるため、
編集の体感にも効きます。

## 推奨対応

### 1. infra（最優先・コード変更なし）

`zoo2-infra/kubernetes/apps/zeee/runtime/kustomization.yaml` の
`configMapGenerator` に追加 / 変更します。

```yaml
configMapGenerator:
  - name: celld-config
    literals:
      - CELLD_BUCKET=s3://zeee-fleet
      # ...
      - CELLD_IDLE_EVICT_S=3600 # 600 -> 3600（または削除）
      - CELLD_TTL_MS=30000 # node lease 10s -> 30s
      - CELLD_REBALANCE_INTERVAL_MS=30000 # fleet sample 5s -> 30s
      - CELLD_LTX_RETENTION_SECS=86400 # 24h。古い epoch を GC
```

このリポジトリは Flux 管理です。main にマージすると Flux が
`zeee-runtime` Kustomization を同期し、`configMapGenerator` の hash が変わって
StatefulSet の `envFrom` 名も変わるため、**自動で rolling update されます**。
手動の `kubectl apply` / `rollout restart` は不要です。即時確認したい場合だけ:

```sh
flux reconcile kustomization zeee-runtime -n flux-system --with-source
kubectl -n zeee rollout status statefulset/celld --timeout=10m
```

期待効果:

| 指標                 | 現在              | 変更後（30s / idle 1h の場合） |
| -------------------- | ----------------- | ------------------------------ |
| node lease Class A   | 36/分             | 12/分                          |
| fleet sample Class A | 36/分             | 6/分                           |
| 合計 Class A         | 72/分（≈3.1M/月） | 18/分（≈0.78M/月）             |
| Class B              | 約64/分           | 約14/分                        |
| D1 の wake 回数      | 10 分 idle ごと   | 1 時間 idle ごと（約 1/6）     |
| storage 増加         | 約41 MB/日        | GC + wake 削減で大幅減         |

`CELLD_REBALANCE_INTERVAL_MS` を 60,000 にすると Class A は約 15/分まで下がります
（`CELLD_TTL_MS` も 60,000 にすると約 9/分）。
2 ノードの小規模 fleet では 30〜60 秒で十分です。

`CELLD_IDLE_EVICT_S` は 3600 を第一候補にし、メモリに余裕があれば削除も検討します。
resident cell が増えるため、`CELLD_MAX_RESIDENT_CELLS=120` と 1 GiB limit を監視してください。
ストレージだけなら GC でも止まりますが、wake ごとの全 DB コピー（Class A）は
idle eviction を長くしないと減りません。

### 2. epoch GC の確認

ノードが v0.6.1 以上であることを確認したうえで、まず dry-run:

```sh
set -a; . ~/.config/zeee/r2.env; set +a
celld cell gc --dry-run --bucket s3://zeee-fleet --region auto --grace-secs 86400
```

`CELLD_LTX_RETENTION_SECS` を設定すると、owner が 5 分に 1 回まで、
1 cell あたり最大 64 epochs を削除します。D1 は 2 パス必要です。
inactive な PageRoom は次に activate されるまで GC されません。

### 3. アプリ側

- `/api/health` から D1 アクセスを外す（静的 200 で十分。DB 確認が要るなら
  `?deep=1` の別経路にし、監視からは叩かない）
- `getSession` の `last_seen_at` UPDATE を削除する（未使用。必要ならログイン時だけ）
- DO alarm の `materializePage` を 1 秒 → 5〜10 秒に延ばす
- `page_fts` の DELETE + INSERT を毎秒ではなく 30〜60 秒おき、または
  revision 保存時だけにする。定期的に `INSERT INTO page_fts(page_fts) VALUES('optimize')`
- 自動 revision の間隔を 10 分 → 30〜60 分にし、古い revision の保持期間を決める
- `doc_actor` の毎 update 書き込みをやめ、最新の `doc_update.actor_id` から復元する
- Yjs update を 200 ms 程度まとめて 1 commit にする

### 4. deploy の掃除（任意）

古い `deploy/zeee/<version>/` と未参照の `deploy-blobs/` は celld に GC がありません。
現行 + 1 つ前を残して手動削除すると約 60 MB 回収できます。ロールバックは
`workflow_dispatch` で git から再デプロイできるため、古い R2 deployment は必須ではありません。

### 5. 監視

- R2 の GraphQL Analytics で actionType / object key 別の operations を可視化
- Class A が 1M/月を超えると、無料枠を超えた分が **次の 1M 単位に切り上げ**られる
  （1.15M → 超過 0.15M → 1M billable → $4.50）。現在の実測でも無料枠超過
- 月次予算アラートを設定

## 抜本解決になるか

結論: **今の異常（アイドル操作・epoch リーク）には抜本策**ですが、
「利用者が増えても R2 操作が増えない」という意味の抜本策ではありません。

| 層    | 対策                                            | 解決するもの                              | 残るもの                        |
| ----- | ----------------------------------------------- | ----------------------------------------- | ------------------------------- |
| infra | TTL / sample 延長、idle eviction 延長、epoch GC | 定常 72 A/分、109 MB の死骸、+41 MB/日    | 書き込み量に比例する R2 操作    |
| app   | materialize / FTS / session / Yjs のバッチ      | 編集 1 時間あたりの A 操作を 5〜10 倍削減 | celld の bucket durability 自体 |
| 設計  | R2 課金を許容、または別 storage を検討          | 無料枠の制約                              | 大規模化に伴うコスト            |

celld の `CELLD_DURABILITY=bucket` は「書き込みごとに R2 へ」が設計です。
`fleet` にしても ack が peer になるだけで、R2 へのアップロードは残ります。
したがって **R2 操作を書き込み量から完全に切り離すことはできません**。
無料枠を絶対条件にするなら、アプリの書き込みをどこまで畳めるかが本質です。

## 無料枠の容量試算

前提:

- 無料枠 Class A: 1M/月 = 33.3k/日（30 日）
- 制御プレーン Class A:
  - 現状（TTL 10s / sample 5s）: 72/分 = 103.7k/日
  - TTL 30s / sample 30s: 18/分 = 25.9k/日
  - TTL 60s / sample 60s: 9/分 = 13.0k/日
  - 1 node / TTL 60s / sample 60s: 6/分 = 8.6k/日（HA なし）
- 編集 1 時間あたりの Class A:
  - 11/11 の重いバースト: PageRoom 944 + D1 537 ≈ **1,480/時**
  - 通常ページ: **500/時** 程度と仮定
  - アプリ側バッチ後: **100〜300/時** を目標

| 構成           | 制御 A/日 | 残り A/日 | 編集余力（500 A/h） | 編集余力（200 A/h） |
| -------------- | --------: | --------: | ------------------: | ------------------: |
| 現状 10s/5s    |    103.7k |         0 |                   0 |                   0 |
| 30s/30s        |     25.9k |      7.4k |       約 15 時間/日 |       約 37 時間/日 |
| 60s/60s        |     13.0k |     20.3k |       約 41 時間/日 |      約 101 時間/日 |
| 1 node 60s/60s |      8.6k |     24.7k |       約 49 時間/日 |      約 123 時間/日 |

読み取り中心の利用者:

- `last_seen_at` の UPDATE を消せば、read-only のページ閲覧は Class A をほぼ消費しない
- D1 が resident の間は D1 read も R2 に行かない
- 静的アセットは celld のローカル cache（既定 `/tmp/celld/asset-cache`、512 MB）
  から返る。ただし pod の `/tmp` は 256 MiB なので実質上限は 256 MiB
- したがって **読むだけのユーザーは数百〜数千人でも無料枠に収まる可能性が高い**
- ただし D1 / ページ cell が dormant の間の activate は restore 読み取りと
  epoch コピーを発生させる。GC と balancing 停止で抑える

ストレージ:

- 現在 197 MB のうち 109 MB が死骸。GC 後は live data + 直近 epoch + deploy で約 90 MB
- 10 GB の無料枠はテキスト wiki なら数千ページ規模まで余裕がある
- ただし revision は 10 分ごとに全文保存。自動 revision を 30〜60 分にし、
  保持期間を決めないとページ数 × 編集頻度で増える
- deploy は 1 回 4.1 MB。deploy 頻度が高いと無視できない

## 成長時の判断

- 現在の数人: 修正後は余裕で無料枠
- 10〜40 人程度の active editor（1 人 1 時間/日）: 30s/30s + アプリ側バッチで到達可能
- 100 人規模（1 人 1 時間/日）: 60s/60s + バッチでも上限ギリギリ。
  常時編集や 100 人超は無料枠を超える
- read-only ユーザーは Class A をほぼ使わないため、総アカウント数より
  **同時編集時間** が制約になる
- 100 人超の active editor を想定するなら、R2 は数ドル〜数十ドル/月なので
  無料枠に固執せず課金する方が合理的

**結論**: 今回の設定変更は「今の異常」には抜本策。成長に耐えるには
アプリ側の書き込みバッチが必須で、それでも無料枠は「数十人の active editor」
まで。それ以上は課金を前提にした方がよい。

## コスト

R2 Standard の料金（2026-10-30 時点）:

- Class A: $4.50 / million
- Class B: $0.36 / million
- Storage: $0.015 / GB-month
- Free: 1M Class A, 10M Class B, 10 GB-month

現在の実測 1.15M Class A は無料枠 1M を少し超えるため、超過分が 1M 単位に
切り上げられて **約 $4.50/月**。実測ペース（13 日で 1.15M）の 30 日換算は
約 2.6M → 超過 1.6M が 2M 単位に切り上げ → **約 $9/月**。
理論アイドル値 72/分（3.1M/30 日）なら **約 $13.5/月**。
修正後は Class A が 1M 未満になり、**無料枠内（$0）** に収まる見込みです。

金額はまだ小さいですが、113 MB のデータに対してこの操作数は設計として異常で、
ノード数・利用者数に比例して増えます。ストレージの増加（約 41 MB/日）の方が
長期的なリスクです。

## 注意

- `CELLD_LTX_RETENTION_SECS` は全ノードが v0.6.1 以上であることを確認してから設定する
  （現在は v0.6.2 で OK）。GC は restore base より下の epoch だけを消す。
- GC は「現在の epoch、1 つ前の epoch、grace 内の epoch」を残す。
  24h だと直近 1 日分（約 40 MB）は残る。1h まで短縮すると回収量は増える。
- celld v0.6.3 でも **ローカル L0 / epoch dir の retention は未実装**（#311）。
  StatefulSet の `state` は emptyDir 10 GiB / `tmp` 1 GiB。現状は問題ないが、
  書き込みが増えると inode/disk を監視する。
- `CELLD_DURABILITY=bucket` は **emptyDir 前提の設定**。`fleet` は PVC と復旧設計が
  必要で、今回の設定変更では切り替えない（`docs/zeee.md` にも明記）。
  `bucket` は書き込みごとに R2 往復するが、R2 へのアップロードは `fleet` でも残る。
- R2 の無料枠はアカウント全体。他の bucket（terraform state など）の利用分も含めて判断する。

## 参照

- celld #240: Every activation adds a whole-database copy to the bucket, and superseded epochs are never deleted
- celld #311: Local L0/epoch LTX retention is not implemented
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
