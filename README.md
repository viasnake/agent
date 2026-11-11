# Agent

Web から使える Pi Durable Agent。用意済みの Ubuntu Server にインストールし、手元のブラウザから使います。

## 必要な環境

- 導入先：Ubuntu Server 26.04（x86-64 / ARM64）、稼働中の systemd、sudo 権限、インターネット接続。
- 保存先：UUID のある ext4・XFS・Btrfs。OS のルートファイルシステムも利用できます。既定の `/srv/agent-data` とその親は root 所有とし、シンボリックリンクを含めず、他ユーザーの書き込みを許可しないでください。
- 操作端末：Windows・macOS・Linux のブラウザ。別端末から使う場合は `ssh` コマンドと、導入先への SSH 接続が必要です。

OS・ストレージ・SSH は事前に準備してください。以下のコマンドは導入先の Ubuntu で実行します。

## インストール

一般ユーザーで実行します。`install.sh` が OS パッケージの導入、CPU に合うランタイムの取得・SHA-256 検証、ビルド、配置、サービス起動を行い、必要な操作だけ sudo を使います。

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates
git clone https://github.com/viasnake/agent.git
cd agent
bash install/install.sh
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/healthz
```

`{"ok":true}` が返れば起動済みです。Node.js 26.13.0 は `/opt/agent-node`、[再配置可能な Python](https://docs.astral.sh/python-build-standalone/) 3.14.10 は `/opt/agent-python`、アプリは `/opt/agent` に配置します。起動前チェックと作業中の `node`・`npm`・`python3` は専用ランタイムを使い、OS の Node.js・Python は変更しません。systemd・nftables・sudo などの OS 機能とパッケージは Ubuntu 側で使います。

保存先を変える場合は、マウント済み領域に合わせて `bash install/install.sh --data-dir /mnt/data/agent-data` を使います。`findmnt --target /mnt/data --output TARGET,FSTYPE,UUID` でマウントと UUID を確認してください。その他の指定は `bash install/install.sh --help` で確認できます。

## ブラウザから接続

導入先にブラウザがある場合は [http://127.0.0.1:8080](http://127.0.0.1:8080) を開きます。別端末の場合は、その端末の PowerShell またはターミナルで実行します。`USER@SERVER` は Ubuntu の SSH ユーザー名と接続先に置き換えてください。

```sh
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 USER@SERVER
```

接続中のターミナルを開いたまま、手元のブラウザで [http://127.0.0.1:8080](http://127.0.0.1:8080) を開きます。UI のログイン画面はありません。この SSH 接続では既定のループバック待ち受けを使うため、8080 番の外部公開や `--trusted-peer` の追加は不要です。

手元の 8080 番が使用中なら、`sudoedit /etc/agent/config.yaml` で `server.origins` に `http://127.0.0.1:18080` を追加してサービスを再起動し、転送指定を `-L 127.0.0.1:18080:127.0.0.1:8080` に変えて [http://127.0.0.1:18080](http://127.0.0.1:18080) を開きます。

## 使い方

1. 設定したローカル URL を開き、「設定 → モデル」で接続と認証を登録します。
2. 新しいセッションの入力欄でモデルを選び、依頼を送ります。続きは同じセッションへ送ります。
3. 「会話」「ファイル」タブで履歴とファイル一覧を切り替えます。送信した添付ファイルも一覧からダウンロードできます。生成ファイルは `outputs/` に保存させます。必要なら「MCP」と「Agent 設定」を変更します。

左側の検索欄でセッション名と会話本文を検索し、各行の「…」から名前変更・ピン留め・アーカイブ・削除、会話テキストの Markdown 保存を行えます。削除すると会話履歴・添付・生成物を含む作業フォルダ全体と、そのセッションを出典とする記憶を消去します。すべての実行を停止してから削除してください。別セッションに分岐・引用された内容と、利用者が取得したダウンロード・バックアップは残ります。削除中は操作を一時停止します。失敗した場合はサービスを再起動すると削除を再開します。

メッセージ下のアイコンでコピー・引用・編集・再生成・分岐を操作できます。編集と再生成は利用枠・料金を消費し、ツールを実行する場合があります。元の履歴を残した新しいセッションを作り、作業ファイルはコピーしません。画像を含む入力の編集では保存済みの画像を保持します。

下書き本文はこのブラウザに保存します。未送信の添付ファイルは再読み込み後に選び直してください。`Ctrl / ⌘ + Enter` で送信、`Ctrl / ⌘ + Shift + F` で会話内を検索できます。コードは右上のアイコンでコピー、画像はクリックで拡大できます。

AI は通常の作業中に、役立つ情報の記憶、過去の会話の検索・出典確認、古い記憶の訂正、重複の統合・削除を判断して行います。「覚えて」という依頼は不要です。「設定 → 記憶」から手動で参照・修正でき、メッセージ下の本のアイコンでも出典付きの記憶を保存できます。保存した記憶は全セッションの次の応答で参照します。上限は32件・合計8,000文字・1件1,000文字です。統合前も含め、出典のいずれかのセッションを削除すると、その記憶も削除します。既に他の会話へ引用された内容は残ります。

過去の作業は「昨日とおととい何をしたか教えて」のように会話で尋ねます。AI が日付とタイムゾーンを確認し、保存された履歴を検索・参照して要約します。検索結果は作業の成功を証明するものではありません。履歴の検索自体はモデルを呼び出さず、要約は通常の会話の利用枠を使います。記憶・履歴の参照分は応答の入力トークンに含まれます。

GitHub Copilot は「GitHub Copilot」を選び、「Continue with GitHub」から認証ページを開いて表示されたコードを入力します。認証後は契約で利用可能なモデルを選べます。github.com のアカウントに対応しています。

ChatGPT の認証後に localhost へ接続できない場合は、認証後の URL 全体を設定画面へ貼り付けます。「テスト」はモデルの利用枠・料金を消費します。中断後は結果を確認してから「再開」します。

## 起動・停止・更新

```sh
sudo systemctl start agent.service
sudo systemctl stop agent.service

# ソースのリポジトリで実行
git pull --ff-only
sudo systemctl stop agent.service
bash install/install.sh --update
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/healthz
```

設定は `/etc/agent/config.yaml`、データは既定で `/srv/agent-data` に保存します。バックアップはサービスを停止し、両ディレクトリを所有者・権限ごと保護してコピーします。更新はデータ・資格情報・設定を保持し、以前のアプリを `/opt/agent.previous-*`、ランタイムを `/opt/agent-node.previous-*`・`/opt/agent-python.previous-*` に残します。旧形式の配置や、マウント・専用ユーザーの変更を検出した場合は上書きせず停止します。

セッション削除は、Pi の公開 API で残すデータを新しい SQLite ファイルに書き出して置き換えます。データベースのコピーに必要な空き容量を確保してください。削除済みの本文はアプリの保存ファイルから除去しますが、記憶媒体の上書き消去は行いません。再送による復活を防ぐため、本文を含まない ID とリクエストのハッシュを保持します。

起動しない場合は `sudo systemctl status agent.service agent-egress.service --no-pager` と `sudo journalctl -u agent.service -u agent-egress.service -n 100 --no-pager` で確認します。マウント・所有者・nftables・DNS の検査に失敗した場合は、表示された原因を修正してから `sudo systemctl restart agent.service` を実行してください。

## Skills

設定画面の「Skills」で [Agent Skills](https://agentskills.io/specification) 形式の Skill を追加・編集・削除できます。共有 Skills は全セッションで利用できます。

- **追加**: 「Skill を追加」で `SKILL.md` を入力するか、ファイル・フォルダーを選択して「追加」を押します。フォルダーの直下には `SKILL.md` が必要です。参照資料やスクリプトも取り込まれます。
- **編集**: 一覧の「編集」で `SKILL.md` を変更し、保存します。補助ファイルは保持されます。名前や補助ファイルを変更する場合は、手元に元のフォルダーを用意して削除・追加してください。
- **削除**: 一覧の「削除」で確認すると、補助ファイルを含む Skill 全体が削除されます。

変更は全セッションが停止している間だけ行えます。他の画面で変更された場合は再読み込みし、内容を確認して操作し直してください。取り込む前に取得元・本文・スクリプトを確認してください。外部 Skills の指示は権限の付与にはなりません。

保存先は `dataRoot/skills/<name>/` です。管理ユーザー `agent-control` が所有し、作業ユーザーは読み取り・実行だけが可能です。以前の root 所有の Skills は、サービス停止後のアプリ更新で安全な所有者・権限を検証し、内容を保ったまま管理ユーザーへ移管します。不正な既存権限は自動修正しません。直接ファイルを管理する場合もサービスを停止し、所有者を `agent-control`、ディレクトリを755、通常ファイルを644にしてください。取り込んだスクリプトは `python3 scripts/example.py` や `bash scripts/example.sh` のように実行します。

一覧の再読み込みで検証でき、変更は次の新しい実行から反映されます。`/skill:pdf-processing PDF からテキストを抽出して` で明示指定でき、通常の依頼では AI が必要な Skill を読み込みます。実行中の明示指定は停止後に送信してください。スクリプトは既存 Shell 経由で `agent-work` として実行し、成果物はセッションの `outputs/` に保存します。依存コマンドは自動インストールしません。

取り込みは1 Skill あたり合計4 MiB・各補助ファイル256 KiBまでです。本文は 64 KiB、テキスト資料は 256 KiB、探索はルート直下128件・各 Skill 内256件・深さ8、本文の合計読み込みは1 MiB、有効化した本文・補助ファイル一覧の合計は256 KiBまでです。テキスト資料は UTF-8 に限ります。前の実行で検出した Skill が変更・削除されていると、「再開」は旧版から切り替えずエラーにします。内容と作業状態を確認し、新しい入力で続行してください。プロジェクト内の Skills は自動検出しません。

## テスト

`bash install/install.sh --build-only` は sudo を使わず、ランタイムの取得・検証とビルドだけを行います。全検証は導入済みランタイムを使い、ソースのリポジトリで実行します。

```sh
export PATH="/opt/agent-node/bin:/opt/agent-python/bin:$PATH"
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```

実環境の権限・通信制限の検査は、専用 Ubuntu 環境でサービスを停止し、`sudo env AGENT_GUEST_TEST=1 /opt/agent-node/bin/node /opt/agent/scripts/guest-test.mjs` を実行します。通常 CI では管理者操作や実モデル呼び出しを行いません。
