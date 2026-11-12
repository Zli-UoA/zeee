# AuthZアカウント絵文字

本文の `:@username:` はアカウントアイコン、`@username` は `@`・アイコン・AuthZ表示名として表示する。アプリ固有プロフィールを参照しない。補完候補にもAuthZのアカウントを含める。未知の名前、コード、リンク内の文字列は保持する。

認証済み `/api/emojis` が集中基盤の内部 `/accounts` から取得した一覧を返す。`EMOJI_ACCOUNT_PROFILE_URL` を設定し、`EMOJI_SERVICE_URL` に集中基盤の公開originを設定する。専用AuthZ tokenやOIDCの追加scopeは利用側に不要。

celld向けビルドでは既定で `http://emoji.emoji.svc.cluster.local:3001/accounts` を使用する。クラスタのNetworkPolicyでzeee/celldのみが接続できる。Cloudflare Worker単体ではこの内部アドレスに接続できないため、内部URLの設定なしではアカウント一覧は空になる。公開プロフィール一覧APIを新設しない。

各段のキャッシュは60秒で、取得失敗時には期限切れプロフィールを消す。アイコン未登録は表示名の頭文字、未知の名前は元の文字列を表示する。画像は集中基盤のURLからAuthZの検証済み画像へ転送される。

AuthZ・集中基盤・IaCを先に配備してから本アプリをビルド・配備する。カスタム絵文字とgemojiの配信は従来どおり独立して利用する。
