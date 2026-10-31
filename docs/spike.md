# celld spike の設計と検証

状態: ローカル spike 完了。R2 の storage test は pass。本番配備・実 AuthZ token exchange・2 ノード fleet は未実施。

## 目的

Zli のメンバー向けに、esa のように Markdown ページを共同編集できるドキュメントツールを作る。計算は zli のインフラ、認証は AuthZ、本文の同時編集は Yjs、1 ページ = 1 Durable Object という構成を celld で検証する。

## 決定

| 項目       | 決定                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| 実行基盤   | celld 0.6.2。Void + Vite+ 1.4.0 でビルドし、`celld deploy dist`        |
| fleet 管理 | celld-operator は使わない。本番は StatefulSet を自分で持つ             |
| durability | まず `bucket` × 2 pods。R2 が durability root。fleet は後で比較        |
| ストレージ | R2 専用 bucket。Garage は conditional write 非対応のため使わない       |
| 認証       | AuthZ OIDC。public client + PKCE S256。scope は `openid profile`       |
| 会員制限   | なし。AuthZ アカウントを持つ人は全員使える                             |
| 編集権限   | 全員が全ページを編集。ページ単位 ACL なし                              |
| 編集モデル | ライブ編集。下書き / 公開の区別なし                                    |
| 本文       | 1 ページ = 1 Durable Object。Yjs `Y.Text` に Markdown をそのまま入れる |
| メタデータ | D1。タイトル、ページ、revision、セッション                             |
| 検索       | D1 FTS5（trigram）。2 文字以下は LIKE fallback                         |
| 履歴       | 10 分ごとの自動 revision + 手動保存 + restore 前                       |
| MVP 外     | コメント、添付、通知、タグ、スペース、ページツリー、ACL                |

## 構成

```text
Browser (CodeMirror 6 + Yjs + Awareness)
  │ HTTPS / WSS
  ▼
Cloudflare Tunnel → Traefik → celld
                               ├─ Worker zeee
                               │   ├─ AuthZ OIDC / session
                               │   ├─ D1: app_user, session, page, page_body, revision, page_fts
                               │   └─ /api/pages/:id/ws → PageRoom
                               └─ PageRoom Durable Object
                                   ├─ Y.Doc (Y.Text "markdown")
                                   ├─ doc_snapshot / doc_update (SQLite)
                                   ├─ WebSocket broadcast
                                   └─ alarm: D1 materialize, revision, compaction
```

- Worker は `PageRoom.get(pageId)` で DO を呼ぶ。DO は `x-zeee-user` などの内部ヘッダだけを信頼する。
- WebSocket は DO の hibernatable WebSocket を使う。`ping` / `pong` は `setWebSocketAutoResponse` で cell を起こさず返す。
- 初期同期は HTTP の `/api/pages/:id/state`。その後は WS で state vector の差分と更新をやり取りする。
- クライアントは `y-collab` で CodeMirror と `Y.Text` を接続する。Awareness はメモリだけ。
- DO の alarm が 1 秒 debounce で D1 の `page_body` と FTS を更新する。自動 revision は 10 分間隔。
- snapshot は update が 300 件を超えたとき、または 5 分経過したときに作り、古い update を削除する。

## D1 のデータ

```text
app_user(id, issuer, subject, username, display_name, ...)
session(id = sha256(token), user_id, expires_at, ...)
login_flow(state, nonce, code_verifier, return_to, ...)
page(id, title, created_by, created_at, updated_at, deleted_at)
page_body(page_id, markdown, updated_at)
revision(id, page_id, version, markdown, author_id, manual, created_at)
page_fts(page_id, title, body)  -- FTS5 trigram
audit_event(...)
```

DO の SQLite:

```text
doc_snapshot(id = 1, state BLOB, seq, created_at)
doc_update(seq, data BLOB, actor_id, created_at)
```

## ローカルで確認できたこと

`pnpm check` / `pnpm test` / `pnpm spike` で確認済み。

- Vite+ の format / lint / type check と Vitest の単体テスト
- AuthZ の discovery、authorize URL、end-session URL（client_id / PKCE / scope / redirect）
- R2 `celld diagnose`（conditional write の create / reject-create / update / reject-stale）
- dev セッション発行と D1 スキーマ作成
- ページ作成、2 クライアントの Yjs 更新の収束
- D1 への本文 materialize
- FTS5 trigram による日本語検索
- 手動 revision、restore
- `celld dev` 再起動後の本文の保持

ブラウザでも確認済み。

- 一覧、検索、ページ作成フォーム
- CodeMirror での入力、接続状態、在席表示
- 版の保存と履歴表示
- 再読み込み後の本文表示
- 読み物ビュー（GFM の表・コード・引用・リンク）と閲覧 / 編集の切替
- 読み物ビューでのライブ更新（別ユーザーの追記がリロードなしで反映）
- モバイル幅での読み物ビューと操作

## まだ確認していないこと

1. **AuthZ の実 OIDC 交換**。public client は登録済みで、discovery / authorize URL / end-session URL は確認済み。実際の token exchange と ID token 検証は、redirect URI に到達できる環境（`zeee.zli.works` か localhost の登録）で未実施。
2. **R2 の storage contract**。`celld diagnose` は pass。`cas-hammer` は未実行だが、R2 は celld の qualified store なので必須ではない。Garage は不可。
3. **2 ノード fleet**。`CELLD_DURABILITY=bucket` の 2 pods、ノード障害時のフェイルオーバー、WebSocket の 1012 再接続は未検証。
4. **Cloudflare Tunnel / Traefik 越しの WSS**。ping / idle timeout、drain 中の 503、1012 の扱い。
5. **`celld d1 migrations apply`**。live node の internal listener へクラスタ内 Job から到達する経路。
6. **operator なしの rolling update**。`celld deploy` 後の in-place adoption を 1 台ずつ制御する手順。
7. **メモリと配置**。2 pods × 1 GiB を worker nodes に置けるか。`CELLD_MAX_RESIDENT_CELLS` の実測。
8. **バックアップ / restore**。R2 は object versioning 非対応。D1 + Markdown の論理 export と、別 bucket へのコピー / bucket lock で設計する。

## 本番の形（案）

```text
Traefik → celld (2 pods, bucket durability)
  ├─ R2 zeee-fleet: deployments, DO SQLite, D1
  └─ Worker zeee:
       D1 zeee
       PageRoom DO
```

- celld は公式 image `ghcr.io/denoland/celld:v0.6.2` を digest で pin。
- StatefulSet 2 replicas、headless Service、`publishNotReadyAddresses`、PDB `minAvailable: 1`。
- `CELLD_ADVERTISE=$(POD_NAME).<CELLD_HEADLESS_SERVICE>:8081`。
- `CELLD_SHUTDOWN_TOTAL_MS=40000`、`terminationGracePeriodSeconds: 60`。
- readiness は `/.well-known/celld/health`、liveness は TCP。
- NetworkPolicy で 8081 を peer と migration Job だけに閉じる。
- Traefik IngressRoute は自分で持つ。`hostnames` は使わない。
- deploy は CI の `celld deploy`。migration はクラスタ内 Job。
- R2 は専用 bucket。object versioning はない。監視用 Garage と共有しない。backup は論理 export と別 bucket で設計する。

## 既知の制約

- celld は alpha。Worker 名と DO クラス名は固定。rename すると DO ID が変わる。
- celld の `Cache API` は常に miss。`request.cf` の geo / colo はない。
- `CELLD_DURABILITY=bucket` は書き込みごとに R2 待ち。編集の体感が重ければ 2 ノードの `fleet` + PVC に上げる。
- D1 は single writer。検索 index の更新は debounce している。
- D1 の `dump()` は使えない。backup は D1 + Markdown の export と、別 bucket の bucket lock で設計する。
- WebSocket は cell 移動で 1012。クライアントは再接続する。
- 現状の session は opaque token。secret 署名鍵を持たない代わりに D1 参照。
- CSRF は SameSite=Lax + Origin 検査。本番でフォームを増やすなら token を足す。
- `ZEEE_DEV_AUTH=1` の間は、リダイレクト / cookie / WebSocket の Origin 判定を実際のアクセス origin 基準にする。`PUBLIC_ORIGIN` が `127.0.0.1` でも LAN IP や `localhost` から開いて WS が 403 にならない。
- `pages/index.server.ts` の action は `Origin` を見る。dev auth は GET なので開発専用。

## 次の作業

1. AuthZ の実ログインを通す。public client は登録済み。
2. StatefulSet / Service / NetworkPolicy / PDB / IngressRoute を `zoo2-infra` に置く。
3. 2 ノードで 2 クライアント編集 → ノード kill → 1012 → 再接続を確認する。
4. D1 migration をクラスタ内 Job から実行する。
5. R2 の別 bucket backup（bucket lock）と D1 / Markdown export の restore 訓練。
