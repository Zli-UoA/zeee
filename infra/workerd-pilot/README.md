# workerd パイロット環境マニフェストの雛形

> **⚠️ EXPERIMENTAL / 非本番専用。** workerd のクラスタモードは `--experimental`
> であり、無停止デプロイも未解決（cloudflare/workerd [#8155](https://github.com/cloudflare/workerd/issues/8155)
> / [#8176](https://github.com/cloudflare/workerd/pull/8176)）。**本番データ・本番 credential・
> 実ホスト名は一切使わないこと。** このディレクトリは非本番パイロットの雛形のみを提供する。
> 評価・判断の背景は [../../docs/workerd-migration.md](../../docs/workerd-migration.md) を参照。

## 構成

3 ノード + 1 共有バケット。各 Pod は `--cluster-addr` でクラスタに参加し、
各 Durable Object（このアプリでは **1 ページ = 1 `PAGE_ROOM`**）は常に 1 つの
オーナーだけが保持する。オーナー死亡時は別ノードが**バケットへの条件付き書き込み**で
オーナーシップを引き継ぐ。バケットが権威コピーを持つので Pod のローカル状態は
`emptyDir`（使い捨て）でよい。

| ファイル                                            | 内容                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.yaml`                                   | 3 replicas の Deployment。固定版数の workerd イメージ、`--experimental --cluster-addr`、Secret 参照の認証情報、`/ready` readinessProbe、`preStop`、リソース制限。 |
| `service.yaml`                                      | クライアント用 Service と、ピア検出用の headless Service。                                                                                                        |
| `configmap.yaml`                                    | キーとプレースホルダのみ。適用前に非本番バケットへ合わせて書き換える。                                                                                            |
| `secret.example.yaml`                               | **キー名だけの参考**。実秘密は絶対に書かず、このファイルは apply しない。                                                                                         |
| `systemd/workerd.service`, `systemd/workerd.socket` | workerd README の socket activation 例をベースにした 1 ノード用参考例。                                                                                           |

## 前提（必須条件）

1. **バケットは CAS（Conditional Write）と read-after-write 整合性を提供すること。**
   S3 互換（R2 / S3）または GCS を使う。オーナー調整とログの永続化がこれに依存する。
2. **バケットのライフサイクルで未完成マルチパートアップロードを破棄すること。**
   設定しないと、途中で終わったアップロードの断片が残り続ける（workerd README の明記事項）。
3. **ピア間通信は平文。** 必ずプライベートネットワーク内で運用すること。
   workerd は公開 IP の cluster addr を拒否し、私用 IPv4
   （`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`）のみ受け付ける。
   IPv6 の pod IP は `--cluster-addr` に使えない。
4. **TLS は前段の Ingress / LoadBalancer で終端する。** このマニフェストには
   Ingress も TLS 証明書も含めない。
5. **バケットへの書き込み権限 = コード公開権限。** クラスタキーとバケット credential は
   同じだけ慎重に管理し、パイロット用の専用権限だけを Pod に渡す。
6. **固定バージョンを使う。** `deployment.yaml` の
   `docker.io/cloudflare/workerd:1.20261127.1` は
   [`tools/workerd/package.json`](../../tools/workerd/package.json) の pinned version と
   一致させる。experimental 中はバージョン間でピアプロトコルが変わり得るため、
   mixed-version の時間を最小化し、全ノードを同じ版数に揃えること。
7. **本番データは移さない。** DO の ID は (deployment 名, クラス名, storage key) なので、
   名前を変えるとデータが空から始まる。パイロットでも `zeee` /
   `PageRoomDurableObject` / migration tag は変更しないこと。
8. **Pod Security は "restricted" 相当。** イメージは distroless でシェルも `sleep` も
   ないため、`exec` 系の lifecycle hook は使わない（`preStop.sleep` は Kubernetes
   1.30+ で既定有効の `PodLifecycleSleepAction` を利用）。

> 本番相当のクラスタで使う場合は、upstream サンプルにある PodDisruptionBudget と
> NetworkPolicy（cluster port 7000 をピアだけに制限）も合わせて追加すること。

## 起動手順（Kubernetes）

以下はすべて**非本番**の namespace / バケットに対して実行する。`<...>` は
環境に合わせて置き換えるプレースホルダであり、実値をこのリポジトリへ書き戻さないこと。

1. namespace を用意する。

   ```sh
   kubectl create namespace <PILOT_NAMESPACE>
   ```

2. Secret を**コマンドで**作成する（値はリポジトリに置かない）。

   ```sh
   kubectl -n <PILOT_NAMESPACE> create secret generic workerd-pilot-cluster \
     --from-literal=key="$(openssl rand -hex 32)"
   kubectl -n <PILOT_NAMESPACE> create secret generic workerd-pilot-bucket \
     --from-literal=access-key="<PILOT_ACCESS_KEY_ID>" \
     --from-literal=secret-key="<PILOT_SECRET_ACCESS_KEY>"
   ```

   `secret.example.yaml` はキー名の確認用だけ。`apply` しないこと。

3. `configmap.yaml` の `WORKERD_CLUSTER_BUCKET` / `AWS_ENDPOINT_URL` / `AWS_REGION`
   を**パイロット用バケット**に合わせて編集してから適用する。

   ```sh
   kubectl -n <PILOT_NAMESPACE> apply -f configmap.yaml
   ```

   GCS を使う場合は `gs://<BUCKET>/<PREFIX>` に変更し、`AWS_*` の代わりに
   `GOOGLE_APPLICATION_CREDENTIALS` を Secret から渡す（Workload Identity 推奨）。

4. アプリ image を用意する。workerd のコンテナ image にビルド済み Wrangler プロジェクトを
   `COPY` したものを使う。`no_bundle: true` とビルド済みの `.js` / `.mjs` エントリが必須
   （image に esbuild は入っていない）。このリポジトリの
   `pnpm build:celld` と [`scripts/prepare-workerd-config.mjs`](../../scripts/prepare-workerd-config.mjs)
   で生成した `dist/wrangler.json` を元にできるが、パイロット用の設定であることを確認すること。
   `deployment.yaml` の `image:` をその image に差し替える（タグはビルドごとに新しくする）。

5. Deployment と Service を適用する。

   ```sh
   kubectl -n <PILOT_NAMESPACE> apply -f deployment.yaml -f service.yaml
   kubectl -n <PILOT_NAMESPACE> rollout status deployment/workerd
   ```

6. 生存確認をする。

   ```sh
   kubectl -n <PILOT_NAMESPACE> port-forward deployment/workerd 17900:7000
   curl -fsS http://127.0.0.1:17900/ready   # 200 = serving / 503 = starting or stopping
   kubectl -n <PILOT_NAMESPACE> get endpoints workerd-cluster-headless
   ```

   クライアント traffic は Service `workerd`（ClusterIP :80 → container :8080）へ流す。
   外部公開と TLS 終端は前段の Ingress の役割。

### ピアアドレスの渡し方

`deployment.yaml` は `--cluster-addr=$(POD_IP):7000` で **pod IP をそのまま広告**する
（upstream Kubernetes サンプルと同じ方式）。`service.yaml` の headless Service は
ピアの検出・到達性確認のための補助で、DNS 名を広告する場合は
`<pod>.workerd-cluster-headless.<PILOT_NAMESPACE>.svc:7000` へ置き換えること。
どちらの場合も IPv4 私用アドレスであることと、ピア間が平文であることを守る。

### クラスタキーの渡し方（別案）

`deployment.yaml` は `WORKERD_CLUSTER_KEY` を Secret から環境変数で渡しているが、
upstream サンプルのように Secret を `/etc/workerd-cluster/key` に mount し、
`WORKERD_CLUSTER_KEY_FILE=/etc/workerd-cluster/key` を使うこともできる。
切り替える場合は env の `secretKeyRef` を置き換え、`volumeMounts` / `volumes` に
read-only の Secret mount を追加すること（キーを env に残さない分だけ安全）。

## 起動手順（systemd / 1 ノード参考例）

クラスタではなく、単一ノードで socket activation の動作を確認したい場合の例。

1. `/usr/bin/workerd` のパスと `/etc/workerd/config.capnp` を環境に合わせる。
   config.capnp には socket name `http` を定義し、`workerd.socket` が開く 8080 を
   `workerd.service` の `--socket-fd http=3` で受け取る。
2. クラスタに参加する場合のみ `/etc/workerd/workerd.env`（**-git 管理外**）に
   `WORKERD_CLUSTER_KEY` / `WORKERD_CLUSTER_BUCKET` / `AWS_*` を書き、
   `ExecStart` に `--cluster-addr=<PRIVATE_IPV4>:7000` を追加する。単一ノードでは不要。
3. 有効化する。

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now workerd.socket
   sudo systemctl status workerd.service
   ```

`StateDirectory=workerd` が `/var/lib/workerd` を作るので、`--data-dir` のパスと
一致していることを確認すること。

## 計測すべき指標

| 指標                                        | 測り方                                                                                                        | 見る点                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 書き込みレイテンシ（1 ノード vs 2+ ノード） | 同一の Wiki 書き込み（ページ更新 + Yjs update）を 1 ノード構成と 3 ノード構成で連続実行し、p50 / p99 を比較。 | バケットへの sync 完了まで ACK が返らないため、ノード数が増えるほど遅く／高価になる。        |
| S3 Class A リクエスト数                     | アイドル時・負荷時の PUT / GET / HEAD / List をバケットのメトリクスで 1 分ごとに記録。                        | 現在の celld はアイドル時でも約 72 ops/分（移行レポート §3.3）。パイロットで増減を比較する。 |
| D1 単一 DO のスループット上限               | 1 つの D1 DB（= 1 DO）と 1 つの `PAGE_ROOM` に対して書き込みを増やし、エラー／詰まりが出る閾値を記録。        | D1 / KV は 1 ネームスペース = 1 DO なので、スループットは 1 オブジェクトの上限に縛られる。   |
| フェイルオーバー時間                        | オーナー Pod を停止してから次の成功リクエストまでの時間を計測。WebSocket の 1012 発生数と再接続時間も記録。   | `/ready` が 503 の間に traffic がどう外れるか、DO の引き継ぎが 8s 内に収まるか。             |

計測値と障害注入の結果は 30 日間記録し、移行レポートの Go / No-Go ゲート判断に使う。

### 計測の実行例

`scripts/pilot-measure.mjs` は `POST /api/pages/:id/snapshot`（D1 materialize + DO snapshot）を
繰り返し叩き、レイテンシとエラーを計測する。**既定では送信せず dry-run の計画だけを表示する**。
実ページを更新するリクエストを送るには `--confirm` が必須で、実行前に警告を出す。要求数は
既定 20 リクエスト / 並列 1。`--page-id` を省略すると `GET /api/pages?limit=1` から 1 つ選ぶが、
ホスト名だけでなく URL 全体と page id に `prod` / `zeee` / `main` / `master` / `default`
が含まれる場合は拒否する（誤って本番を更新しないためのガード）。

```sh
# まずは計画だけを確認（HTTP リクエストなし）
node ../../scripts/pilot-measure.mjs --target <PILOT_BASE_URL> --page-id <PAGE_ID>

# 実行する場合のみ --confirm を付ける（非本番パイロット専用）
ZEEE_SESSION_COOKIE='<PILOT_SESSION_COOKIE>' \
  node ../../scripts/pilot-measure.mjs --target <PILOT_BASE_URL> --page-id <PAGE_ID> \
    --confirm --requests 100 --concurrency 8 --label 1-node --out reports/1-node.json
```

レプリカ数を変えた構成でも `--label` だけ変えて同じコマンドを実行し、`p50` / `p95` / `p99` と
`errorRate` を比較する。JSON は stdout と `--out` に出力され、進捗と警告は stderr に出る。
4xx/5xx は例外にせず `errorRate` / `statusCounts` に集計するが、**エラーだけで終了コードは
変わらない**。失敗と判定するには `--max-error-rate` / `--max-p95-ms` で閾値を指定する
（閾値は四捨五入前のエラー率で比較）。閾値違反（`violations`）がある場合のみ終了コード 1。
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `R2_BUCKET` を設定すると、実行前後の
Class A 操作数を `classA` に記録する。Cloudflare GraphQL では `bucketName` / `datetime_geq`
で絞り、`actionType` が Class A（PutObject 等）のグループだけ合算し、GetObject などの
Class B は除外する。実トークンや実バケット名はリポジトリへ書き戻さないこと。

## 障害注入リスト

| シナリオ        | 手順の例                                                                                  | 確認点                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SIGKILL         | オーナー Pod を `kubectl delete pod <POD> --grace-period=0 --force` で即時削除。          | DO が別ノードへ移るか、書き込みが欠損／重複しないか。                                                            |
| rolling restart | 書き込みを流し続けながら `kubectl rollout restart deployment/workerd`。                   | 失敗リクエスト数、リビジョン番号の飛び、WebSocket 再接続（1012）の挙動。無停止デプロイは未解決なので切断は前提。 |
| bucket outage   | バケット endpoint への通信を遮断（または一時的に誤 credential を設定）して Pod を再起動。 | 再起動ループと回復挙動、split-brain にならないこと。復旧後に手動介入なしで戻るか。                               |
| clock skew      | 1 ノードの時刻を意図的にずらす（**非本番のみ**）。                                        | リース／フェンシングへの影響（workerd #8830 の再現確認）。                                                       |
| rollback        | 前の固定タグへ image を戻して `kubectl rollout undo`。                                    | バケット形式の前方／後方互換性、mixed-version 期間のエラー、DO データの可読性。                                  |

## 後片付け

```sh
kubectl -n <PILOT_NAMESPACE> delete -f service.yaml -f deployment.yaml -f configmap.yaml
kubectl -n <PILOT_NAMESPACE> delete secret workerd-pilot-cluster workerd-pilot-bucket
# パイロット用バケット / プレフィックスの削除も忘れないこと (本番バケットは触らない)。
```

## 参照

- [workerd 移行調査レポート](../../docs/workerd-migration.md)（§6: 非本番パイロットとゲート基準）
- [workerd README](https://github.com/cloudflare/workerd/blob/main/README.md)（cluster mode / systemd example）
- [workerd container image README](https://github.com/cloudflare/workerd/blob/main/docker/README.md)（タグと `no_bundle`）
- [PR #7994](https://github.com/cloudflare/workerd/pull/7994)（celld 相当機能の統合開始）
- [PR #8274](https://github.com/cloudflare/workerd/pull/8274)（3 Pod の Kubernetes サンプル）
- [local smoke test](../../scripts/workerd-smoke.sh)（固定版数の workerd での起動確認）
