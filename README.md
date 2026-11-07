# Agent

## VM の準備

Windows x86-64 に QEMU と WHPX、SSH 公開鍵を用意します。

```powershell
.\vm\init.ps1 -VmHome C:\AgentVM -SshPublicKey C:\Keys\agent.pub
.\vm\start.ps1 -VmHome C:\AgentVM
```

Linux/KVM では QEMU、cloud-localds、Python 3、curl、flock を用意します。

```sh
bash vm/init.sh /absolute/path/agent-vm /absolute/path/key.pub
bash vm/start.sh /absolute/path/agent-vm
```

`init` には未使用のディレクトリを指定してください。既存ディスクは上書きしません。

## ゲストへの配備

Ubuntu Server 26.04、Node.js 26.13.0 を使います。[固定した配布元・ハッシュ](vm/assets.json)。

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1
sudo cloud-init status --wait
findmnt /srv/agent-data

mkdir -p ~/agent-build && cd ~/agent-build
curl -fLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
printf '%s  node-v26.13.0-linux-x64.tar.xz\n' \
  d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997 | sha256sum -c -
tar -xf node-v26.13.0-linux-x64.tar.xz
export PATH="$PWD/node-v26.13.0-linux-x64/bin:$PATH"
git clone https://github.com/viasnake/agent.git source
cd source
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Review the source and VM configuration before deployment.
sudo install -d -m 0700 /root/agent-setup
sudo install -m 0700 vm/guest-setup.sh /root/agent-setup/install
sudo /root/agent-setup/install "$PWD" "$HOME/agent-build/node-v26.13.0-linux-x64"
sudo systemctl status agent.service
```

## 設定

1. Web の「設定 → モデル」で OpenAI のモデル ID と API キーを登録し、既定モデルを選んで「保存」します。対応モデルは Pi SDK の OpenAI カタログに含まれるものです。「有料接続テスト」は推論料金が発生する可能性があります。
2. 「MCP」でサーバーを追加します。stdio は導入済みコマンドの絶対パス・引数・必要な環境変数を、Streamable HTTP は HTTPS URL と認証方式を指定します。保存後、「接続テスト」で状態と公開ツールを確認します。
3. OAuth は「認証する」から開始します。必要なら Client ID / Secret を登録してください。認証サーバーには画面に表示される `http://127.0.0.1:8080/oauth/callback` など、実際に開いている localhost のコールバックを許可します。許可できない接続先は利用できません。
4. 社内・VPN の MCP や認証サーバーは「社内・VPN の接続許可」にホスト名を個別に追加します。loopback・メタデータへの接続、HTTP、HTTP リダイレクトは拒否します。最終 HTTPS URL を指定してください。
5. 「Agent 設定」で共通指示と上限を保存します。変更は次の会話実行開始時に反映され、サービス再起動は不要です。実行中は現在のモデル・上限を維持します。MCP の接続テストは応答終了後に行います。

設定の保存先は `/srv/agent-data/control/settings-v1.json`（所有者のみ読み書き可）です。初回だけ `/etc/agent/config.yaml` のモデル・MCP・指示・上限を取り込み、以後は Web 設定を使用します。既存の設定・資格情報ファイルは削除しません。待受・Origin・ディスク設定は引き続き管理者が `config.yaml` で設定し、サービスを再起動します。

秘密値は再表示しません。キーの変更は新しい値を入力して保存し、削除は「API キーを削除 → 保存」または「認証情報を解除」で行います。OAuth の解除はこの Agent 内の保存情報を削除します。サービス側の認可も取り消す場合は、接続先の管理画面で操作してください。

CLI・ライブラリ・stdio サーバーは必要なものだけゲストへ導入します。作業側の HOME は `/srv/agent-data/work/home` です。stdio の環境変数や作業側へ渡した CLI 資格情報は、同じ UID の Shell からも利用され得ます。保護する会社・VPN の公開 IP は、管理者が `/etc/agent/protected-cidrs.nft` に追加してください。

## 操作

1. ホストの `http://127.0.0.1:8080` を開きます。ログイン操作は不要です。
2. 「新しい会話」から依頼を送ります。続きや追加指示は同じ会話へ送ります。`Ctrl / ⌘ + Enter` でも送信できます。
3. 取得するファイルは会話の `outputs/` に保存させます。添付は `attachments/` に入ります。
4. 「停止」で中断し、実行結果を確認してから「再開」します。別の会話が実行中なら終了を待ちます。

QEMU の転送先はホストのループバックに限定し、LAN・インターネットへ公開しないでください。

再起動後の会話は自動実行しません。中断した外部更新は CLI/API で結果を確認してから続けてください。
資格情報や業務データを含む用途は VM を分け、ホストのホームや SSH agent は共有しないでください。

## 停止・バックアップ・更新

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1 sudo shutdown -h now
```

QEMU の終了後、VM ディレクトリ全体を保護された場所へコピーします。復元先には未使用のディレクトリを使ってください。

更新時は `sudo systemctl stop agent.service` で停止し、既存の `/opt/agent`・`/opt/agent-node`・`/etc/agent` を管理者が退避してから再配備します。
設定・資格情報の `control/settings-v1.json`、会話の `control/conversations-v1.sqlite`、作業ファイルの `work/conversations/` を保護してください。旧 `state.sqlite`・`work/jobs/` は削除・変換しないでください。

## 開発・検証

Node.js 26.13.0、Git、Python 3、OpenSSL を用意します。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```

実ゲストの検査は専用 VM で実行します。

```sh
sudo systemctl stop agent.service
cd /opt/agent
sudo env AGENT_GUEST_TEST=1 PATH=/opt/agent-node/bin:/usr/bin:/bin npm run test:guest
sudo systemctl start agent.service
```

実モデルの検査は依頼内容・課金・道具の権限を確認してから実行します。

```sh
AGENT_LIVE_TEST=1 AGENT_LIVE_PROMPT_FILE=/private/reviewed-prompt.txt npm run test:live
```

権限・資格情報がない検査は blocked（終了77）です。実ホストの起動・sleep/resume・復元、ゲストの分離、実モデルの品質は別途確認してください。
