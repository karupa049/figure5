# 学習履歴ログ収集システムの実装完了報告

学習状況を分析するための、**「送信日時」「入力された学籍番号（学生ID）」「自動生成された端末ID（ブラウザ固有ID）」「試行時間」**を統合したログ収集・転送システムの実装が完了しました。

---

## 🛠️ 変更内容と実装の仕組み

### 1. クライアント側（ブラウザ）でのデータ制御と計測 ([app.js](file:///Users/sakamotoharuki/Documents/Codex/figure5/app.js))
*   **初回のみのID入力・記憶**:
    起動時に `localStorage` 内の学籍番号（`studentId`）をチェックし、存在しなければ `prompt` ダイアログで入力を求めます。入力値は `localStorage` に記憶され、次回アクセス以降は入力を自動でスキップします。
*   **端末ID（ブラウザID）の自動生成**:
    ブラウザごとに一意のランダムな端末ID（`terminalId`）を自動生成し、同じく `localStorage` に永続保存して毎回ログに付与します。
*   **経過時間の計測**:
    問題生成時（`sessionStartTime = Date.now()`）およびヒント要求時（`hintStartTime = Date.now()`）のタイムスタンプを保持し、解答・採点時に「問題開始からの経過秒数」および「ヒントからの経過秒数」を自動算出します。
*   **ログ送信ヘルパー ([app.js:L28-48](file:///Users/sakamotoharuki/Documents/Codex/figure5/app.js#L28-L48))**:
    `sendLog(event, extraData)` 関数を通じて、バックエンドの `/api/log` へJSON形式でログデータを送信します。

### 2. サーバー側（バックエンド）でのログ保存とスプレッドシート転送 ([server.js](file:///Users/sakamotoharuki/Documents/Codex/figure5/server.js))
*   **ログ保存APIの公開 ([server.js:L734-748](file:///Users/sakamotoharuki/Documents/Codex/figure5/server.js#L734-L748))**:
    `POST /api/log` エンドポイントを追加し、ブラウザから送られてきたログを受信します。
*   **ローカルJSONLファイルへの蓄積 ([server.js:L692-701](file:///Users/sakamotoharuki/Documents/Codex/figure5/server.js#L692-L701))**:
    受信したログを、サーバーの [logs/study-log.jsonl](file:///Users/sakamotoharuki/Documents/Codex/figure5/logs/study-log.jsonl) ファイルに1行（JSONL形式）ずつ自動追記します。
*   **Googleスプレッドシート（GAS）への自動転送 ([server.js:L703-718](file:///Users/sakamotoharuki/Documents/Codex/figure5/server.js#L703-L718))**:
    環境変数 `GAS_WEBAPP_URL` がサーバー起動時に設定されている場合、受信したログを非同期で指定のGoogle Apps ScriptのウェブアプリURLへPOST転送します。

---

## 🔍 検証結果
サーバーを新しいコードで再起動した状態で、ログ受信用APIにダミーのログデータを送信するテストを実施しました。
*   CURLコマンドによるテストで、レスポンス `{"ok":true}` を正常に取得。
*   ローカルサーバーの [logs/study-log.jsonl](file:///Users/sakamotoharuki/Documents/Codex/figure5/logs/study-log.jsonl) に、ダミーのログデータが正しいJSONフォーマットで保存されていることを確認しました。

---

## 📋 Googleスプレッドシートに蓄積するための環境変数設定手順
実際にGoogleスプレッドシートにログを転送させるためには、スプレッドシート側でGAS（Google Apps Script）をデプロイした後、**本システムのサーバー起動時に環境変数を指定**して起動します。

### 起動コマンド例:
```bash
# GASのウェブアプリURLを設定してサーバーを起動します
GAS_WEBAPP_URL="https://script.google.com/macros/s/xxxx/exec" node server.js
```
*(上記 `xxxx` の部分に、デプロイ時に発行されたご自身のGASのURLを貼り付けてください)*
