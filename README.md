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
2. 会話の入力欄でモデルを選び、依頼を送ります。続きは同じ会話へ送ります。
3. 必要なら「MCP」と「Agent 設定」を変更します。生成ファイルは `outputs/` に保存させます。

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
