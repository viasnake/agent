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

1. Web の「設定 → モデル」で「接続を追加」し、提供元（OpenAI・Anthropic・Gemini・Vertex AI・Bedrock）、名前、認証方式を指定して「保存」します。API キーは同じ画面で登録します。ChatGPT は「Continue with ChatGPT → ChatGPT の認証を開く」で認可します（設定は自動保存）。登録済みの接続・MCP は見出しで開閉できます。認証後に localhost に接続できなければ、アドレス欄の `http://127.0.0.1:1455/auth/callback?...` 全体を元の設定画面へ貼り付けて「認証を完了」を押します（10分以内）。VM ではこの貼り付け操作を使い、追加のポート転送は不要です。モデル一覧は Pi SDK の内蔵カタログで、実際の利用可否はアカウントとリージョンに従います。「テスト」は選択した認証方式の利用枠または API 料金を消費します。
2. 「MCP」でサーバーを追加します。stdio は導入済みコマンドの絶対パス・引数・必要な環境変数を、Streamable HTTP は URL と認証方式を指定します。HTTP は認証なし、Bearer Token・OAuth は HTTPS を使います。環境変数は名前と値を入力して追加します。保存後、「テスト」で状態とツールを確認します。
3. MCP の OAuth は「認証する」から開始します。必要なら Client ID / Secret を登録してください。認証サーバーには画面に表示される `http://127.0.0.1:8080/oauth/callback` など、実際に開いている localhost のコールバックを許可します。許可できない接続先は利用できません。
4. 登録した MCP URL のホストは社内・VPN のアドレスでも接続できます。別ホストの内部認証サーバーは既存の明示的な許可がある場合だけ接続できます。loopback・メタデータ、リダイレクトへの接続は拒否します。最終 URL を指定してください。
5. 「Agent 設定」で共通指示と上限を保存します。変更は次の会話実行開始時に反映され、サービス再起動は不要です。実行中は現在のモデル・上限を維持します。MCP の接続テストは応答終了後に行います。

設定の保存先は `/srv/agent-data/control/settings-v1.json`（所有者のみ読み書き可）です。初回だけ `/etc/agent/config.yaml` のモデル・MCP・指示・上限を取り込み、以後は Web 設定を使用します。既存の設定・資格情報ファイルは削除しません。待受・Origin・ディスク設定は引き続き管理者が `config.yaml` で設定し、サービスを再起動します。

Vertex AI はプロジェクト ID・ロケーションを指定し、[ADC](https://docs.cloud.google.com/docs/authentication/application-default-credentials) で認証します。Bedrock はリージョンと、必要なら AWS プロファイルを指定し、[AWS 認証情報](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html)または Web で登録した Bedrock API キーを使います。認証ファイルは管理者が `/srv/agent-data/control/secrets/` に `agent-control` 所有・0600 で用意し、`agent.service` の systemd 設定で `GOOGLE_APPLICATION_CREDENTIALS`、`AWS_SHARED_CREDENTIALS_FILE`、必要なら `AWS_CONFIG_FILE` にパスを指定して再起動します。作業側には渡しません。ADC・AWS の認証を選んだだけではアクセス確認済みにはなりません。Bedrock の拡張思考には未対応です。

ChatGPT のトークンは自動更新します。認証が失効した場合は同じボタンから再認証してください。Pi 1.5.0 はサインインごとに新規クライアントを登録するため、不要な登録は ChatGPT 側で解除します。VM 内のループバックポート1455が使用中の場合は、その認証操作を終えてからやり直してください。

秘密値は再表示しません。キーの変更は新しい値を入力して保存し、キーの削除は入力欄を空にして保存します。接続全体を削除する場合は「接続を削除」を押します。MCP の資格情報は「認証情報を解除」で消せます。登録済みの値は伏せ字で表示します。環境変数は行ごとに追加・編集・削除できます。接続を削除しても会話は残り、別の接続とモデルを選び直せます。OAuth の解除はこの Agent 内の保存情報を削除します。サービス側の認可も取り消す場合は、接続先の管理画面で操作してください。

CLI・ライブラリ・stdio サーバーは必要なものだけゲストへ導入します。作業側の HOME は `/srv/agent-data/work/home` です。stdio の環境変数や作業側へ渡した CLI 資格情報は、同じ UID の Shell からも利用され得ます。保護する会社・VPN の公開 IP は、管理者が `/etc/agent/protected-cidrs.nft` に追加してください。

## 操作

1. ホストの `http://127.0.0.1:8080` を開きます。ログイン操作は不要です。
2. 入力欄のモデル名を押し、登録した接続のモデルを検索して選び、依頼を送ります。設定画面でモデルを登録する必要はありません。選択は会話ごとに保存され、応答終了後に変更できます。続きや追加指示は同じ会話へ送ります。`Ctrl / ⌘ + Enter` でも送信できます。
3. 取得するファイルは会話の `outputs/` に保存させます。添付は `attachments/` に入ります。
4. 「停止」で中断し、実行結果を確認してから「再開」します。別の会話が実行中なら終了を待ちます。

画像は添付ボタンから PNG・JPEG・WebP の静止画を選び、画像対応モデルへ送信します。画像は会話内にも表示されます。1枚5 MB・各辺2048 px、1回8枚・合計20 MBまでで、自動縮小・再圧縮はしません。提供元の制限がより厳しい場合は、その制限に合う画像を用意してください。画像生成・音声・動画の入力には対応していません。

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
