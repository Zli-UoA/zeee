# R2 オペレーション削減 作業計画

対象: `zeee-fleet` / celld v0.6.2 / 2 pods / `CELLD_DURABILITY=bucket`

関連: [r2-operations-investigation.md](r2-operations-investigation.md)

## ゴール

1. **今の異常を止める**
   - アイドル時の Class A を 72/分 → 18/分以下（できれば 9/分）
   - D1 の epoch 増加と +41 MB/日 のストレージ増加を止める
   - 死んだ LTX（約 109 MB）を回収する
2. **成長に耐える書き込み経路にする**
   - 編集 1 時間あたりの Class A を 5〜10 倍削減する
   - read-only のページ閲覧が D1 書き込みにならないようにする
3. **無料枠の限界を把握する**
   - 現状の数人〜数十人の active editor は無料枠内
   - 100 人超は課金前提、という判断を明文化する

## スコープ外

- celld から別 runtime / 別 storage への移行
- 検索基盤の作り直し（FTS5 trigram を維持）
- 100 人超の active editor を無料枠で運用するための大規模設計

## Phase 0: ベースラインと安全確認

- [ ] R2 の Class A / Class B / storage を日次で記録（GraphQL か dashboard）
- [ ] `celld cell gc --dry-run --grace-secs 86400` の結果を保存
- [ ] バケットの object 数・bytes・epoch 数を保存
- [ ] 全ノードが v0.6.1 以上であることを確認（現在 v0.6.2）
- [ ] 任意: D1 の `page` / `page_body` / `revision` を論理エクスポート
- [ ] ロールバック手順を確認（configmap の PR revert → Flux 同期）

完了条件: 変更前の数値と戻し方が記録されている。

## Phase 1: infra 設定で出血を止める

対象: `zoo2-infra/kubernetes/apps/zeee/runtime/kustomization.yaml` の
`configMapGenerator`（`celld-config`）。`origin/main` では zeee は Flux 管理なので、
main にマージすると `zeee-runtime` Kustomization が同期し、configMapGenerator の
hash 変更で StatefulSet が自動的に rolling update されます。

```yaml
configMapGenerator:
  - name: celld-config
    literals:
      - CELLD_BUCKET=s3://zeee-fleet
      # ...
      - CELLD_IDLE_EVICT_S=3600 # 600 -> 3600（または削除）
      - CELLD_TTL_MS=30000
      - CELLD_REBALANCE_INTERVAL_MS=30000
      - CELLD_LTX_RETENTION_SECS=86400
```

- [ ] configMapGenerator を更新して PR を main にマージ
- [ ] Flux の同期を待つ（source 1 分 / Kustomization 10 分）。
      即時確認するなら `flux reconcile kustomization zeee-runtime -n flux-system --with-source`
- [ ] `kubectl -n zeee rollout status statefulset/celld --timeout=10m`
- [ ] `/.well-known/celld/health` と `/api/health` を確認
- [ ] `nodes/*.json` の更新間隔が約 10 秒になったことを確認
- [ ] `fleet/capacity-v1.json` の更新間隔が約 30 秒になったことを確認
- [ ] `celld cell gc --dry-run --grace-secs 86400` で削除候補を確認
- [ ] GC 後、D1 の epoch 数と storage が減ることを確認
- [ ] D1 の epoch 増加が 1 時間に 1 回以下になったことを確認（idle evict 1h の効果）

注意:

- `CELLD_IDLE_EVICT_S=600` が D1 の 10 分ごとの wake と全 DB コピーの直接原因。
  3600 にすると wake 回数が約 1/6 になる。メモリに余裕があれば削除も検討。
- resident cell が増えるため、`CELLD_MAX_RESIDENT_CELLS=120` と 1 GiB limit を監視する。
- `CELLD_TTL_MS=30000` はフェイルオーバーが最大 30 秒になる。2 ノードの内部 wiki なら許容。
- `CELLD_REBALANCE_INTERVAL_MS=0` は sample が 5 秒に戻るので使わない。30〜60 秒にする。
- `CELLD_LTX_RETENTION_SECS` は restore base より下の epoch だけを消す。現在のデータは消えない。
- GC は 5 分に 1 回、1 cell あたり最大 64 epochs。D1 は 2 パス必要。
- `POST /rebalance/pause` は補助的な切り分け。主因は idle eviction なので、
  まず `CELLD_IDLE_EVICT_S` を変えて観察する。

完了条件:

- アイドル Class A が 18/分以下
- storage の増加が止まる、または減少に転じる
- D1 の epoch 増加が停止、または 1 時間に 1 回以下

## Phase 2: アプリの書き込み増幅を削る

対象: `zeee` リポジトリ

### 2a. すぐ効く・低リスク

- [ ] `src/server/db.ts`: `getSession` の `last_seen_at` UPDATE を削除
      （どこからも読まれていない。必要ならログイン時だけ）
- [ ] `routes/api/health.ts`: D1 アクセスを外して静的 200 に。
      深い確認が要るなら `?deep=1` の別経路にし、監視からは叩かない
- [ ] `durable-objects/page-room.ts`: `doc_actor` への毎 update 書き込みをやめ、
      最新の `doc_update.actor_id` から復元する
- [ ] `durable-objects/page-room.ts`: alarm の materialize を 1 秒 → 5〜10 秒

### 2b. 検索・履歴

- [ ] `materializePage` の `page_fts` DELETE + INSERT を毎回やめ、
      30〜60 秒おき or revision 保存時だけにする
- [ ] 定期的に `INSERT INTO page_fts(page_fts) VALUES('optimize')`（低頻度）
- [ ] 自動 revision を 10 分 → 30〜60 分に
- [ ] revision の保持期間 / 件数を決めて prune する

### 2c. Yjs のバッチ（効果測定後）

- [ ] クライアントの Yjs update 送信を 200 ms 程度まとめる
- [ ] もしくは DO 側で短時間の update を merge して 1 commit にする
- [ ] ack / nack / 再接続の既存テストを維持

完了条件:

- 認証付きの read-only リクエストで D1 書き込みが発生しない
- 編集 1 時間あたりの Class A が 5〜10 倍減る
- 共同編集・検索・履歴・復元のテストが通る
- `pnpm check` / `pnpm test` / `pnpm build:celld` が通る

## Phase 3: durability と容量の判断

- [ ] `CELLD_DURABILITY=bucket` を維持する（今回のスコープ） - `fleet` は PVC と復旧設計が必要。`emptyDir` のままでは切り替えない - `fleet` にしても R2 へのアップロードは残るため、操作数の抜本削減にはならない
- [ ] 将来 `fleet` を検討する場合の前提を整理する（PVC、ノード障害、復旧訓練）
- [ ] 静的アセットキャッシュの置き場所を確認 - 既定は `/tmp/celld/asset-cache`、512 MB 上限 - StatefulSet の `/tmp` は 1 GiB。現在の assets 20.7 MB は収まる - 将来増えるなら `/var/lib/celld`（10 GiB）へ移す
- [ ] 現在の編集強度で Class A / Class B / storage を再測定
- [ ] 無料枠継続か課金許容かを決める（100 人超は課金前提）

完了条件: 構成とコスト方針が決まり、測定値で裏付けられている。

## Phase 4: ゴミの掃除

- [ ] 古い `deploy/zeee/<version>/` を現行 + 1 つ前まで削除（約 60 MB 回収）
- [ ] 未参照の `deploy-blobs/` を確認して削除（任意）
- [ ] revision の prune を定期実行（アプリ or バッチ）
- [ ] 削除後に `deploy/current.json` と health を確認

注意: 古い deployment を消すと、その version への即時 rollback は R2 からはできなくなる。
git から再デプロイできるので、通常は問題ない。

## Phase 5: 監視と定着

- [ ] R2 GraphQL で actionType / object key 別の operations を可視化
- [ ] アラート: Class A > 0.8M/月、storage > 2 GB、D1 epoch 数の増加
- [ ] 週次で `celld cell gc --dry-run` と bucket の object 数を確認
- [ ] 運用手順を `docs/operations.md` に追記

## 受け入れ基準

| 指標                  | 目標                                       |
| --------------------- | ------------------------------------------ |
| アイドル Class A      | 18/分以下（可能なら 9/分）                 |
| 現状規模の Class A    | 1M/月未満                                  |
| D1 epoch 増加         | 停止、または 1 時間に 1 回以下             |
| storage               | 増加停止。GC 後 90 MB 前後                 |
| read-only ページ閲覧  | D1 書き込み 0                              |
| 編集 1 時間の Class A | 現状の 1/5〜1/10                           |
| 編集レイテンシ        | 悪化しない（アプリ側の書き込み削減で改善） |
| データ                | 共同編集・検索・履歴・復元が壊れない       |

## 実施順序と目安

1. Phase 0: 30 分
2. Phase 1: 1 時間（GC の完了確認は数時間〜1 日）
3. Phase 2a: 半日
4. Phase 2b: 半日
5. Phase 2c: 1 日（効果測定後）
6. Phase 3: 1 時間 + 判断
7. Phase 4: 30 分
8. Phase 5: 継続

## ロールバック

- configmap: 変更 PR を revert して main に戻す。Flux が同期して rolling update。
  GC で消えたのは到達不能な古い epoch のみ
- アプリ: 変更コミットを revert。スキーマ変更は後方互換にする
- deploy 削除: git から再デプロイ
