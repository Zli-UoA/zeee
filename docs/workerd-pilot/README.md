# workerd パイロット: 障害注入の実行手順

非本番パイロットで再現する障害シナリオ（SIGKILL / rolling restart / rollback）を
`scripts/pilot-fault-injection.mjs` から実行する。マニフェストと前提事項は
[infra/workerd-pilot/README.md](../../infra/workerd-pilot/README.md) を参照（このドキュメントからマニフェストは変更しない）。

## 安全装置

- **既定は dry-run**。`--confirm` を付けない限り kubectl も HTTP も一切呼ばず、実行予定の
  コマンドだけを表示する。
- 実行には `--confirm` と `PILOT_NAMESPACE` / `PILOT_DEPLOYMENT` / `PILOT_BASE_URL` が必要。
- namespace / deployment / pod / base URL のホスト名に `prod` / `zeee` / `main` /
  `master` / `default` を含む名前は拒否する（本番っぽい名前の誤指定を防ぐため）。
- 実トークン・実バケット名・実ホスト名はリポジトリに書かない。_endpoint_ は環境変数と
  プレースホルダだけを扱う。

## 実行例

最初に port-forward を用意し、環境変数を設定する（以下はすべてプレースホルダ）。

```sh
kubectl -n workerd-pilot port-forward deployment/workerd 17900:7000 &
export PILOT_BASE_URL='http://127.0.0.1:17900'   # ローカル port-forward の URL
export PILOT_NAMESPACE='workerd-pilot'           # 非本番 namespace
export PILOT_DEPLOYMENT='workerd'                # パイロット Deployment
export KUBECTL='kubectl'                         # 任意: kubectl の実行ファイル
export PILOT_POD="$(kubectl -n "$PILOT_NAMESPACE" get pods -l app=workerd -o name | head -n 1 | sed 's#^pod/##')"
```

dry-run でコマンドを確認してから、`--confirm` を付けて実行する。

```sh
# まず dry-run（何も実行されない）
node scripts/pilot-fault-injection.mjs kill-pod "$PILOT_POD"
node scripts/pilot-fault-injection.mjs rolling-restart
node scripts/pilot-fault-injection.mjs rollback

# 実行（前後の /api/health + /ready 確認と回復時間 [秒] を出力）
node scripts/pilot-fault-injection.mjs kill-pod "$PILOT_POD" --confirm
node scripts/pilot-fault-injection.mjs rolling-restart --confirm
node scripts/pilot-fault-injection.mjs rollback --confirm

# ヘルスチェックだけ（読み取り専用、--confirm 不要）
node scripts/pilot-fault-injection.mjs check
```

`/api/health` は 200 かつ `{"ok":true}`、`/ready` は 200 を要求する。片方でも失敗すると
終了コードは 1。障害注入後は回復までポーリングし、`recovery time: <秒>s` を出力する
（タイムアウトは 120 秒）。呼び出し引数と回復時間は `tests/pilot-fault-injection.test.ts`
でフェイク kubectl / モック fetch を使って検証しているため、実クラスタへの接続は不要。

## kashu さん側で実施するシナリオ

以下の 2 つはこのスクリプトでは自動化しない。**時刻ずれ / バケット障害は kashu さん側で実施**する。

- **clock skew**: 非本番の 1 ノードだけ時刻を意図的にずらし（例: chrony の同期を一時停止して
  オフセットを設定）、リース／フェンシングへの影響と復旧後の自動収束を確認する。作業後に
  必ず時刻同期を戻す。
- **bucket outage**: パイロット用バケットの endpoint への通信を一時的に遮断するか、誤った
  credential を設定して Pod を再起動し、再起動ループや split-brain が出ないことと、
  復旧後に手動介入なしで戻ることを確認する。本番バケット / 本番 credential は絶対に触らない。

計測結果は [infra/workerd-pilot/README.md](../../infra/workerd-pilot/README.md) の
「計測すべき指標」「障害注入リスト」に沿って記録する。
