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
未設定時だけ設定への案内を表示します。設定後は会話と入力を中心に、モデル・担当構成・送信区分を入力欄の下にまとめます。設定済みであっても、実モデルの疎通を確認したことにはなりません。

1. **接続を追加**すると、その接続のモデル登録へ続きます。送信許可（`allowedData`）・有効化・`/login`（ChatGPT）や `/probe` の実行をフロー内の選択肢でまとめて決め、接続とモデルを一度に保存します。モデルは tools 無効で登録されます。通常の会話は `private` です。従量 API は `limits.maxApiUsd` と接続の `maxRequestUsd` をともに正数にします。
2. ChatGPT は `/login` で認証します。API キーは起動環境へ渡し、`secretEnv` には環境変数の名前だけを登録します。
3. **モデルを追加**し、提供元の ID を入力するか SDK カタログから選びます。`/probe` で疎通・ツールの往復を確認してから、そのモデルの `tools` を有効にします。
4. コード変更には **検査コマンドを追加**し、会話の必須検査に指定します。`/doctor` で隔離環境を確認してください。

起動と `/doctor` はモデルを呼びません。`/probe` は利用枠・予算を消費します。設定例は [examples/config.yaml](examples/config.yaml) にあります。
一覧での値の変更と検査の追加は保留され、設定を閉じる際に差分一覧を一度だけ確認してからまとめて保存します。変更は次の依頼から反映します。

ローカル推論には OpenAI Chat Completions 互換サーバーを用意し、接続先を `127.0.0.1` または `::1` にします。`restricted` と `localOnly` はローカル接続専用、Sarashina は `public` 専用です。

## 日常の操作

| 操作                      | 動作                                                   |
| ------------------------- | ------------------------------------------------------ |
| Enter / Shift+Enter       | 送信 / 改行。実行中の Enter は追加指示                 |
| Alt+Enter                 | 現在の作業が成功した後の依頼を保存                     |
| Ctrl+P / Ctrl+L           | 操作の検索 / 次の依頼のモデル・担当構成を選択          |
| Esc                       | メニュー・閲覧を取消。会話画面では実行を中断           |
| Ctrl+O / `/history`       | 最新ツール結果の開閉 / 同じ会話に履歴を追加読込        |
| `/tools list` / `/expand` | ツール結果を選ぶ / 長文の続きをその場で表示            |
| PgUp / PgDn               | 会話領域を上 / 下へスクロール                          |
| `/sessions` / `/new`      | 会話を開く / 新しい会話                                |
| `/search [文字列]`        | 会話・依頼・イベント・資料・作業ファイルをローカル検索 |
| `/fork [新しい会話名]`    | 過去の時点から保存状態ごと／本文のみで新しい会話へ分岐 |
| `/continue`               | 前回の会話を開く（下書き・モデルも復元）               |
| `/queue`                  | 待機入力の編集・取消・実行                             |
| `/tasks` / `/status`      | 担当・検査 / 利用量・エラーの詳細                      |
| `/artifacts` / `/compact` | 成果物・ログの閲覧 / 長い会話の引き継ぎ                |
| `/sources` / `/research`  | 資料の本文・除外 / 調査メモ・検索履歴・検索設定        |
| `/versions [文書名]`      | 保存済み文書の版・Markdown表示・差分・来歴・検査       |
| `/pins` / `/context`      | 固定メモ・会話の制約 / 原文・圧縮記録の確認            |
| `/quit` / `/help`         | 保存して終了 / 全操作とキーの一覧                      |

メニューでは日本語やコマンド名で検索し、↑↓ と Enter で選択します。Ctrl+P / Ctrl+L から戻っても下書きは残ります。`NO_COLOR=1 agent` で色なしにできます。
入力は Slack の標準操作と同じく Enter で送信、Shift+Enter で改行します。複数行の貼り付けでは送信しません。Konsole の Shift+Enter に対応するため、同じキー列（SS3 M）を送る一部端末のテンキー Enter も誤送信防止のため改行として扱います。
日本語変換は端末が対応するOSのIMEを利用します。変換候補の選択・確定はIME側で処理し、確定した文字を入力欄で編集できます。Shift+Enterを区別できるキー設定とIME対応の端末が必要です。アプリ独自の変換辞書やIME切替キーは設けません。
画面は端末の幅と高さ全体を使い、本文だけの入力欄を下部に固定します。モデル・構成・送信区分は `/status`、操作説明は `/help` または Ctrl+P から確認できます。会話領域はマウスホイールや PgUp / PgDn でスクロールでき、上端を越えると過去の発言を30件ずつ追加します。末尾では新しい出力に追従します。`/history` でも過去の発言を読み込めます。長文は冒頭を表示し、表示された `/expand 番号` で続きを同じ位置に展開します（番号省略時は直近の長文）。ツール結果・作業詳細も会話内で開き、Esc で閉じます。ツール結果の続きも `/expand` で読めます。待機中の終了は下書きを保存して直ちに元の端末へ戻り、作業中だけ確認します。
メニューは1項目1行とし、選択中の説明だけ表示します。`/settings` は接続・モデル・会話・詳細設定を検索できる一覧です。Enter で値をその場で編集し、保存・取消後も検索と選択位置を維持します。Esc は編集中なら編集だけを取り消し、一覧なら設定を閉じます。値の変更と検査の追加は保留され、閉じる際に `path: before → after` の差分一覧を一度だけ確認します（保留がなければ確認しません）。承認でまとめて保存し、取消で破棄します。`/doctor` は日本語の診断要約を表示し、Enter で技術詳細（JSON）を開きます。

`@src/file.ts`、空白を含む場合は `@"notes/my file.md"` で添付します。Tab でパス・コマンドを補完できます。実行中の新しい添付は `/next` を使います。依頼の種類が自動判定と合わなければ `/kind` で変更してください。

PNG・JPEG・WebP 画像も同じ `@path` 形式で添付できます。対応モデルの `/settings` で `images` を有効にすると、送信前プレビューに画像と送信先が表示されます。1画像5,000,000 bytes・各辺2048 px・4,194,304 pixels、会話ごとに8画像・合計20,000,000 bytesまでです。画像は縮小・再圧縮せず元のバイト列を送ります。対応形式・プライバシー条件を満たすモデルがない場合は送信しません。

画像は会話をまたいで `~/.local/share/local-agent/images`（macOS は `~/Library/Application Support/Local Agent/images`）に権限制限付きで保存され、会話・run・イベントには参照とメタデータだけを保持します。バックアップには `images/` も含めてください。Pi の非公開セッション履歴には provider の正規履歴として画像バイト列が含まれる場合があります。画像コンテキスト予算は履歴中の画像出現ごとに8,192 tokens相当を加算する保守的な見積もりで、プロバイダー共通の上限・実使用量・コンテキスト適合を保証するものではありません。実際の利用量はプロバイダーの応答を参照してください。詳細は [docs/images.md](docs/images.md) を参照してください。
`/images` で会話に保持された画像参照を確認できます。ライブプロバイダーでの画像受け入れ確認は未実施です。

`/images add "画像のパス.png"` は画像を送信せずに保存します。参照 ID を使って `/images crop|mask` で編集してから依頼を送信できます。除外・マスクは、既に送信した内容を取り消す操作ではありません。

`/editor` は未送信の下書きを外部エディタで編集し、終了後に TUI に戻します。`/editor artifact` は保存済み文書の改訂案を編集して下書きへ戻します。元の成果物は変更せず、送信・改訂版の作成・検査は別操作です。`/editor-config ["nvim","-f"]` のように実行ファイルと引数の JSON 配列で設定します（既定は `vi`、GUI エディタは `--wait` 等を指定）。シェル展開は行いません。これは利用者が明示的に選ぶホスト上の操作であり、エディタは利用者自身の権限で動作します。モデル用の認証環境変数は渡しません。

`/keys` で現在のキー割当を確認し、`/keys palette ctrl+g` のように変更できます。キーを省略するとその操作の割当を解除し、`/keys reset` で全割当を既定へ戻します。通常の文字入力・改行と Ctrl+J は保護され、ダイアログは Esc でも閉じられます。設定は非公開保存先の `terminal.json` に保存し、モデルや課金の設定とは分離します。SSH・tmux が先に消費するキーには、別の割当を選んでください。

`@path` で文書を選択して添付できます。形式・選択子・Git 入力・PDF sandbox 要件・clipboard fallback は [docs/attachments.md](docs/attachments.md) を参照してください。
Git 添付の差分は保存された raw bytes を比較し、Git attributes・filters・working-tree encoding・改行正規化は適用しません。未追跡ファイルは名前のみを示し、内容は添付しません。

会話にはユーザーが追加した固定メモ・決定・未解決の質問と、元の指示、作業結果・検査・出典・画像参照を個別に保存します。`/pins add|edit|remove` と `/context add|edit|constraint` でユーザー所有の記録を編集できます。`/context` は会話原文、参照 ID、圧縮記録を表示し、`/context original <seq>` と `/context read <archive-id>` で保存済みの原文を範囲付きで読み返せます。編集は会話が idle のときだけ行え、接続許可・送信区分は変更しません。これらの記録は会話ごとであり、会話をまたぐ恒久メモリではありません。

`/search` は同じ作業ディレクトリのローカル記録を、正規表現ではない文字列で検索します。会話名、依頼・担当タスク、会話本文、実行イベント、保存済み資料・成果物、現在の作業コピーを別々に選べます。他プロジェクト、資格情報の保管先、Pi の内部セッション、HTTP 原文バイナリは検索しません。検索ページごとに件数・読込量を制限し、未検索の候補と省略を表示します。結果の閲覧や会話切替は、モデル・ツールの実行や通信を開始しません。除外済みの原本・発言がローカル履歴から消去されるわけではありません。

リポジトリの説明・調査・レビューは read-only として扱い、元リポジトリまたは最新の未適用作業コピーの隔離スナップショットに対して限定された読取ツールを使います。明示的な変更依頼でのみ作業コピーへの書込みが有効になります。`まだ変更しない` や `do not change` は変更動詞より優先されます。通常の挨拶は引き続きツールを使いません。

長いモデル履歴は安全なリクエスト境界でホストが決定的に圧縮します。80%で検討し、60%以下を目標に古い verbose な tool result だけをアーカイブ参照付きの抜粋に置き換えます。正確な圧縮前コンテキストは会話専用の非公開アーカイブに保存され、`read_context` と `/context read` から上限付きで取得できます。推定式は `min(maxInputBytes, max(0, (contextWindow - maxOutputTokens) * 3))` と `images × 8,192 tokens相当` のヒューリスティックです。プロバイダーごとの実使用量・適合性の保証ではなく、プロバイダー報告の使用量が優先されます。ユーザー指示・制約などの保護対象が収まらない場合は `CONTEXT_LIMIT` で停止し、切り捨てません。SDK 自動圧縮・再試行は無効のままです。

`/fork` は過去の発言を30件ずつ表示し、選択点を含む本文を新しい会話へコピーします。「保存状態ごと」はその時点の固定条件・資料・画像参照・作業コピーも復元し、「会話本文のみ」はそれらを復元しません。旧履歴や安全に保存できなかった発言は理由を表示し、本文のみを選べます。送信区分・ローカル限定・現在の資料除外やマスクは弱めずに引き継ぎます。待機入力・下書き・後から追加した成果物・provider 内部履歴はコピーしません。

分岐前に復元範囲と制約を表示し、最後に作成を確認します。分岐の閲覧・作成ではモデル・ツールの実行や通信を行わず、元の会話も変更しません。保存状態の復元は推論結果や検査成功ではありません。分岐先は読み取り専用を既定として開き、作業の再開・検証・適用には新しい通常の依頼が必要です。元リポジトリが変わっていれば、引き続き競合チェックで停止します。チェックポイントは非公開保存領域の `checkpoints/` に保存するため、バックアップでは会話DB・成果物・画像・資料と一緒に保持してください。

## 変更の確認と復旧

調査では、検索結果と実際に取得した根拠を分けて保存します。検索は明示的な許可先を設定した場合だけ利用でき、既定の外部検索サービスはありません。`/research` の閲覧は通信しません。`/sources` では行番号付き本文を読み、同じ原資料を今後の送信から除外できます。除外は原本・過去の発言や引用・送信済みデータの削除ではありません。`/versions` では成功・失敗した文書の版を比較し、実際の検査記録を確認できます。意味・事実の正しさを自動で保証するものではありません。設定・制約は [docs/research.md](docs/research.md) を参照してください。

検査完了後に `/diff` を開き、Enter で適用確認へ進みます。Esc は取消です。`/apply` でも同じ画面が開きます。未適用の変更は次の依頼へ引き継ぎ、元リポジトリからの累積差分を表示します。

最初のコピーには未コミット変更を含む追跡済みファイルを使います。未追跡ファイルは会話設定の `includeUntracked` で追加できます。元のファイルや HEAD が外部で変わった場合は競合として停止します。

検査の `protectedPaths` に既存テストや設定を登録すると、それらの変更を不合格にします。Shell はネットワークを使えません。必要な実行環境・依存は事前に用意し、Bubblewrap では `execution.runtimePaths` で読み取り専用に公開し、Podman ではダイジェスト固定の `execution.image` に含めます。

失敗時は `/status` と `/artifacts` で理由を確認します。待機・クラッシュした作業は `/resume`、結果未確定の操作は実際の結果を確認して `/reconcile` で照合します。中断・失敗で終了した作業の続きは、新しい依頼として入力してください。停止・失敗・再起動後の待機入力は自動実行せず `/queue` に残ります。

適用はファイル単位で、全ファイル一括の原子性はありません。途中で失敗した場合は照合が必要です。バイナリ変更、symlink、hardlink、submodule は扱いません。

## 保存

設定・履歴は Linux では `~/.local/share/local-agent`、macOS では `~/Library/Application Support/Local Agent` に保存します。`--home /絶対パス` または `AGENT_HOME` で変更できます。保存先は対象リポジトリの外に置いてください。

バックアップは終了後に保存先全体をコピーします。`auth/` は認証情報を含むため共有しないでください。

開発・検証方法は [docs/architecture.md](docs/architecture.md)、保守用 CLI は `agent --help` を参照してください。

## Collaboration backend

Assisted and reviewed runs use host-assigned task graphs. New collaborative
tasks return structured results; a synthesis task is the only integrated
conversation answer. Delegated children receive only their assignment,
authorized source IDs, and a read-only workspace view. They cannot write,
execute shell or MCP tools, mutate research checkpoints, or read another
task's transcript, context archive, or attempt reports.

Every invocation has a private immutable attempt report. Reviewers and
synthesis may read only reports on their task or transitive dependencies.
Source exclusions, model/image disclosure floors, writer exclusivity, request
budgets, and the task-scoped context archive allow-list are enforced by the
host rather than by model instructions. Legacy saved tasks without
`resultFormat` retain their previous text/structured parsing behavior.

独立した Firecracker agent environment の管理者セットアップ、CLI、制約は
[docs/firecracker.md](docs/firecracker.md) を参照してください。
