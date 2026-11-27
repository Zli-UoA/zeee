# workerd パイロット: 障害注入の実行手順

実行手順・安全装置・計測指標は [infra/workerd-pilot/README.md](../../infra/workerd-pilot/README.md)
が single source of truth（この PR では infra 側を変更しない）。

## 注記（スクリプトの出力を解釈する前に読むこと）

- **kill-pod は clean handoff の検証に使えない**: `--grace-period=0 --force` は
  `preStop.sleep`(5s) / `WORKERD_SHUTDOWN_DELAY_MS=20000` /
  `WORKERD_CLUSTER_STOP_TIMEOUT_MS=8000` の正常なシャットダウン経路を丸ごとスキップし、
  Durable Object の別ノードへの移譲を飛ばす。「データ欠損なし」の根拠に使わず、
  その目的には `rolling-restart` を使うこと。
- **`recovery time` は heuristic**: `/api/health` 200 `{"ok":true}` と `/ready` 200 を
  待つだけなので、DO のハンドオフ完了は保証しない。`rollback` は `rollout status` も
  待つが、それでも DO 移譲の完了は証明しない。WebSocket の 1012 / 再接続 /
  DO オーナーシップの移譲は別途確認すること。
- **port-forward と kill-pod 対象の重複に注意**: port-forward が障害対象 Pod を指すと
  Pod 削除で forward が切れ、network error → 120s タイムアウト（偽陰性）になる。
  逆に別 Pod の probe 成功で「数秒で回復」と出力され得る。Service 宛または障害対象外の
  Pod を指し、どの Pod が応答したかを確認してから数値を使うこと。
- 既定は dry-run、`--confirm` と `PILOT_*` env が必須。本番っぽい名前と base URL
  （path を含む全体）は拒否する。詳細は `node scripts/pilot-fault-injection.mjs --help`
  と infra README を参照。
