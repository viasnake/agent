# Agent

Web から依頼し、VM 内の Pi Durable に作業してもらう個人用 Agent です。
会話ごとに作業ディレクトリを持ち、ファイル・Shell・設定した MCP を使って結果を返します。
CSV が必要なら CSV、文章が必要なら Markdown など、依頼に合ったファイルを受け取れます。
応答の終了は成果の正しさを保証する判定ではありません。必要な検査は依頼に含めてください。

ホストは QEMU を手動で起動し、ブラウザーを開くだけです。ホスト常駐サービスや VM Manager は使いません。
VM 内の Agent は systemd で起動します。ブラウザーを閉じても実行は続きます。

## VM を準備する

Windows x86-64 + QEMU/WHPX、Ubuntu Server 26.04 x86-64 を想定しています。
Linux/KVM 用の補助スクリプトもあります。macOS/arm64 は対象外です。
既定は4 vCPU、8 GiB RAM、OS 32 GiB・データ64 GiBの sparse qcow2 です。

Windows で QEMU と Windows Hypervisor Platform を用意し、SSH 公開鍵を指定します。
リポジトリのディレクトリから PowerShell で実行してください。

```powershell
.\vm\init.ps1 -VmHome C:\AgentVM -SshPublicKey C:\Keys\agent.pub
.\vm\start.ps1 -VmHome C:\AgentVM
```

Linux ホストでは QEMU/KVM、cloud-localds、Python 3、curl、flock を用意します。

```sh
bash vm/init.sh /absolute/path/agent-vm /absolute/path/key.pub
bash vm/start.sh /absolute/path/agent-vm
```

`init` は新しいディレクトリだけを受け付け、公式 image の固定ハッシュを照合します。
Windows の seed 作成は標準 IMAPI2FS を使い、WSL/Docker を必要としません。
起動時は記録した QEMU のバージョン・ハッシュとディスクを確認し、二重起動を拒否します。
加速器や固定ポートを利用できなければ停止します。TCG や別ポートへの自動切替はありません。
転送はホストの `127.0.0.1:8080` と `127.0.0.1:2222` だけです。

## ゲストに配備する

別のターミナルから接続します。初回はパッケージ取得と空ディスクの検査に時間がかかります。

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1
sudo cloud-init status --wait
findmnt /srv/agent-data
```

以下はゲストの `agent-admin` で実行します。Node.js と image の取得元・ハッシュは [vm/assets.json](vm/assets.json) に固定しています。

```sh
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
# Review the source and VM configuration before administrator deployment.
sudo install -d -m 0700 /root/agent-setup
sudo install -m 0700 vm/guest-setup.sh /root/agent-setup/install
sudo /root/agent-setup/install "$PWD" "$HOME/agent-build/node-v26.13.0-linux-x64"
```

既存の `/opt/agent`・`/opt/agent-node`・`/etc/agent` は上書きしません。
更新時はサービスを停止し、管理者が既存配備を退避・確認してから再配備してください。
モデル資格情報や利用者の保存領域を配備スクリプトが削除することはありません。

```sh
sudo cat /srv/agent-data/control/secrets/ui-password
sudo systemctl status agent.service
# Host browser: http://127.0.0.1:8080
```

UI 認証情報は管理者 SSH で読みます。ログには出しません。
モデル未設定でもログイン、会話の作成・履歴閲覧ができます。

## モデル・道具を設定する

[examples/config.yaml](examples/config.yaml) を参照し、管理者が `/etc/agent/config.yaml` を編集します。
モデル接続は Pi の OpenAI API-key 接続を使います。利用者が課金・外部送信を許可した model ID を指定してください。
秘密値は YAML や UI に直接入れず、制御用の private file に置きます。

```sh
sudo -u agent-control sh -c 'umask 077; cat > /srv/agent-data/control/secrets/model-key'
# Paste the key, then press Ctrl-D.
sudoedit /etc/agent/config.yaml
sudo systemctl restart agent.service
```

```yaml
model:
  provider: openai
  id: YOUR_SELECTED_MODEL_ID
  keyFile: /srv/agent-data/control/secrets/model-key
  disclosureApproved: true
```

標準の `read`・`write`・`edit`・`bash` は Pi Durable の実装をそのまま作業 UID で実行します。
CLI やライブラリは必要なものだけゲストへ用意してください。Git は Git、GitHub は gh などを使えます。
GitHub、ブラウザー、PDF を特別扱いする専用パイプラインはありません。

MCP は **stdio のみ**対応します。公式 TypeScript SDK で設定済みサーバーのツールを列挙・呼び出します。
各呼び出しで接続し、終了時に閉じます。サーバー内メモリーの継続は保証しません。
コマンドは作業 UID で起動し、HOME は `/srv/agent-data/work/home` です。

```yaml
mcp:
  - name: local-tools
    command: /absolute/path/to/server
    args: []
```

接続・資格情報は利用者が明示的に用意します。MCP 未設定でもファイルと Shell は使えます。
認証済み CLI・MCP を作業側へ渡すことは、その資格情報の権限を Agent に委譲することです。
自由な Shell に渡した権限をプロンプトや UI 承認だけで完全に制御する仕組みはありません。
ホストのホーム、SSH agent、資格情報を自動共有しません。

## 会話を使う

「新規」から依頼文を送り、必要ならファイルを添付します。分類や固定の納品形式はありません。
会話一覧から選べば、応答終了後も同じ会話に追記して続きを実行できます。
実行中の追加指示は Pi の inbox で受け付け、次の境界で反映します。
別の会話が実行中なら busy を返し、実行待ちキューには入れません。

会話の作業ディレクトリは `work/conversations/<ID>/`、添付はその `attachments/` に保存します。
`outputs/` 内の通常ファイルは自動で一覧表示・ダウンロードできます。登録ツールは不要です。
取得対象は現在のファイルです。不変版や成果物の独自レジストリーは持ちません。

「停止」は推論を止め、子プロセスの終了を確認して中断状態にします。
実行型 MCP と Shell の子プロセスは呼び出し終了時にも回収します。常駐させたい処理は管理者が別途用意してください。
再開は OS の実行位置の復元ではありません。履歴と実際の状態を CLI/API で確認しながら続けます。
中断された外部更新が完了したか不明なら、利用者へ通常の会話で確認します。
サービス再起動後も会話とファイルは残り、実行中だった会話は中断状態になります。自動再送はしません。

送信・明示再開で新たに開始する実行の上限はモデル60回・1時間、1ツール300秒です。
1コマンドの出力は10 MiB、ファイル転送は1件20 MiBまでです。
一覧は outputs/ 内の200ファイル・走査2000項目・深さ10まで、履歴は40項目ずつ取得します。
会話は1000件、入力の重複防止記録は10000件まで保存し、自動削除しません。

## 保存・バックアップと境界

現形式は `control/conversations-v1.sqlite` と `work/conversations/` を使います。
以前の `state.sqlite`・`work/jobs/` などは読み込み・削除・自動変換しません。
旧 TUI・Job・Firecracker の保存形式に互換性はありません。設定例は schemaVersion 2 です。

正常終了し、QEMU の終了を待ってから VM ディレクトリ全体を保護された場所へコピーします。
ディスクには会話、仕事のファイル、明示設定した資格情報が含まれます。

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1 sudo shutdown -h now
```

復元先は未使用のディレクトリにし、復元後は履歴と外部サービスの現在状態を確認してから明示的に続けてください。
外部操作の exactly-once、停電時の完全な永続化、任意プロセスの完全復元は保証しません。

制御 UID は DB・モデル key・UI 認証を保持し、作業 UID が任意コードを実行します。
データ mount・UUID、固定 launcher、UID、送信制限を確認できなければ実行を拒否します。
作業側のネットワークは指定 DNS・公開 HTTP/HTTPS・preview 用 loopback 3000–3999 に限定し、
private・metadata・host gateway・IPv6 は OS 側で拒否します。
会社・VPN の公開 IP も保護する場合は、管理者が `/etc/agent/protected-cidrs.nft` に指定してください。
会社へのアクセス・業務データの送信許可は設定から推測しません。

同じ作業 UID の会話間に強い隔離はありません。実行中のディスク quota や完全な DLP もありません。
用途や信頼範囲が異なる場合は VM を分けてください。HTTP はホスト loopback 向けです。

## 開発・検証

Node.js 26.13.0、Git、Python 3、Chromium のシステムライブラリを用意します。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```

`verify` は形式・型・ビルド・Python単体試験・Pi/SQLite/ファイル/Shell/MCP/HTTP試験・実ブラウザーE2Eを実行します。
通常試験は faux provider とローカル MCP サーバーを使い、資格情報・有料推論を使いません。
生成画面は ignored の `test-results/` に保存します。

専用の配備済みテストゲストで、サービスを明示的に停止して実 UID・通信・cgroup を確認します。

```sh
sudo systemctl stop agent.service
cd /opt/agent
sudo env AGENT_GUEST_TEST=1 PATH=/opt/agent-node/bin:/usr/bin:/bin npm run test:guest
sudo systemctl start agent.service
```

実モデルの検査は、依頼内容・課金・利用する道具の権限を確認してから実行します。

```sh
AGENT_LIVE_TEST=1 AGENT_LIVE_PROMPT_FILE=/private/reviewed-prompt.txt \
  AGENT_LIVE_PASSWORD_FILE=/private/ui-password npm run test:live
```

必要な権限や資格情報がない場合は blocked、終了コード77です。
WHPX/KVM の実起動・sleep/resume・バックアップ復元、実ゲストの分離、モデルの品質は別途受入が必要です。
通常試験や PowerShell 構文確認の成功を、それらの受入成功とは扱いません。
