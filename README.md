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

モデルは `/etc/agent/config.yaml` の `model.id`、API キーは `model.keyFile` で指定します。[設定例](examples/config.yaml) の `model` を有効にし、利用を許可したモデル ID に置き換えてください。対応する認証は OpenAI API キーです。OAuth ログインと画面上のモデル切り替えには対応していません。

```sh
sudo -u agent-control sh -c 'umask 077; cat > /srv/agent-data/control/secrets/model-key'
# API キーを入力し、Ctrl-D で保存します。
sudoedit /etc/agent/config.yaml
sudo systemctl restart agent.service
```

モデルを変更するときは、実行中の会話を停止し、`model.id` を編集してサービスを再起動します。再読み込み後、同じ会話に追記するか「再開」で新しいモデルを使います。API キーを変更する場合も再起動が必要です。

CLI・ライブラリは必要なものだけゲストへ導入します。MCP は設定例の `mcp` に stdio サーバーの絶対パスと引数を指定し、サービスを再起動してください。
作業側の HOME は `/srv/agent-data/work/home` です。ここへ登録した CLI・MCP の資格情報は Agent が利用できます。
保護する会社・VPN の公開 IP は、管理者が `/etc/agent/protected-cidrs.nft` に追加してください。

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
会話の保存先は `control/conversations-v1.sqlite` と `work/conversations/` です。旧 `state.sqlite`・`work/jobs/` は削除・変換しないでください。

## 開発・検証

Node.js 26.13.0、Git、Python 3 を用意します。

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
