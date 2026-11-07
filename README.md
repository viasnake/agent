# Agent

VM 内で動く、Web から使える Pi Durable Agent。

## 起動

QEMU と SSH 公開鍵を用意します。初回の `init` には未使用のディレクトリを指定します。

Windows（WHPX）：

```powershell
.\vm\init.ps1 -VmHome C:\AgentVM -SshPublicKey C:\Keys\agent.pub
.\vm\start.ps1 -VmHome C:\AgentVM
```

Linux（KVM、cloud-localds、Python 3、curl、flock）：

```sh
bash vm/init.sh /path/to/agent-vm /path/to/key.pub
bash vm/start.sh /path/to/agent-vm
```

## 初回配備

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1
sudo cloud-init status --wait

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

sudo install -d -m 0700 /root/agent-setup
sudo install -m 0700 vm/guest-setup.sh /root/agent-setup/install
sudo /root/agent-setup/install "$PWD" "$HOME/agent-build/node-v26.13.0-linux-x64"
```

## 使い方

1. ホストの `http://127.0.0.1:8080` を開きます。外部には公開しません。
2. 「設定 → モデル」で接続を追加し、API キーまたは「Continue with ChatGPT」で認証します。
3. 会話の入力欄でモデルを選び、依頼を送ります。続きは同じ会話へ送信します。
4. 必要なら「設定 → MCP」で道具を追加し、「Agent 設定」で共通指示と実行上限を変更します。

ChatGPT の認証後に localhost へ接続できない場合は、認証後の URL 全体を設定画面へ貼り付けます。「テスト」はモデルの利用枠・料金を消費します。

添付は `attachments/` に保存されます。生成ファイルは `outputs/` に保存させます。「停止」で中断し、結果を確認してから「再開」します。

## 管理

VM 内で実行します。

```sh
sudo systemctl status agent.service
sudo systemctl restart agent.service
sudo shutdown -h now
```

バックアップは停止後に VM ディレクトリ全体をコピーします。更新はサービスを停止し、`/opt/agent`・`/opt/agent-node`・`/etc/agent` を退避して再配備します。設定・認証・会話・ファイルを保存する `/srv/agent-data` は保持します。

## 開発

Node.js 26.13.0、Git、Python 3、OpenSSL を使います。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run build
npm test
npm run test:e2e
python3 -B -m unittest discover -s tests -p 'test_*.py'
```
