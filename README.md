# Agent

Web から使える Pi Durable Agent。Ubuntu Server 26.04、systemd、Node.js 26.13.0、永続ストレージが必要です。マシンの準備と接続経路は [Devbox](https://github.com/viasnake/devbox) などで用意します。

## インストール

展開済み Node.js のディレクトリを指定します。データ保存先の親は root 所有とし、ext4・XFS・Btrfs の永続ファイルシステムを事前にマウントしてください。OS のルートファイルシステムも利用できます。

```sh
sudo apt-get install git python3 python3-venv openssl curl nftables sudo util-linux procps
export PATH="/path/to/node-v26.13.0-linux-x64/bin:$PATH"
git clone https://github.com/viasnake/agent.git
cd agent
npm ci --ignore-scripts --no-audit --no-fund
npm run build
sudo bash install/install.sh "$PWD" /path/to/node-v26.13.0-linux-x64 --data-dir /srv/agent-data
sudo systemctl enable --now agent.service
```

既定では `127.0.0.1:8080` で待ち受けます。転送を使う場合は、インストール時に `--listen <待受IP> --trusted-peer <転送元IP> --origin http://localhost:<公開ポート>` を指定します。接続元と Origin は自動許可しません。

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

# 更新したソースでビルドしてから実行
npm ci --ignore-scripts --no-audit --no-fund
npm run build
sudo bash install/install.sh "$PWD" /path/to/node-v26.13.0-linux-x64 --update
sudo systemctl start agent.service
```

設定は `/etc/agent/config.yaml`、データは既定で `/srv/agent-data` に保存します。バックアップはサービスを停止し、両ディレクトリを所有者・権限ごと保護してコピーします。更新はデータ・資格情報・設定を保持し、以前のアプリを `/opt/agent.previous-*`、ランタイムを `/opt/agent-node.previous-*` に残します。旧形式の配置や、マウント・専用ユーザーの変更を検出した場合は上書きせず停止します。

## テスト

```sh
npx playwright install --with-deps chromium
npm run build
npm test
npm run test:e2e
npm run test:install
```

実環境の権限・通信制限の検査は、専用 Ubuntu 環境でサービスを停止し、`sudo env AGENT_GUEST_TEST=1 /opt/agent-node/bin/node /opt/agent/scripts/guest-test.mjs` を実行します。通常 CI では管理者操作や実モデル呼び出しを行いません。
