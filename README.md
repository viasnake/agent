# Local Agent

コード変更・調査・文書作成を続けて依頼できる、個人用の対話型ターミナル AI Agent です。コードは作業コピーで変更・検査し、差分を確認してから元のリポジトリへ適用します。

Node.js 24 以上と Git が必要です。主な利用対象は Linux の端末・SSH 接続です。Shell と検査には Bubblewrap または rootless Podman を使います。macOS での隔離実行には Podman の Linux VM が必要です。

## 起動と設定

```sh
npm ci --ignore-scripts
npm run build
npm link
cd /path/to/your-repository
agent
```

初回は接続が無効です。Ctrl+P →「接続・権限・上限」（`/settings`）で準備します。
ホーム画面には準備手順と前回の会話への導線を表示します。入力欄の下でモデル・担当構成・送信区分を確認でき、`接続設定あり` は実モデルの疎通確認済みという意味ではありません。

1. **接続を追加**し、接続の `allowedData` と予算を確認して `enabled` を有効にします。通常の会話は `private` です。従量 API は `limits.maxApiUsd` と接続の `maxRequestUsd` をともに正数にします。
2. ChatGPT は `/login` で認証します。API キーは起動環境へ渡し、`secretEnv` には環境変数の名前だけを登録します。
3. **モデルを追加**し、提供元の ID を入力するか SDK カタログから選びます。`/probe` で疎通・ツールの往復を確認してから、そのモデルの `tools` を有効にします。
4. コード変更には **検査コマンドを追加**し、会話の必須検査に指定します。`/doctor` で隔離環境を確認してください。

起動と `/doctor` はモデルを呼びません。`/probe` は利用枠・予算を消費します。設定例は [examples/config.yaml](examples/config.yaml) にあります。設定変更は次の依頼から反映します。

ローカル推論には OpenAI Chat Completions 互換サーバーを用意し、接続先を `127.0.0.1` または `::1` にします。`restricted` と `localOnly` はローカル接続専用、Sarashina は `public` 専用です。

## 日常の操作

| 操作                        | 動作                                          |
| --------------------------- | --------------------------------------------- |
| Enter / Ctrl+J・Shift+Enter | 送信 / 改行。実行中の Enter は追加指示        |
| Alt+Enter                   | 現在の作業が成功した後の依頼を保存            |
| Ctrl+P / Ctrl+L             | 操作の検索 / 次の依頼のモデル・担当構成を選択 |
| Esc                         | メニュー・閲覧を取消。会話画面では実行を中断  |
| Ctrl+O / `/history`         | 保存済みツール結果 / 会話履歴                 |
| PgUp / PgDn                 | 会話領域を上 / 下へスクロール                 |
| `/sessions` / `/new`        | 会話を開く / 新しい会話                       |
| `/continue`                 | 前回の会話を開く（下書き・モデルも復元）      |
| `/queue`                    | 待機入力の編集・取消・実行                    |
| `/tasks` / `/status`        | 担当・検査 / 利用量・エラーの詳細             |
| `/artifacts` / `/compact`   | 成果物・ログの閲覧 / 長い会話の引き継ぎ       |
| `/quit` / `/help`           | 保存して終了 / 全操作とキーの一覧             |

メニューでは日本語やコマンド名で検索し、↑↓ と Enter で選択します。Ctrl+P / Ctrl+L から戻っても下書きは残ります。`NO_COLOR=1 agent` で色なしにできます。
画面は端末の幅と高さ全体を使い、入力欄・モデル・操作案内を下部に固定します。会話領域はマウスホイールや PgUp / PgDn でスクロールでき、末尾では新しい出力に追従します。終了すると元の端末画面に戻ります。直近8件を超える履歴・長いメッセージの全文は `/history` で開けます。
メニューは端末の幅に追従し、選択項目と説明を別行で表示します。`/settings` の「登録済みの接続」から接続の有効化・送信許可・予算を編集できます。`/doctor` は日本語の診断要約を表示し、Enter で技術詳細（JSON）を開きます。

`@src/file.ts`、空白を含む場合は `@"notes/my file.md"` で添付します。Tab でパス・コマンドを補完できます。実行中の新しい添付は `/next` を使います。依頼の種類が自動判定と合わなければ `/kind` で変更してください。

## 変更の確認と復旧

検査完了後に `/diff` を開き、Enter で適用確認へ進みます。Esc は取消です。`/apply` でも同じ画面が開きます。未適用の変更は次の依頼へ引き継ぎ、元リポジトリからの累積差分を表示します。

最初のコピーには未コミット変更を含む追跡済みファイルを使います。未追跡ファイルは会話設定の `includeUntracked` で追加できます。元のファイルや HEAD が外部で変わった場合は競合として停止します。

検査の `protectedPaths` に既存テストや設定を登録すると、それらの変更を不合格にします。Shell はネットワークを使えません。必要な実行環境・依存は事前に用意し、Bubblewrap では `execution.runtimePaths` で読み取り専用に公開し、Podman ではダイジェスト固定の `execution.image` に含めます。

失敗時は `/status` と `/artifacts` で理由を確認します。待機・クラッシュした作業は `/resume`、結果未確定の操作は実際の結果を確認して `/reconcile` で照合します。中断・失敗で終了した作業の続きは、新しい依頼として入力してください。停止・失敗・再起動後の待機入力は自動実行せず `/queue` に残ります。

適用はファイル単位で、全ファイル一括の原子性はありません。途中で失敗した場合は照合が必要です。バイナリ変更、symlink、hardlink、submodule は扱いません。

## 保存

設定・履歴は Linux では `~/.local/share/local-agent`、macOS では `~/Library/Application Support/Local Agent` に保存します。`--home /絶対パス` または `AGENT_HOME` で変更できます。保存先は対象リポジトリの外に置いてください。

バックアップは終了後に保存先全体をコピーします。`auth/` は認証情報を含むため共有しないでください。

開発・検証方法は [docs/architecture.md](docs/architecture.md)、保守用 CLI は `agent --help` を参照してください。
