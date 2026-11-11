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
3. 「会話」「ファイル」タブで履歴と生成ファイルを切り替えます。生成ファイルは `outputs/` に保存させます。必要なら「MCP」と「Agent 設定」を変更します。

左側でセッションを検索し、各行の「…」から名前変更・ピン留め・アーカイブ・削除、会話テキストの Markdown 保存を行えます。実行中は停止してから削除します。削除したセッションは開けなくなりますが、履歴と作業ファイルはディスクに残ります。

メッセージ下のアイコンでコピー・引用・編集・再生成・分岐を操作できます。編集と再生成は利用枠・料金を消費し、ツールを実行する場合があります。元の履歴を残した新しいセッションを作り、作業ファイルはコピーしません。画像を含む入力の編集では保存済みの画像を保持します。

下書き本文はこのブラウザに保存します。未送信の添付ファイルは再読み込み後に選び直してください。`Ctrl / ⌘ + Enter` で送信、`Ctrl / ⌘ + Shift + F` で会話内を検索できます。コードは右上のアイコンでコピー、画像はクリックで拡大できます。

AI は通常の作業中に、役立つ情報の記憶、過去の会話の検索・出典確認、古い記憶の訂正、重複の統合・削除を判断して行います。「覚えて」という依頼は不要です。左下の本のアイコンから手動で参照・修正でき、メッセージ下の本のアイコンでも出典付きの記憶を保存できます。保存した記憶は全セッションの次の応答で参照します。上限は32件・合計8,000文字・1件1,000文字です。統合前も含め、出典のいずれかのセッションを削除すると、その記憶も参照対象から外れます。既に他の会話へ引用された内容は残ります。

左下のカレンダーから、ブラウザのタイムゾーンで日付別の発言・応答を確認できます。検索と日次レポートは保存済みの履歴をページ単位で読み、追加のモデル呼び出しは行いません。「さらに表示」で続きを読みます。記憶・履歴の参照分は通常の応答の入力トークンに含まれます。

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

起動しない場合は `sudo systemctl status agent.service agent-egress.service --no-pager` と `sudo journalctl -u agent.service -u agent-egress.service -n 100 --no-pager` で確認します。マウント・所有者・nftables・DNS の検査に失敗した場合は、表示された原因を修正してから `sudo systemctl restart agent.service` を実行してください。

## テスト

`bash install/install.sh --build-only` は sudo を使わず、ランタイムの取得・検証とビルドだけを行います。全検証は導入済みランタイムを使い、ソースのリポジトリで実行します。

```sh
export PATH="/opt/agent-node/bin:/opt/agent-python/bin:$PATH"
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```

実環境の権限・通信制限の検査は、専用 Ubuntu 環境でサービスを停止し、`sudo env AGENT_GUEST_TEST=1 /opt/agent-node/bin/node /opt/agent/scripts/guest-test.mjs` を実行します。通常 CI では管理者操作や実モデル呼び出しを行いません。
