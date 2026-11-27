# workerd パイロット環境 構築引き継ぎ依頼書（インフラ担当 宛）

- 依頼先: インフラ担当（kashu）
- 対象: **非本番**の workerd クラスタパイロット（3 ノード + 1 共有バケット）
- 根拠: [workerd 移行調査レポート](./workerd-migration.md) §6「1〜3 ヶ月（非本番パイロット）」の Go / No-Go ゲート

> **⚠️ EXPERIMENTAL / 非本番専用。** workerd のクラスタモードは `--experimental` であり、
> 無停止デプロイも未解決（cloudflare/workerd [#8155](https://github.com/cloudflare/workerd/issues/8155)
> / [#8176](https://github.com/cloudflare/workerd/pull/8176)）。**本番データ・本番 credential・
> 実ホスト名は一切使わないこと。** 判断の背景は [移行調査レポート](./workerd-migration.md) を参照。
>
> この依頼書には**実トークン / 実ホスト / 実バケット名 / 実 IP を記載していない**。
> 値はすべて環境変数名と `<...>` プレースホルダで示し、実際の値はリポジトリ外で管理する。
> 既存の本番バケット名は「流用しない」旨の参照としてのみ登場し、新規パイロットの実名は書かない。

## 1. 依頼範囲

`infra/workerd-pilot/` の雛形を**非本番**環境に適用し、パイロット用の基盤を用意してほしい。
各作業の詳細手順は [`infra/workerd-pilot/README.md`](../infra/workerd-pilot/README.md) に沿う。

| #   | 作業                           | 要件・注意点                                                                                                                                                                                                                           |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | パイロット用 R2 バケット作成   | S3 互換バケット（R2 等）で **conditional write（CAS）** と **read-after-write** 整合性をサポートすること。ライフサイクルで**未完成マルチパートアップロードを破棄**する設定を入れること。パイロット専用 credential を発行する。         |
| 2   | k8s namespace / マニフェスト   | 3 ノード用に専用 namespace を作り、`infra/workerd-pilot/` の Deployment（3 replicas）+ **headless Service**（ピア検出用）+ ConfigMap を適用する。`configmap.yaml` のプレースホルダはパイロット用バケットへ差し替える（書き戻さない）。 |
| 3   | TLS 終端 / 外部公開            | Traefik Ingress または Cloudflare Tunnel で TLS を終端する。雛形には Ingress / 証明書を含めない。                                                                                                                                      |
| 4   | ピア間プライベートネットワーク | ピア間通信は**平文**なので、必ずプライベートネットワーク内で運用する。`--cluster-addr` には IPv4 私用アドレス（詳細は README）のみを使い、cluster port `7000` はピアだけに解放する（NetworkPolicy 推奨）。                             |
| 5   | Secret 登録                    | §2 のキーを `kubectl create secret` で登録する。`secret.example.yaml` はキー名の確認用で **apply しない**。                                                                                                                            |
| 6   | DNS / ホスト名                 | パイロット専用ホスト名 `<PILOT_HOST>` を用意し、TLS 終端へ向ける。本番のホスト名・DNS レコードは変更しない。                                                                                                                           |

**バケットは既存の `zeee-fleet` を流用しない。** `zeee-fleet` は本番 celld の永続化先であり、
パイロットの実験で CAS ログやフレームを混在させると本番データに影響する。
**別バケット（`<PILOT_BUCKET>` / `<PILOT_PREFIX>`）を新規作成すること。**

アプリ側の image は `pnpm build:celld` と
[`scripts/prepare-workerd-config.mjs`](../scripts/prepare-workerd-config.mjs) で生成した
`dist/wrangler.json` を元に用意するので、`deployment.yaml` の `image:` 差し替えはアプリ側と調整する。

## 2. 必要な環境変数 / Secret

実値は書かない。**キー名と取得元だけ**を記載する。Secret はリポジトリへコミットせず、
クラスタ上で `kubectl create secret` により作成する。

| 名前                                                                                                     | 置き場所                                                   | 値の取得元 / 生成方法                                                                             |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WORKERD_CLUSTER_KEY`                                                                                    | Secret `workerd-pilot-cluster` / key `key`                 | `openssl rand -hex 32` で生成（32 bytes）。全ノードで同じ値を共有する。                           |
| `WORKERD_CLUSTER_BUCKET`                                                                                 | ConfigMap `workerd-pilot-config`                           | `s3://<PILOT_BUCKET>/<PILOT_PREFIX>`（GCS の場合は `gs://<PILOT_BUCKET>/<PILOT_PREFIX>`）。       |
| `AWS_ENDPOINT_URL` / `AWS_REGION`                                                                        | ConfigMap `workerd-pilot-config`                           | パイロット用 S3 互換 endpoint / region（リポジトリにはプレースホルダのみ）。                      |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                                                            | Secret `workerd-pilot-bucket` / `access-key`, `secret-key` | パイロット用バケットにのみ書き込み権限を持つ専用 credential。                                     |
| `WORKERD_SHUTDOWN_DELAY_MS` / `WORKERD_CLUSTER_STOP_TIMEOUT_MS`                                          | ConfigMap `workerd-pilot-config`                           | 雛形の既定値（停止中の引き継ぎ時間）を使用。変更する場合は README の Note を参照。                |
| `PUBLIC_ORIGIN` / `AUTHZ_ISSUER` / `AUTHZ_CLIENT_ID` / `EMOJI_SERVICE_URL` / `EMOJI_ACCOUNT_PROFILE_URL` | アプリ vars（`void.config.ts` の `cloudflare.vars`）       | パイロット用の到達可能な値に設定し直す。本番値は使わない（絵文字アカウント URL は到達性に注意）。 |
| `ZEEE_MIGRATION_IMPORT`                                                                                  | アプリ vars                                                | パイロットでは `''`（無効）のまま。移行用インポートは本番切替時の別手順で扱う。                   |
| `ZEEE_BASE_URL` / `ZEEE_SESSION_COOKIE`                                                                  | スクリプト実行時のローカル環境変数                         | [`scripts/export-do-state.mjs`](../scripts/export-do-state.mjs) 用。値はどこにも保存しない。      |

クラスタキーを保持すると全サービスへのフルアクセスを持つことになるため、
バケット credential と同じ粒度で管理する。Secret をファイルに落とす場合は git 管理外に置くこと。

## 3. 受け入れ基準

以下をすべて満たした時点でパイロット基盤を「構築完了」とする。チェックはログ / メトリクスを残すこと。

- [ ] 3 ノードすべてで `GET /ready` が **200** を返す（起動中 / 停止中は 503）。
- [ ] **1 ページ = 1 DO** の対応が成立し、同じページが**どのノードからも到達**できる。
- [ ] オーナー Pod を停止すると、別ノードがバケットへの条件付き書き込みでオーナーシップを**引き継ぐ**。
- [ ] SIGKILL 後の再起動で、DO の state（Yjs update / 履歴）がバケットから**復元**される。
- [ ] ローリング更新時に WebSocket が切断（**1012**）して再接続しても、**データが失われない**。
      （無停止デプロイは未解決なので切断自体は想定内。再接続後の差分が欠けないことを確認する。）
- [ ] パイロット用バケット / namespace / Secret / DNS が本番環境と分離されている（この文書の §6「境界」）。

## 4. 実行手順と zeee 側の材料

1. まず [`infra/workerd-pilot/README.md`](../infra/workerd-pilot/README.md) の「起動手順（Kubernetes）」を
   上から順に実行する（namespace → Secret → ConfigMap → image → Deployment / Service → `rollout status` → `/ready`）。
2. 障害注入の前後に、比較用のバックアップを取得する。

   ```sh
   node scripts/export-do-state.mjs --out "$BACKUP_DIR/state" --dry-run  # 対象 ID の確認
   node scripts/export-do-state.mjs --out "$BACKUP_DIR/state"            # active + ゴミ箱の生 Yjs state
   ```

   使い方は [`scripts/export-do-state.mjs`](../scripts/export-do-state.mjs) の `--help` と
   [`docs/operations.md`](./operations.md) のバックアップ手順を参照。実セッション cookie は端末内だけで扱う。

3. 計測には zeee 側で準備する `scripts/pilot-measure.mjs`（別タスクで追加予定）を使う。
   障害注入には同じく `scripts/pilot-fault-injection.mjs`（別タスクで追加予定）を使い、
   **kubectl / バケット / ノード時刻の操作はインフラ側**で実行する。
   スクリプトの CLI は各ファイルの `--help` を確認すること。

4. 結果は 30 日間記録し、[移行調査レポート](./workerd-migration.md) §6 の Go / No-Go ゲート判断に渡す。

### 計測する 4 指標

| 指標                                        | 測り方                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 書き込みレイテンシ（1 ノード vs 2+ ノード） | 同じページ更新（本文 + Yjs update）を 1 ノード構成と 3 ノード構成で連続実行し、p50 / p99 を比較する。 |
| S3 Class A リクエスト数                     | アイドル時 / 負荷時の PUT / GET / HEAD / List をバケットのメトリクスで 1 分ごとに記録する。           |
| D1 単一 DO のスループット上限               | 1 つの D1 DB（= 1 DO）と 1 つの `PAGE_ROOM` に書き込みを増やし、エラー / 詰まりが出る閾値を記録する。 |
| フェイルオーバー時間                        | オーナー Pod 停止から次の成功リクエストまでを計測。WebSocket の 1012 発生数と再接続時間も記録する。   |

### 障害注入リスト

| シナリオ        | 実行側         | 確認点                                                                                           |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| SIGKILL         | アプリ＋ infra | オーナー即時削除後に DO が別ノードへ移り、書き込みが欠損 / 重複しないこと。                      |
| rolling restart | アプリ＋ infra | 書き込みを流し続け、失敗リクエスト数 / リビジョンの飛び / WebSocket 1012 の挙動を記録する。      |
| bucket outage   | **infra**      | バケット endpoint を遮断または誤 credential で再起動し、split-brain にならず復旧すること。       |
| clock skew      | **infra**      | 1 ノードの時刻を意図的にずらし（非本番のみ）、リース / フェンシングへの影響を確認する（#8830）。 |
| rollback        | アプリ＋ infra | 前の固定タグへ戻し、バケット形式の前方 / 後方互換性と DO データの可読性を確認する。              |

後片付け手順も [`infra/workerd-pilot/README.md`](../infra/workerd-pilot/README.md) に記載されている。
パイロット用バケット / プレフィックスの削除も忘れないこと（本番バケットは触らない）。

## 5. zoo2-infra 用 GitHub Issue 本文テンプレート

**このリポジトリ（zeee）では Issue を作成しない。** 以下をそのまま zoo2-infra の Issue 本文として
貼り付けて利用する。`<...>` は貼り付け時に設定するプレースホルダのままにすること。

```markdown
## タイトル

[workerd pilot] 非本番 3 ノード cluster の構築と計測環境を用意してほしい

## 背景

zeee は self-hosted celld（v0.6.3 で事実上凍結）から workerd への移行を検討している。
workerd の cluster mode はまだ `--experimental` で、無停止デプロイや一部の整合性バグが未解決。
本番は変更せず、まず非本番で 3 ノード + 1 共有バケットのパイロットを 30 日間運用し、
Go / No-Go ゲートの判断材料（レイテンシ / コスト / フェイルオーバー）を集めたい。
アプリ側の資料: zeee の `docs/workerd-pilot-handoff.md` / `infra/workerd-pilot/README.md`

## 作業項目

- [ ] パイロット専用 R2（S3 互換）バケットを作成する。CAS（conditional write）と
      read-after-write 整合性を確認し、未完成マルチパートアップロードを破棄するライフサイクルを設定する。
      **既存の本番 celld 用バケットは流用しない。**
- [ ] 3 ノード用の k8s namespace を作成し、zeee の `infra/workerd-pilot/` にある
      Deployment / headless Service / ConfigMap を適用する。
- [ ] Traefik または Cloudflare Tunnel で TLS を終端し、パイロット専用ホスト名を割り当てる。
- [ ] ピア間通信用のプライベートネットワークを確保し、cluster port をピア以外に公開しない。
- [ ] `WORKERD_CLUSTER_KEY` / バケット credential / アプリ vars を Secret として登録する
      （実値はリポジトリに書き込まない）。
- [ ] `/ready` が 3 ノードすべて 200 になることを確認し、計測と障害注入の窓を設ける。

## 受け入れ基準

- [ ] 3 ノードすべて `/ready` が 200。
- [ ] 1 ページ = 1 DO がどのノードからも到達できる。
- [ ] オーナー死亡時に別ノードが引き継ぐ。
- [ ] SIGKILL 後の再起動で state が復元される。
- [ ] ローリング更新で WebSocket が再接続（1012）してもデータが失われない。

## 連絡先

- アプリ側担当: <POC_NAME> / Slack: <SLACK_HANDLE>
- インフラ側担当: kashu / Slack: <INFRA_SLACK_HANDLE>
- 作業開始予定: <START_DATE> / 計測期間: 30 日間
```

## 6. 境界（この PR でやらないこと）

- この PR は **zeee 内のドキュメントのみ**。コード / CI / マニフェスト / 依存の変更はない。
- **zoo2-infra の変更 / PR / マージは行わない**。上記 Issue 本文は zeee 内に示すだけとし、
  Issue の作成は行わない（貼り付け先は zoo2-infra）。
- 実クラスタ操作・R2 バケット作成・DNS 変更は行わず、実作業はインフラ担当（kashu）に委譲する。
- 本番 celld 環境（`zeee-fleet` バケット、StatefulSet、本番 deploy workflow）は**変更しない**。
- [`docs/workerd-migration.md`](./workerd-migration.md) は最終承認済みのため変更しない（この文書からのリンクのみ）。
