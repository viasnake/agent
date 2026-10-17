# Local Agent

コード変更・調査・文書作成を続けて依頼できる、個人用の対話型ターミナル AI Agent です。コードは作業コピーで変更・検査し、差分を確認してから元のリポジトリへ適用します。

Node.js 24 以上と Git が必要です。主な利用対象は Linux の端末・SSH 接続です。Shell と検査には Bubblewrap または rootless Podman を使います。macOS での隔離実行には Podman の Linux VM が必要です。

## 現時点の制限と検証範囲

- 独立した読み取りタスクは並列実行できますが、書き込みタスクは読み取りを含む他のタスクと排他実行します。独立した書き込みの並列実行・自動マージはありません。
- 管理対象の長時間 Podman プロセスには所有確認・停止・回収記録があります。一方、通常の単発 Podman 実行には同等の永続回収記録がなく、Agent の強制終了後にコンテナが残る可能性があります。通常終了時の後始末と、強制終了後の回収保証は異なります。
- 隔離方式間で資源上限は同一ではありません。Bubblewrap の CPU・メモリ制限や、書き込み可能な作業領域の実行中ディスク容量制限は、Podman の制限と同等とは扱いません。
- 推論の境界には SDK 非依存の契約がありますが、本番の推論・TUI・MCP は引き続き Pi に依存します。別 SDK への完全な交換を検証したものではありません。
- 自動テスト・Linux/macOS の CI と、実画面での受入確認・実モデルによる品質確認は別です。新しい TUI 操作には実画面での確認が未実施のものがあり、実モデルでの画像理解・協調品質比較も未検証です。

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

### ロール別モデルプロファイル

`models` の別名ごとに `roles`・`kinds`・`tools`・`maxOutputTokens` を設定できます。同じ接続・提供元モデル ID を別名で登録し、worker と reviewer に異なる上限や推論設定を使うこともできます。`/settings` の `thinkingLevel` は `off / minimal / low / medium / high`、空欄は未指定です。未指定では従来の SDK に `off` を渡す動作を維持します。既存設定に新しい既定値を追加しません。

互換・ローカル接続では、接続先が OpenAI 形式の `reasoning_effort` に対応することを確認してから `reasoning: true` を設定してください。これは利用者による能力宣言で、接続試験ではありません。ChatGPT・Gemini は SDK カタログの対応範囲も確認します。明示した深さが SDK の対応範囲外なら推論前に停止し、別モデルへの切替や深さの自動補正はしません。設定変更は次に作成する実行へ反映され、既存実行の設定整合性チェックは維持します。設定の保存だけでは通信しません。

推論の深さは品質・速度・費用を保証せず、提供元によって意味や内部実装が異なります。`off` も提供元内部の推論が完全に無効になる保証ではありません。出力上限の強制も API の対応範囲に限られます（ChatGPT 接続では `max_output_tokens` を送信しません）。選択した別名・SDK に適用した深さ・出力上限は `model_profile` イベントに記録します。利用量・費用は通常の予算制御と提供元の報告を使い、未報告をゼロとみなしません。実モデルによる品質比較は未検証です。

### MCP の外部操作を個別確認

MCP ツール設定の既存 `readOnly: true` は維持できます。更新・投稿・削除には明示的に `readOnly: false` を設定し、必要に応じて `effect: change|publish|delete|dangerous` を指定します。未指定は危険操作扱いです。設定だけでは実行を承認せず、TUI で送信先・ツール・引数全文を確認し、「この1回だけ実行する」を選ぶ必要があります。取消が既定で、一括承認・承認の保存・自動再実行はありません。確認画面を開けない場合や非対話 CLI では実行を拒否します。

変更ツールは変更アクセスを持つ通常の Worker の書き込みタスクだけが利用でき、Reviewer・委任・統合・読み取り専用タスクには公開しません。承認後もスキーマ、接続設定、権限、実行所有権を再確認します。承認待ちの操作は未送信として記録し、送信後の不明な結果は `unknown` のまま残します。未確定・送信中の操作が残る間は別の外部変更も拒否するため、利用者による確認・解決が必要です。同じ引数の完了済み操作があれば、再承認時に重複の警告を表示します。

引数は32,000 bytesまで、送信先は2,000文字までです。変更用HTTP接続のURLにはクエリを含めず、資格情報は OAuth / `bearerEnv` で管理してください。承認イベントには引数本文ではなくハッシュを記録します。操作分類や読み取り専用宣言は設定上の契約であり、外部サーバーの実装を保証しません。ローカル stdio のネットワーク隔離・読み取り専用マウントも変更しません。実際の外部投稿・削除と実画面での受入確認は未実施です。

### コードの定義・参照・限定診断

`code_info` はモデルが利用できる読み取り専用ツールです。作業コピー内の TypeScript/JavaScript に対して `definition`・`references`・`diagnostics` を指定できます。位置は1始まりの行・UTF-16列、結果の終端は排他的です。読み取り専用レビューでも利用でき、シェル・ネットワーク・プロジェクトのプラグインやスクリプトは実行しません。各結果にファイルのハッシュ、全体に解析入力のハッシュを含め、後続の編集と区別します。

**プロジェクトの型検査やビルドの代わりではありません。** 固定した ES2022・ESNext/Bundler・strict・allowJs/checkJs・JSX preserve 設定で解析し、プロジェクトの tsconfig、依存パッケージ、パス別名は読み込みません。標準ライブラリのみ同梱 TypeScript 5.9.3 を使います。依存や独自設定によって定義解決・診断は変わり得るため、結果には常に制限を表示します。空の診断結果も「検査成功」には扱わず、正式な確認には登録済みの隔離検査を実行してください。TypeScript/JavaScript 以外は既存のファイル検索・隔離コマンド・承認済み MCP を使用します。

解析は最大512ソース・1ファイル512,000 bytes・合計4,000,000 bytes（設定されたファイル・作業コピー上限も適用）、出力は100件・結果配列の内容32,000 bytesまでです。省略は `truncated`、標準ライブラリ内の一致は `libraryMatches` で区別します。リンク・保護パス・非UTF-8・取得中の変更は拒否します。取得・解析は10秒の期限を持ち、解析専用 Worker の V8 ヒープ上限は256MiBです（プロセス全体のメモリ上限の保証ではありません）。中断・失敗時も変更やコード生成は行いません。

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
| `/context-review`         | 条件・矛盾・反復の検知内容と確認メモ（自動再開なし）   |
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

`/context-review` は条件の見落とし・矛盾についてのモデル申告（未検証）と、同一の調査を繰り返すホスト検知を表示します。検知中は後続のツール・推論・最終回答を停止し、再起動後も確認待ちを保持します。根拠と維持する条件を読み、確認メモを入力・確認して明示確定してください。メモは監査記録であり、条件や権限を変更する指示ではありません。確定しても自動再開・待機入力の実行はしません。同じ作業は `/resume`、条件の修正は新しい依頼で明示します。一般的な意味の矛盾を網羅的に検出する保証はありません。CLI・検知範囲は [docs/context-review.md](docs/context-review.md) を参照してください。

調査では、検索結果と実際に取得した根拠を分けて保存します。検索は明示的な許可先を設定した場合だけ利用でき、既定の外部検索サービスはありません。`/research` の閲覧は通信しません。`/sources` では行番号付き本文を読み、同じ原資料を今後の送信から除外できます。除外は原本・過去の発言や引用・送信済みデータの削除ではありません。`/versions` では成功・失敗した文書の版を比較し、実際の検査記録を確認できます。意味・事実の正しさを自動で保証するものではありません。設定・制約は [docs/research.md](docs/research.md) を参照してください。

検査完了後に `/diff` を開き、Enter で適用確認へ進みます。Esc は取消です。`/apply` でも同じ画面が開きます。未適用の変更は次の依頼へ引き継ぎ、元リポジトリからの累積差分を表示します。

最初のコピーには未コミット変更を含む追跡済みファイルを使います。未追跡ファイルは会話設定の `includeUntracked` で追加できます。元のファイルや HEAD が外部で変わった場合は競合として停止します。

検査の `protectedPaths` に既存テストや設定を登録すると、それらの変更を不合格にします。Shell はネットワークを使えません。必要な実行環境・依存は事前に用意し、Bubblewrap では `execution.runtimePaths` で読み取り専用に公開し、Podman ではダイジェスト固定の `execution.image` に含めます。

### オフラインの依存導入・ビルド

`execution.profiles` を設定すると、coding の通常 Worker と独立 Reviewer は `run_profile` で登録済みコマンドを選べます。モデルはプロファイルのコマンドを変更できません。読み取り専用の依頼、委任先、統合担当では利用できず、設定変更後は新しい Run が必要です。未指定なら従来の設定形式・ハッシュを保ちます。

```yaml
execution:
  profiles:
    dependencies:
      description: ロック済み依存を事前配置したキャッシュから導入
      command: >-
        mkdir -p /runtime/app &&
        cp /workspace/package.json /workspace/package-lock.json /runtime/app/ &&
        cd /runtime/app &&
        npm ci --offline --ignore-scripts --no-audit --no-fund --cache /opt/npm-cache
```

これは設定例です。Node/npm と完全なオフラインキャッシュを事前に用意し、`/opt/npm-cache` を固定イメージに含めるか、Bubblewrap の読み取り専用 `runtimePaths` で公開してください。不足時にネットワークを開いたりホストへ導入したりはしません。読み取り専用キャッシュへの書込みが必要なツールでは、プロファイル内でキャッシュを `/runtime` へコピーしてから使用してください。ワークスペース・`file:` 依存や native addon を含むプロジェクトは、パスと事前ビルドを含め個別のコマンド設定が必要です。

`/runtime` は成果物とは別のタスク専用領域です。`run_profile` だけが書き込め、同じ担当の後続 `shell` は読み取り専用で再利用します。例えば `node /runtime/app/node_modules/typescript/bin/tsc` のように配置先を明示します。依存を通常の `/workspace/node_modules` として自動公開したり、PATH を書き換えたりはしません。ソースを別ビルドディレクトリに複製する必要がある場合も、プロファイルで明示してください。成果物は `/workspace` に戻して通常の差分検査・適用を行います。既存の作業コピーにおける秘密ファイル・リンク・`node_modules` 等の拒否は維持します。

Reviewer は別の runtime と使い捨ての作業コピーを使います。固定検査、別担当、別 Run、分岐、バックアップには runtime を引き継ぎません。資料除外の条件が変わった場合も新しい領域に切り替え、古い領域を再公開しません。古い領域は即時消去せず Run の履歴削除時に回収されます。依存やロックの変更に対する自動再導入・自動実行はありません。

実行時間と出力の上限は通常の Shell と同じです。runtime は実行前後に最大20,000項目・10秒、`limits.maxWorkspaceBytes` 以下か走査し、リンクをホストから辿りません。この検査はディスクのリアルタイム quota ではなく、超過した領域は再利用を拒否します。Bubblewrap に Podman と同じ CPU・メモリ・ディスク制限があるとは扱いません。長時間プロセス管理もこの機能には含みません。

失敗時は `/status` と `/artifacts` で理由を確認します。待機・クラッシュした作業は `/resume`、結果未確定の操作は実際の結果を確認して `/reconcile` で照合します。中断・失敗で終了した作業の続きは、新しい依頼として入力してください。停止・失敗・再起動後の待機入力は自動実行せず `/queue` に残ります。

適用はファイル単位で、全ファイル一括の原子性はありません。途中で失敗した場合は照合が必要です。バイナリ変更、symlink、hardlink、submodule は扱いません。

## 保存

設定・履歴は Linux では `~/.local/share/local-agent`、macOS では `~/Library/Application Support/Local Agent` に保存します。`--home /絶対パス` または `AGENT_HOME` で変更できます。保存先は対象リポジトリの外に置いてください。

共有用には `/diagnostics /保存先/新しいファイル.json` を使います。全出力を確認して明示確定した場合だけ、その時点の診断を `0600` の新規ファイルへ保存します。CLI は `agent diagnostics`（または保存先を付けた実行）がプレビュー、`agent diagnostics /保存先/新しいファイル.json --write` が保存です。既存の安全な所有ディレクトリと Agent 領域外の未使用ファイル名が必要で、上書き・自動送信はしません。本文・識別子・パス・接続先・資格情報・環境変数・任意のエラー文を読んで伏字にするのではなく、ホワイトリストの項目だけを構成します。バージョン、設定種別、最近挿入された最大1000行の状態別件数、最大40件のイベント種別を含みます。件数は全履歴の総数ではなく、切り詰めの有無を表示します。未知の状態やイベントは `other`、設定・DB の取得失敗は詳細なしの `unavailable` とします。認証・隔離環境・接続先の試験や推論は行いません。環境特性や件数は残るため共有前に確認してください。完全な匿名化、内容依存の不具合の再現、稼働環境の検証、履歴バックアップの代わりにはなりません。従来の `/doctor` の詳細には接続名などが含まれるため、そのまま共有しないでください。

`/backup /保存先/新しいディレクトリ` は、全作業ディレクトリの会話・下書き・待機入力・出典・成果物・参照中の画像と資料・保存済み作業境界・現在の設定を非公開の履歴アーカイブとして保存します。対象を確認し、明示確定してから作成します。CLI は `agent backup /保存先/新しいディレクトリ` がプレビュー、`--write` 付きが保存です。ほかの Agent 画面を閉じ、実行・適用・評価を停止してから行ってください。

資格情報ストア・環境変数・未参照キャッシュ・モデル内部セッション・稼働プロセス・現在の未保存作業コピー・依存環境は含めません。作業コピーは保存済み境界のスナップショットだけが対象です。これは稼働環境を復元するバックアップや自動再開用の Agent home ではありません。会話・設定へのインポートは行いません。

保存先は既存の所有ディレクトリ内に新しく作り、Agent 保存領域と全作業ディレクトリの外に置きます。権限はディレクトリ `0700`、ファイル `0600` です。SQLite の書込ロック中に整合した DB と参照ファイルを保存し、`backup.json` を最後に書きます。失敗時はこの操作で作った不完全な保存先を削除します。バックアップは既定で 512 MB・50,000 ファイルまで、メタデータは 100,000 行・64 MB までです。CLI の `--max-bytes`、`--max-files`、`--timeout-seconds` で保存処理の上限を指定できます（最大 5 GB・100,000 ファイル・120 秒、時間はローカル処理の境界で確認）。単一資料は 64 MB、設定は 4 MB までです。

`agent backup-verify /保存先` はハッシュ・DB・資料参照の完全性をローカル検査し、復元や実行はしません。検査は内容の正しさ・署名・意味的品質を保証しません。履歴には private / restricted の本文や過去の除外済み資料も含まれ、手入力した秘密は除去されません。暗号化されていないため、共有用診断として渡さず、保存先の同期・共有にも注意してください。`auth/` を含む保存領域全体の手動コピーは、別途認証情報として保護する必要があります。

`/backup-open /保存先` は保存済み会話・実行・出典・成果物・設定・添付を読み取り専用で閲覧します。一覧は30件ずつ、本文は16,000 UTF-16文字単位で区切り、続きを表示できます。表示のたびにハッシュと資料参照を検証し、DBは検証したバイト列の一時コピーだけを読みます。アーカイブや現在の会話を変更せず、保存された操作・削除ジョブ・設定・Providerを実行しません。確認中にアーカイブが変化した場合は開き直してください。バイナリは内容を端末へ出さず、サイズと検証値を表示します。

CLI は設定・認証・現在のDBがない状態でも使えます。

```sh
agent backup-read /保存先
agent backup-read /保存先 --conversation <会話ID>
agent backup-read /保存先 --conversation <会話ID> --message <発言番号>
agent backup-read /保存先 --section runs
agent backup-read /保存先 --run <実行ID>
agent backup-read /保存先 --section files
agent backup-read /保存先 --file <一覧のpath>
```

続きは応答の `nextOffset` を `--offset` に指定します（一覧は行、本文はUTF-16位置）。検査の既定上限はバックアップと同じです。TUIは既定上限を使い、CLIの読取・書出には `--max-bytes`、`--max-files`、`--timeout-seconds` を指定できます。ファイルの全バイトを書き出すにはTUIで対象ファイルから書出を選び、保存先・ハッシュ・サイズを確認して確定します。CLI は `agent backup-extract /保存先 <一覧のpath> /新しいファイル` がプレビュー、`--write` 付きが明示保存です。既存ファイルは上書きせず、所有する書込保護済みディレクトリ内に `0600` で保存します。Agent領域・現在と保存元の作業領域・アーカイブ内への書出は拒否します。画像・PDF等のバイナリも元のバイト列のまま保存し、自動で開いたり実行したりしません。書出した設定も手動参照用であり、現在の設定には反映しません。

## 履歴の削除と保持

TUI の `/delete` では会話を複数選び、対象と保持理由を確認してから最終確定します。
`/delete session <ID...>`、`/delete run <ID...>` でも指定でき、会話に属する実行だけを
単独では削除できません。`/prune` は現在の作業場所と設定の `retentionDays` を使い、
現在開いている会話・使用中の履歴・参照が残る履歴を保護します。確認画面だけでは
削除せず、会話や設定・対象が変わった場合は選び直しが必要です。
`/cleanup-deletions` は全作業場所の保留ジョブを表示し、一件ずつ明示再試行します。

画像、添付資料、保存境界の共有 blob は、作業プロセスごとの永続 pin と
データベース参照を確認してから回収します。24時間未満のファイル、参照中の
ファイル、未知の名前や安全性を確認できない物体は保持します。`prune-cache`
は候補表示が既定で、`--write` と明示した選択だけを対象にします。
`cleanup-cache` は保留 job を表示し、指定した一件だけを明示再試行します。
pin はプロセスの寿命中保持され、起動時の自動 sweep・自動 retry は行いません。
`/prune-pins` は終了を確認できたプロセスの pin 記録だけを候補表示し、明示確定後に整理します。画像・資料・履歴・稼働プロセスには触れません。稼働中・PID再利用・確認権限不足は保持し、名前・所有者・権限・内容・ファイル識別子を確認できない記録も残します。途中で終了した書込の `.tmp` は既知の名前・安全なファイル・終了確認・確認時のハッシュがそろう場合だけ対象です。CLI `agent prune-pins [ファイル名...]` もプレビューが既定で、`--write` が必要です。名前を指定した選択に保持対象が含まれた場合は全体を拒否します。

pin の列挙は一度に500件・読取量64 MB・10秒までで、全体件数とは区別します。TUIの次ページ、またはCLIの `--offset` で続けて確認できます（ディレクトリ列挙順で、記録が増減した場合は先頭から確認してください）。名前を直接指定すれば、通常の pin 読取上限に達していても、その選択だけを検証して整理できます。確認後の置換・状態変更は拒否し、途中の失敗は削除済みと未完了の名前を分けて返します。自動再試行はせず、残った記録を改めて選び直してください。ディレクトリ同期に失敗した場合も完了とは扱いません。
共有キャッシュ、SQLite の残存ページ、外部バックアップの暗号学的消去は保証しません。
確定後の中断は既に行われた削除を取り消しません。新しい推論・適用・自動再開は行いません。

履歴削除は自動では実行されません。`remove`、`remove-session`、`prune` は既定で
プレビューを表示し、削除には `--write` が必要です。対象は選択した閉じた会話と
terminal run のメタデータ、およびその run 専用ディレクトリです。会話・run の
JSON、本文、出典、fork lineage、boundary などに残る UUID 参照も保守的に調べます。
外部から参照される単位は保持し、選択削除では選択全体を拒否します。

メタデータは一つの SQLite transaction で先に削除します。物理削除に失敗した場合は
保留中の cleanup job として表示し、`cleanup-deletions --write <job-id>` で明示した
job ID だけを再試行できます。共有画像・準備済み文書・checkpoint blob、SQLite の
残存ページ、外部バックアップは削除対象外です。暗号学的消去は保証しません。
バックアップ内の pending job は記録として保存されますが、cleanup は実行されません。

開発・検証方法は [docs/architecture.md](docs/architecture.md)、保守用 CLI は `agent --help` を参照してください。

## 管理プロセス

長時間動作する開発サーバーは、`execution.backend: "podman"` と固定 digest
イメージを設定し、`agent process provision` で作成した停止中の engine anchor を
`execution.managedProcesses.engineAnchor` に明示してから利用します。設定はプロセスを
自動起動・再起動せず、通常の coding writer の task にだけ bounded な
`process_start`、`process_status`、`process_logs`、`process_stop` を公開します。
`agent process list/status/logs/stop` は保存済みの run を対象にします。異常終了後は
`agent process stop <run-id> <process-id>` で所有証明を再確認してから回収してください。
Task の成功・失敗・キャンセルを返す前にも finally cleanup を行います。未解決の
cleanup は成功として隠さず、再開・適用・削除などの操作を停止します。エンジンの
anchor は、未解決の job をすべて回収するまで削除・置換しないでください。

プロセスは network 無し、live な作業コピーを read-only で公開する `/workspace` と
task-local の read-only `/runtime`、`/tmp` の 64 MiB tmpfs、`/dev/shm` の 16 MiB、
Podman/conmon の独立した lifetime deadline、bounded logs を使います。workspace の
変更は process から見えますが、process からは書き込めません。cgroup v2 の memory、
pid、CPU 制限が検証できない環境では user command を実行しません。既定の lifetime
`maxSeconds` は 600 秒、同時実行 `maxProcesses` は 1 です。ホストの資格情報や環境変数を渡さず、
PID kill や host fallback も行いません。管理サーバーは host browser からアクセスできず、
framework cache は `/tmp` に置いてください。これは live disk quota、通常の one-shot
Bubblewrap、または完全な resource parity を提供する機能ではありません。

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

Prepared runs waiting for input, quota, or approval can explicitly replace the
model for one selected task. Candidates use the same host policy as initial
routing; replacement invalidates that task and its transitive dependents while
preserving independent results, budgets, counters, and immutable attempt
evidence. Preview and confirmation are bound to the run graph, operations,
usage, configuration, and active session policy. Confirmation never probes a
provider or resumes a run; a later explicit resume is required. Model-change
and resolution records are host evidence and never assert semantic equivalence.

Use `/model-change [task-id]` to select a waiting task and an eligible model,
review affected tasks, destination and preserved budgets, and explicitly confirm.
Cancellation leaves the selection unchanged. Confirmation keeps the run waiting;
only a separate `/resume` starts execution. `/model` still configures the next
request. `/tasks` shows delegation, immutable attempt reports, repair history and
model-change evidence links without treating model reports as validation proof.

独立した Firecracker agent environment の管理者セットアップ、CLI、制約は
[docs/firecracker.md](docs/firecracker.md) を参照してください。
