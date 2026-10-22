# Local Agent

コード変更・調査・文書作成を依頼できる、個人用の対話型ターミナル AI Agent です。コードは作業コピーで変更・検査し、差分を確認してから元のリポジトリへ適用します。

## インストールと起動

Node.js 24 以上、npm、Git が必要です。主な利用対象は Linux の端末・SSH 接続です。コードの実行・検査には Bubblewrap が必要です。macOS では隔離実行が無効になり、Shell や隔離環境を必要とする機能は使えません。

```sh
git clone https://github.com/viasnake/agent.git
cd agent
npm run build
npm link
cd /path/to/your-repository
agent
```

`npm run build` は依存関係をインストールしてからビルドします。更新する場合は、このソースディレクトリで変更を取得して再度ビルドしてください。

Ubuntu では `sudo apt-get install bubblewrap` で Bubblewrap を導入できます。起動後に `/doctor` で隔離環境を確認してください。Shell はネットワークを使えず、Bubblewrap には CPU・メモリ・実行中のディスク容量の上限がありません。

## 接続と権限の設定

初回は接続が無効です。Ctrl+P →「接続・権限・上限」（`/settings`）から準備します。

1. **接続を追加**し、使うモデルを選びます。ChatGPT・Gemini は一覧から選択でき、一覧にないモデルや互換・ローカル接続はモデル ID を入力します。別名の入力は不要です。送信を許可するデータ区分と接続の有効化も設定します。通常の会話は `private` です。接続の `allowedData` に必要な区分を指定してください。
2. ChatGPT は `/login` で認証します。API キーを使う接続では、キーを起動環境へ渡し、`secretEnv` に環境変数名だけを登録します。従量 API は `limits.maxApiUsd` と接続の `maxRequestUsd` をともに正数にします。
3. コード変更には**検査コマンドを追加**し、会話の必須検査に指定します。`/doctor` で隔離環境を確認します。

モデルの追加は選択・入力した時点で保存され、ツール使用も有効になります。追加後の疎通試験は不要です。設定一覧で変更した値は、閉じる際に差分を確認してまとめて保存します。変更は次の依頼から反映されます。起動と `/doctor` はモデルを呼びません。接続の問題を調べるための `/probe` は任意で、利用枠・予算を消費します。

設定例は [examples/config.yaml](examples/config.yaml) にあります。ローカル推論には OpenAI Chat Completions 互換サーバーを用意し、接続先を `127.0.0.1` または `::1` にします。`restricted` と `localOnly` はローカル接続専用、Sarashina は `public` 専用です。

### モデルと担当構成

Ctrl+L で次の依頼のモデルと担当構成を選びます。単独実行の `single`、レビュー付きの `reviewed`、分担する `assisted` を使えます。独立した読み取りタスクは並列実行できますが、書き込みタスクは他のタスクと排他実行します。

選択画面にはモデル ID と接続名が表示されます。既存のモデル設定も引き続き使えます。必要に応じて `/settings` で `roles`・`kinds`・`tools`・`images`・`maxOutputTokens` を変更できます。`thinkingLevel` は `off / minimal / low / medium / high`、空欄は未指定です。推論の深さは品質・速度・費用を保証せず、提供元によって意味が異なります。

互換・ローカル接続では、サーバーが `reasoning_effort` に対応する場合だけ `reasoning: true` を設定してください。未対応の深さを明示すると推論前に停止します。出力上限の強制は API の対応範囲に限られ、ChatGPT 接続では `max_output_tokens` を送信しません。

待機中の作業で担当モデルを変更するには `/model-change [task-id]` を使います。対象と影響する作業、送信先、予算を確認して確定し、その後 `/resume` で再開します。変更の確定だけでは推論を開始しません。`/model` は次の依頼の設定です。

### MCP の外部操作

MCP の読み取り専用ツールには `readOnly: true`、更新・投稿・削除には `readOnly: false` を指定します。必要に応じて `effect: change|publish|delete|dangerous` を設定します。分類の未指定は危険操作として扱います。

変更操作は TUI で送信先・ツール・引数を確認し、「この1回だけ実行する」を選びます。設定の保存だけでは承認されず、一括承認や自動再実行もありません。非対話 CLI では変更操作を実行できません。結果が不明な操作が残る場合は、実際の結果を確認して照合するまで次の外部変更を実行できません。

HTTP 接続の変更ツールでは URL にクエリを含めず、資格情報を OAuth または `bearerEnv` で管理してください。読み取り専用の宣言や操作分類は、外部サーバーの実装を保証するものではありません。

## 日常の操作

| 操作                                            | 動作                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| Enter / Shift+Enter                             | 送信 / 改行。実行中の Enter は追加指示           |
| Alt+Enter                                       | 現在の作業が成功した後の依頼を保存               |
| Ctrl+P / Ctrl+L                                 | 操作の検索 / 次の依頼のモデル・担当構成          |
| Esc                                             | メニューを取消。会話画面では実行を中断           |
| PgUp / PgDn                                     | 会話領域をスクロール                             |
| Ctrl+O / `/tools list`                          | 最新ツール結果の開閉 / 結果を選択                |
| `/expand [番号]` / `/history`                   | 長文の続き / 同じ会話の過去の発言                |
| `/sessions` / `/new` / `/continue`              | 会話を選択 / 新規作成 / 前回の会話を開く         |
| `/queue` / `/next`                              | 待機入力の管理 / 実行中に次の依頼を準備          |
| `/tasks` / `/status`                            | 担当・検査 / 利用量・エラーの詳細                |
| `/artifacts` / `/diff` / `/apply`               | 成果物 / 差分 / 元リポジトリへの適用             |
| `/search [文字列]` / `/fork [会話名]`           | ローカル履歴の検索 / 過去の時点から分岐          |
| `/pins` / `/context` / `/compact`               | 固定メモ / 会話の条件・原文 / 長い会話の引き継ぎ |
| `/sources` / `/research` / `/versions [文書名]` | 資料 / 調査記録 / 文書の版と差分                 |
| `/help` / `/quit`                               | 全操作の一覧 / 保存して終了                      |

メニューでは日本語やコマンド名で検索し、↑↓ と Enter で選択します。Tab でパス・コマンドを補完できます。複数行の貼り付けでは送信しません。日本語変換には OS・端末の IME を使うため、IME と Shift+Enter を扱える端末が必要です。一部端末のテンキー Enter も改行として扱います。色を無効にするには `NO_COLOR=1 agent` で起動します。

`/keys` で割当を確認し、`/keys palette ctrl+g` のように変更できます。キーを省略すると解除、`/keys reset` で既定へ戻ります。SSH・tmux が先に消費するキーには別の割当を選んでください。

`/editor` は下書きを外部エディタで編集し、`/editor artifact` は保存済み文書の改訂案を下書きへ戻します。`/editor-config ["nvim","-f"]` のように設定します。既定は `vi`、GUI エディタには `--wait` 等を指定してください。エディタは利用者の権限でホスト上で動きます。編集だけでは送信せず、元の成果物も上書きしません。

## 資料・画像・手順の添付

作業ディレクトリ内のファイルを `@src/file.ts`、空白を含む場合は `@"notes/my file.md"` で指定します。絶対パス、秘密ファイル、リンクは添付できません。送信前のプレビューで対象と送信先を確認してください。実行中の新しい添付は `/next` を使います。

| 入力         | 例                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 文書全体     | `@notes.md`                                                                                                             |
| 行・見出し   | `@"README.md::lines=10-30"`、`@"manual.md::heading=Setup"`                                                              |
| PDF          | `@"report.pdf::pages=2-3::images=yes"`                                                                                  |
| 表・スライド | `@"book.xlsx::sheet=売上::rows=2-20"`、`@"slides.pptx::slides=1-3"`                                                     |
| CSV・TSV     | `@"data.csv::rows=2-20"`                                                                                                |
| Git          | `@git:status`、`@git:working`、`@git:staged`、`@git:commit:<完全なハッシュ>`、`@git:<完全なハッシュ>..<完全なハッシュ>` |

文書は TXT、Markdown、JSON、YAML、CSV、TSV、PDF、DOCX、PPTX、XLSX に対応し、元ファイルは20 MBまでです。表計算の数式は再計算しません。PDF は最大20ページを選択でき、変換には Bubblewrap 内の `pdfinfo`・`pdftotext`・`pdftoppm`（Poppler）が必要です。事前にインストールするか `execution.runtimePaths` で公開してください。自動ダウンロードはしません。

`/git` はブランチ・状態・最近のコミットを表示します。Git 添付はコミットや適用を行いません。差分はファイルのバイト列を比較し、Git のフィルターや改行正規化は適用しません。未追跡ファイルの内容は添付しません。

### 画像

PNG・JPEG・WebP の静止画像を `@path` で添付できます。対応モデルの設定で `images` を有効にしてください。1画像5,000,000 bytes・各辺2048 px・4,194,304 pixels、会話ごとに8画像・合計20,000,000 bytesまでです。画像を縮小・再圧縮して送ることはありません。

`/images` で保持された画像を確認できます。`/images add "画像.png"` は送信せずに保存します。参照 ID を使って `/images crop <id> <x> <y> <width> <height>`、`/images mask <id> <x> <y> <width> <height>` で編集し、`/images remove <id>` で除外できます。`/images compare <before-id> <after-id>` は比較順序を指定します。除外・マスクは送信済みの内容を取り消しません。

`/clipboard` は Linux の `wl-paste` または `xclip`、macOS の `pngpaste` から PNG を下書き用に取り込みます。対応コマンドがない場合はファイルへ保存して添付してください。SSH 接続では `scp`・`sftp` などで作業ディレクトリへ転送します。

### 手順ファイル

`/skills` で作業ディレクトリの `skills/<name>/SKILL.md` を選びます。内容と必要な参照ファイルを確認して添付すると、下書きに `@"skill:skills/<name>/SKILL.md"` が入ります。別の場所は `/skills relative/path/SKILL.md` で指定できます。

手順は64,000 bytesまでの空でない UTF-8 ファイルです。選択はその依頼だけに適用され、次の依頼で使う場合は再添付します。選択だけでは送信せず、スクリプトの実行や追加権限の許可にもなりません。`.agents` などの保護された場所ではなく、作業ディレクトリ内の `skills/` に置いてください。

## コード変更と復旧

説明・調査・レビューの依頼は読み取り専用です。コードを変更したい場合は明示的に依頼してください。種類の自動判定が合わない場合は `/kind` で選択します。

検査完了後に `/diff` で差分を開き、Enter で適用確認へ進みます。`/apply` でも同じ画面が開きます。未適用の変更は次の依頼へ引き継ぎます。最初の作業コピーには未コミット変更を含む追跡済みファイルを使い、未追跡ファイルは会話設定の `includeUntracked` で追加できます。元ファイルや HEAD が外部で変わった場合は競合として停止します。

検査の `protectedPaths` に既存テストや設定を登録すると、それらの変更を不合格にできます。TypeScript/JavaScript の定義・参照・限定診断も利用できますが、プロジェクト固有の設定や依存を読み込まないため、登録した型検査・ビルドの代わりにはなりません。

失敗時は `/status` と `/artifacts` を確認します。待機・クラッシュした作業は `/resume`、結果未確定の操作は実際の結果を確認して `/reconcile` で照合します。中断・失敗で終了した作業は新しい依頼で続けてください。待機入力は `/queue` に残り、自動実行しません。

適用はファイル単位で、全ファイル一括ではありません。途中で失敗した場合は照合が必要です。バイナリ変更、symlink、hardlink、submodule は扱いません。

### オフラインの依存導入・ビルド

必要な実行環境・依存は事前に用意し、`execution.runtimePaths` で読み取り専用に公開します。`execution.profiles` に固定コマンドを登録すると、コード変更の作業担当と独立レビュー担当が実行できます。

```yaml
execution:
  runtimePaths: [/opt/node/24, /opt/npm-cache]
  profiles:
    dependencies:
      description: ロック済み依存を事前配置したキャッシュから導入
      command: >-
        mkdir -p /runtime/app &&
        cp /workspace/package.json /workspace/package-lock.json /runtime/app/ &&
        cd /runtime/app &&
        npm ci --offline --ignore-scripts --no-audit --no-fund --cache /opt/npm-cache
```

パスは実際の Node/npm と完全なオフラインキャッシュの配置先に置き換えてください。読み取り専用キャッシュへの書込みが必要な場合は、プロファイル内で `/runtime` にコピーします。不足時にネットワークを開いたり、ホストへ導入したりはしません。

依存は `/workspace/node_modules` に自動公開されません。後続コマンドでは `node /runtime/app/node_modules/typescript/bin/tsc` のように配置先を指定し、成果物を `/workspace` へ戻します。`file:` 依存やネイティブ拡張には個別の配置・ビルド設定が必要です。担当・実行・会話の分岐間で依存環境を引き継がず、ロックファイルを変更しても自動再導入はしません。

## 会話の引き継ぎと確認

`/pins add|edit|remove` と `/context add|edit|constraint` で会話の固定メモや条件を編集できます。編集は待機中に行い、会話をまたぐ恒久メモリにはなりません。長い履歴の原文は `/context original <seq>`、圧縮前の記録は `/context read <archive-id>` で読み返せます。保護された指示が上限に収まらない場合は、切り捨てず `CONTEXT_LIMIT` で停止します。

`/context-review` が確認を求めたら、根拠と維持する条件を読み、確認メモを入力して確定します。これは条件や権限を書き換える操作ではありません。同じ作業はその後 `/resume`、条件の修正は新しい依頼で行います。CLI では `agent context-review <run-id>` で表示し、`--confirm <binding> --note <text>` を付けて確定します。

`/search` は同じ作業ディレクトリの会話・資料・成果物などを文字列検索します。`/fork` では過去の発言を選んで新しい会話へ分岐できます。「保存状態ごと」はその時点の条件・資料・画像・作業コピーを復元し、「会話本文のみ」は本文だけをコピーします。待機入力・下書きはコピーしません。分岐先は読み取り専用で開き、作業は新しい依頼で始めます。

## 調査と文書の確認

Web 検索・取得は `research` の依頼で使えます。検索には設定ファイルの `web.search` が必要です。次は形式例で、動作するサービスの指定ではありません。

```yaml
web:
  allowedHosts: [search.example.com, sources.example.com]
  allowedData: [public]
  search:
    endpoint: https://search.example.com/search
    queryParam: q
```

検索先は HTTPS の443番ポートで、資格情報・クエリ・フラグメントを含まない URL を指定します。検索語は GET のクエリ引数として送ります。サービスは `{ "results": [{ "title": "題名", "url": "https://sources.example.com/page", "snippet": "短文" }] }` 形式の JSON、またはリンクを含む HTML を返す必要があります。検索先だけでなく取得するページのホストも許可してください。

`restricted`・`localOnly`、または会話・添付の区分が `web.allowedData` に含まれない場合は Web を使えません。秘密情報を検索語に含めないでください。既定の外部検索サービスはなく、ページの JavaScript も実行しません。

`/research` で調査メモ・検索履歴を確認します。検索のスニペットと取得した本文は別の記録です。`/sources` で本文を読み、資料を選んで今後の送信から除外できます。関連する別範囲・PDF画像も対象になります。除外後は新しい依頼で続けてください。除外は元ファイル・ローカル履歴の削除や、過去の回答・送信済みデータの取消ではありません。

`/versions [文書名]` で保存済み文書の版、差分、出典、検査結果を確認できます。検査成功は意味・事実の正しさを保証しません。

### 日本語の表記確認

```sh
agent writing-check --source original.md --candidate draft.md --style polite --must-keep 青葉会議 --must-keep 参加費0円
```

ローカルの UTF-8 ファイルを読み、推論・送信・編集せず JSON で結果を表示します。各ファイルは1 MB・10,000行までです。`--must-keep` の完全一致文字列が欠けると `error`、日時・数値・URL・文体などの候補は `review`、検査上限に達すると `truncated` と表示します。誤検出があるため原文と照合してください。終了コード0は文書全体の品質合格ではありません。

`--terminology terms.yaml` で、`preferred` と `alternatives` を持つ項目の YAML 配列を指定できます。例: `[{preferred: ユーザー, alternatives: [ユーザ]}]`。

### モデル構成の比較

[examples/comparison.yaml](examples/comparison.yaml) を編集し、接続・モデル・予算を設定して実行します。

```sh
agent eval-compare --suite examples/comparison.yaml
agent eval-compare --suite examples/comparison.yaml --confirm-run
agent eval-report <comparison-id> --summary-only
```

最初のコマンドは試行数と予算の確認のみです。`--confirm-run` は全試行の推論を許可し、利用枠・費用を消費します。入力パスは設定ファイル基準です。各試行は独立し、元リポジトリに変更を適用しません。中断した比較は自動再実行しません。

レポートは実行成功、機械検査、人手評価を区別します。未報告の費用・未評価の品質は `null`、`knownCostUsd` は判明分のみです。時間には失敗した試行も含むため、早い失敗を高速化と解釈しないでください。

人手評価は `reviewer`・`accepted`・`majorDefects`・`reworkCount`・`evidence` を持つ JSON/YAML に記入し、`agent eval-assess <comparison-id> <run-id> --assessment assessment.yaml --confirm` で登録します。成果物と条件を読み、欠陥の場所や理由を根拠として残してください。レポートには依頼文・入力パス・評価理由が含まれるため、共有前に確認します。

## 保存・バックアップ・削除

設定・履歴は Linux では `~/.local/share/local-agent`、macOS では `~/Library/Application Support/Local Agent` に保存します。`--home /絶対パス` または `AGENT_HOME` で変更できます。保存先は対象リポジトリの外に置いてください。履歴や画像には非公開の内容が含まれるため、保存領域をそのまま共有しないでください。

### 診断情報の共有

`/diagnostics /保存先/新しいファイル.json` で出力を確認し、確定すると保存します。CLI は `agent diagnostics` がプレビュー、`agent diagnostics /保存先/新しいファイル.json --write` が保存です。既存の所有ディレクトリ内で、Agent 領域外の未使用ファイル名を指定してください。

本文・資格情報などを含めず、バージョンや状態別件数などを出力します。環境特性は残るため共有前に確認してください。接続や隔離環境の試験ではありません。`/doctor` の詳細には接続名などが含まれるため、そのまま共有しないでください。

### 履歴のバックアップと閲覧

他の Agent 画面を閉じ、実行・適用・評価を停止してから `/backup /保存先/新しいディレクトリ` を実行します。保存先は既存の所有ディレクトリ内で、Agent 領域と全作業ディレクトリの外にします。CLI では次のように確認・作成・検査できます。

```sh
agent backup /保存先/新しいディレクトリ
agent backup /保存先/新しいディレクトリ --write
agent backup-verify /保存先/新しいディレクトリ
agent backup-read /保存先/新しいディレクトリ
```

全作業場所の会話、設定、資料、参照中の画像、保存済みの作業状態を含みます。認証情報、依存環境、稼働プロセス、現在の未保存作業コピーは含みません。履歴を閲覧するための非公開アーカイブで、稼働環境の復元や自動再開、現在の会話へのインポートには使えません。暗号化されず、過去の除外資料や手入力した秘密が残る場合があります。

既定上限は512 MB・50,000ファイルです。CLI の `--max-bytes`、`--max-files`、`--timeout-seconds` で調整できます（最大5 GB・100,000ファイル・120秒）。検査はハッシュや参照の整合性を確認し、内容の正しさを保証するものではありません。

TUI は `/backup-open /保存先`、CLI は次のように閲覧します。現在の設定や認証がなくても CLI で読めます。

```sh
agent backup-read /保存先 --conversation <会話ID>
agent backup-read /保存先 --conversation <会話ID> --message <発言番号>
agent backup-read /保存先 --section runs
agent backup-read /保存先 --run <実行ID>
agent backup-read /保存先 --section files
agent backup-read /保存先 --file <一覧のpath>
```

続きは応答の `nextOffset` を `--offset` に指定します。ファイルの書出は TUI の対象ファイルから選択するか、`agent backup-extract /保存先 <一覧のpath> /新しいファイル` で確認し、`--write` を付けて実行します。既存ファイルは上書きせず、Agent 領域・作業領域・アーカイブ内には書き出せません。書き出した設定は現在の設定に反映されません。

### 履歴とキャッシュの整理

`/delete` で会話を選び、対象と保持理由を確認して確定します。`/delete session <ID...>`、`/delete run <ID...>` でも指定できます。`/prune` は現在の作業場所と `retentionDays` を使い、開いている会話・使用中・参照が残る履歴を保護します。

物理削除が完了しなかった場合は `/cleanup-deletions` で一件ずつ再試行します。CLI の `remove`・`remove-session`・`prune` はプレビューが既定で、削除には `--write` が必要です。`cleanup-deletions --write <job-id>` は指定ジョブだけを再試行します。

共有キャッシュは `prune-cache` で候補を確認し、選択と `--write` で整理します。保留分は `cleanup-cache`、終了済みプロセスの保持記録は `/prune-pins` または `agent prune-pins` から確認できます。参照中・新しいファイル・安全性を確認できない対象は保持します。自動削除・自動再試行はしません。削除途中の中断は取り消しではなく、外部バックアップや残存データの完全消去も保証しません。

## Firecracker 環境を使う

Firecracker は専用の `agent environment` コマンドで使う独立した VM 環境です。通常の TUI・Shell・ファイル操作の実行先にはなりません。`execution.backend` を変更して有効にすることはできません。

### 管理者セットアップ

Linux x86_64、使用可能な KVM、cgroup v2 の CPU・memory・pids、ネットワーク名前空間、Python 3、`ip`、`sudo`・`visudo`、`unsquashfs`・`mkfs.ext4` が必要です。管理者がホストの条件を確認して明示的にセットアップします。起動や診断が KVM・Proxmox・カーネルの設定を自動修復することはありません。

以下は利用アカウントが `ubuntu` の例です。ユーザー名と取得先を実環境に置き換え、ソースディレクトリから実行してください。

```sh
python3 -I scripts/firecracker/fetch_assets.py /home/ubuntu/firecracker-assets
python3 -I scripts/firecracker/install.py --user ubuntu --dry-run
```

取得するファイルとハッシュは [scripts/firecracker/assets.sha256](scripts/firecracker/assets.sha256) にあります。固定された kernel/rootfs は互換性確認用で、本番用に強化済みのイメージではありません。本番用途では管理者が更新・再検証する必要があります。

スクリプト、ハッシュ、sudoers の設定内容を確認し、管理者専用の場所へコピーします。一般ユーザーが書き換えられるソースを root で直接実行しないでください。

```sh
sudo install -d -o root -g root -m 0700 /root/local-agent-firecracker-setup
sudo install -o root -g root -m 0644 scripts/firecracker/assets.sha256 /root/local-agent-firecracker-setup/
sudo install -o root -g root -m 0644 scripts/firecracker/helper.py /root/local-agent-firecracker-setup/
sudo install -o root -g root -m 0644 scripts/firecracker/guest_runner.py /root/local-agent-firecracker-setup/
sudo install -o root -g root -m 0700 scripts/firecracker/install.py /root/local-agent-firecracker-setup/
sudo install -d -o root -g root -m 0700 /root/local-agent-firecracker-setup/assets
sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-assets/firecracker-v1.16.2-x86_64.tgz /root/local-agent-firecracker-setup/assets/
sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-assets/vmlinux-6.1.128 /root/local-agent-firecracker-setup/assets/
sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-assets/ubuntu-24.04.squashfs /root/local-agent-firecracker-setup/assets/
```

コピー先の内容・所有者・権限を再確認してから導入します。

```sh
sudo -n python3 -I /root/local-agent-firecracker-setup/install.py --user ubuntu /root/local-agent-firecracker-setup/assets
```

指定アカウントに限定した sudoers 規則、専用ヘルパー、イメージ、`/etc/local-agent/firecracker.json` が配置されます。既存の配置・状態は上書きしません。

### VM の操作

```sh
agent --json environment doctor
agent --json environment create
agent --json environment start <uuid>
agent --json environment status <uuid>
agent --json environment exec <uuid> -- /bin/sh -c 'printf marker'
agent --json environment stop <uuid>
agent --json environment destroy <uuid>
```

`create` が返す ID を後続の `<uuid>` に使います。`exec` はゲストの `/workspace` で実行します。`--timeout-ms` と `--max-output-bytes` で上限を下げられます。`stop` はディスクを保持し、`destroy` はディスクを含む環境を削除します。

ゲストに外部ネットワーク、ホストの資格情報、元の Git リポジトリは公開しません。依存の取得はできないため事前に準備してください。診断が失敗した場合は管理者が要件を確認し、実行結果が不明な場合は `status` で状態を確認してください。

その他の CLI 操作と引数は `agent --help`、各コマンドの `--help` で確認できます。
