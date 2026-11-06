# Agent

手元の Linux VM に仕事を預け、ブラウザーで判断と成果物を確認する個人用 AI ワーカーです。
公開リポジトリの修正とテスト、patch の納品、出典付き調査、Markdown・日本語 PDF の制作を行います。
ブラウザーを閉じても、VM が動いていれば作業は続きます。

仕事は1件ずつ実行します。確認待ちの仕事も実行枠を保持します。
完了には実ファイル、現在の版に対する検証、自己レビューが必要です。
未達条件や結果不明の操作があれば、部分成果を残して停止します。

## 動作環境

ホストは Windows x86-64 + QEMU/WHPX、ゲストは Ubuntu Server 26.04 x86-64 を想定しています。
Linux/KVM 用の補助スクリプトもあります。macOS/arm64 は対象外です。
初期構成は4 vCPU、8 GiB RAM、OS 32 GiB、データ64 GiBの sparse qcow2 です。
実機受入には、後述のゲスト試験とホスト起動確認が必要です。

ホストには手動の初期準備・起動スクリプトだけを置きます。
ホスト常駐サービス、自動 VM 起動、共有フォルダー、Proxmox は使いません。
VM 内のサービスは systemd で起動します。

旧版の TUI、CLI、OAuth ログイン、Firecracker、保存形式との互換性・自動移行はありません。
既存の保存領域をこのアプリのデータディスクとして流用しないでください。

## VM を準備する

Windows には QEMU と、管理者が明示的に有効にした Windows Hypervisor Platform が必要です。
指定する SSH 公開鍵を用意してください。秘密鍵や API key を seed に入れることはありません。
初期準備は公式 Ubuntu image を取得し、[固定した SHA-256](vm/assets.json) を照合します。
QEMU の実際のバージョンも記録し、起動時に一致を確認します。

PowerShell でリポジトリのディレクトリから実行します。

```powershell
.\vm\init.ps1 -VmHome C:\AgentVM -SshPublicKey C:\Keys\agent.pub
.\vm\start.ps1 -VmHome C:\AgentVM
```

`init` は新しいディレクトリだけを受け付けます。途中で失敗しても既存ファイルを消しません。
Windows 標準 IMAPI2FS で NoCloud ISO を作成し、WSL/Docker を必要としません。
WHPX が使えない場合やポート使用中には起動を止め、別ポートや TCG に切り替えません。

初回起動はパッケージ取得と空データディスク全域の検査に時間がかかります。
別のターミナルで接続し、初期設定の終了を確認します。

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1
sudo cloud-init status --wait
findmnt /srv/agent-data
```

Linux ホストでは QEMU/KVM、`cloud-localds`、Python 3、curl、flock を用意して実行します。

```sh
bash vm/init.sh /absolute/path/agent-vm /absolute/path/ssh-key.pub
bash vm/start.sh /absolute/path/agent-vm
```

ホスト側の転送は `127.0.0.1:8080` と `127.0.0.1:2222` だけです。
ゲストの API は転送から到達できる `0.0.0.0:8080` で待ち受けます。
VM を LAN に公開する設定は含めていません。

## ゲストにインストールする

以下は VM 内の `agent-admin` で実行します。
Node.js **26.13.0** を使います。取得元とハッシュは [vm/assets.json](vm/assets.json) にあります。

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
PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" npx playwright install chromium
```

`build` は依存を導入・更新しません。ブラウザーの取得もインストール時だけです。
ソース、依存、VM 設定を確認してから、管理者専用の場所へ配備スクリプトをコピーします。

```sh
sudo install -d -m 0700 /root/agent-setup
sudo install -m 0700 vm/guest-setup.sh /root/agent-setup/install
sudo /root/agent-setup/install "$PWD" "$HOME/agent-build/node-v26.13.0-linux-x64" "$PWD/browsers"
```

`/opt/agent`、`/opt/agent-node`、`/opt/agent-browsers`、`/etc/agent` が既にある場合は上書きせず停止します。
更新はサービスを止め、管理者が既存の配備を退避・確認してから行います。
データディスクは再インストール時にも削除しません。

配備は制御用 `agent-control` と作業用 `agent-work` を分離し、固定 sudo launcher、送信制限、
Chromium の user namespace 用 AppArmor 設定、ゲスト systemd unit を登録します。
ゲストの DNS は QEMU の `10.0.2.3` に固定し、拒否対象の loopback stub を使いません。
AppArmor 設定は固定したブラウザーのパスに限って namespace を許可します。
[Ubuntu の namespace 制限](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces) と
Chromium sandbox が同時に成立することは実ゲストで確認してください。

管理者 SSH から初回の認証情報を読み、ホストのブラウザーで開きます。
認証情報はログへ出力されません。

```sh
sudo cat /srv/agent-data/control/secrets/ui-password
sudo systemctl status agent.service
# Host browser: http://127.0.0.1:8080
```

モデル未設定でもログイン、履歴の閲覧、共通指示の編集は使えます。
仕事の実行には次の設定が必要です。

## モデルと GitHub を設定する

`/etc/agent/config.yaml` を管理者が編集します。[設定例](examples/config.yaml) を参照してください。
最初の provider は Pi の OpenAI API-key 接続です。OAuth は提供しません。
利用料金と外部送信の許可を確認してから、利用者が選んだ model ID を指定してください。

秘密値は画面や YAML に直接書かず、制御用の private file に登録します。
次の操作は値を画面や shell 履歴へ出さずに入力します。

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

仕事を確認して「再開」を選びます。既存のモデルを明示的に切り替える場合は「設定中のモデルで再開」を選びます。
切替・再開でも既存仕事の残上限や期限をリセットしません。
モデルの認証に失敗した場合も履歴は残り、確認待ちになります。
PDF の全ページ画像確認には、画像入力に対応するモデルが必要です。

GitHub への書き込みは任意です。資格情報なしでも公開 HTTPS リポジトリの修正と patch 納品が使えます。
設定する場合は対象リポジトリを限定した token を同じ方法で `control/secrets/github-token` に登録し、
設定例の `github` を有効にします。仕事作成時の許可に加え、送信前に UI で対象と全ファイル内容を確認します。
専用の新しい `codex/job-<ID>` ブランチと下書き PR を API で作成します。
既存ブランチの更新、削除変更、バイナリの GitHub 納品は扱いません。これらは patch で取得できます。
worker に token を渡したり、worker の Git 設定・hook を制御 UID で実行したりはしません。

## 仕事を依頼する

「新規」から目的と完成の条件を入力します。添付は任意です。
コード仕事では公開 Git URL を指定するか、小さなファイルを添付して依頼できます。
添付は `attachments/` に置かれ、ZIP の自動展開は行いません。
コードは VM の仕事専用 `project/` で扱い、ホストのリポジトリを直接変更しません。

調査では資料 URL を依頼に含めてください。取得した本文、URL、題名、取得日時と引用を保存し、
Markdown と日本語 PDF を納品します。PDF は文字とページを機械検査し、各ページの画像をモデルへ渡して確認します。
機械検査やモデルの自己レビューは、文章の正確さや人間による品質受入を保証しません。

追加指示は「受理」と「反映」を区別して表示します。
一時停止は新しい呼び出しを止め、子処理を回収します。OS の実行位置を保存するものではありません。
再起動後は状態と残上限を復元し、実行中だった仕事を確認待ちにします。
途中の Shell や外部変更の結果が不明なら、自動で再実行しません。結果と根拠を照合画面で記録してください。
照合後も再開は明示操作です。終了した仕事の続きは新しい仕事として作成します。

既定はモデル呼び出し60回、開始から1時間、修正提案3回、1コマンド300秒です。
上限は仕事ごとに保存し、再起動や再開では復活しません。予算待ちでは利用者が明示的に回数・期限を追加できます。
費用は provider が報告した分だけを扱い、未確定の呼び出しを0円とみなしません。
添付は1件20 MiB・仕事合計50 MiB、成果物は1件50 MiB・仕事合計200 MiB、コマンドログは10 MiBまでです。
仕事は1000件、未整理の添付は合計1 GiBまで保存します。履歴の自動削除は行いません。

## 検証する

通常の検証は資格情報や有料推論を使いません。Linux では次を準備してください。
VM の初期設定には含まれています。

```sh
sudo apt-get update
sudo apt-get install -y git python3 fonts-noto-cjk poppler-utils
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```

`verify` は形式、型、ビルド、実 Pi Durable／SQLite／ファイル／HTTP の試験と Chromium E2E を実行します。
外部 provider と GitHub 応答は fixture です。実際のプロセス強制終了を含む復旧試験も実行します。
生成した画面、PDF、ページ画像は ignored の `test-results/` に置きます。

専用のテスト VM で、制御サービスを明示的に止めてから実 UID・通信・cgroup を検証します。
通常の検証に、このゲスト試験を通過したという意味はありません。

```sh
sudo systemctl stop agent.service
sudo env AGENT_GUEST_TEST=1 PATH=/opt/agent-node/bin:/usr/bin:/bin npm run test:guest
sudo systemctl start agent.service
```

実モデルの試験は、接続・課金の許可、仕事 JSON、private な UI 認証ファイルを指定して実施します。
`externalAllowed: false` の仕事だけを受け付けます。

```sh
AGENT_LIVE_TEST=1 AGENT_LIVE_JOB=examples/job-code.json \
  AGENT_LIVE_PASSWORD_FILE=/private/ui-password npm run test:live
```

調査の試験には `examples/job-research.json` を指定します。各依頼の内容を読み、個別に実行してください。

ゲストや資格情報が不足すると `blocked`、終了コード77を返します。
Windows/WHPX の init→start→ログイン、二重起動、sleep/resume、バックアップ復元は実機で別途確認します。
PowerShell の構文確認、Linux の試験成功、faux provider の成功は、それらの代用にはなりません。

## 停止・バックアップ・復元

ゲストを正常終了し、QEMU の終了を待ってから VM ディレクトリ全体をコピーします。
オンラインの SQLite 本体だけをコピーする手順ではありません。
ディスクには会話と秘密情報を含むため、ホストのディスク暗号化とバックアップ先の保護が必要です。

```sh
ssh -p 2222 -i /path/to/private-key agent-admin@127.0.0.1 sudo shutdown -h now
```

復元先は未使用のディレクトリにしてください。**復元後の最初の起動には必ず recovery hold を指定します。**
これは QEMU の fw_cfg からゲストへ渡され、外部結果の照合・人間確認前の実行を止めます。

```powershell
.\vm\start.ps1 -VmHome C:\AgentVM-Restored -RecoveryHold
```

```sh
bash vm/start.sh /absolute/path/agent-vm-restored --recovery-hold
```

画面で復旧前後の外部操作を確認し、根拠を記録してから再開します。
その後の正常起動では hold オプションを外せます。ディスクの差し替えを常に自動検知するものではありません。
SQLite WAL/NORMAL と操作記録だけで、停電を含めた外部操作の exactly-once は保証しません。

OS だけを再構築する場合は新しい VM ディレクトリを準備し、起動前に新規の空 `data.qcow2` を退避します。
停止済みバックアップのデータディスクを、未使用になった `data.qcow2` の場所へコピーしてください。
既存ファイルを上書きしないでください。初期構築は serial・filesystem・label を確認し、既存データを再フォーマットしません。
新しい OS にサービスを配備する前に `recoveryHold: true` を設定例へ指定し、復旧確認後に解除します。

## 実行境界と制約

制御側は DB・モデル key・UI 認証・GitHub token を保持し、作業側は Shell・全ファイル操作・ブラウザー・PDF を実行します。
データ mount と UUID、固定 launcher、作業 UID、送信制限を確認できなければ実行を止めます。
`agent-work` は公開 HTTP/HTTPS、指定 DNS、preview の loopback 3000–3999 のみ利用できます。
private/metadata/host gateway と IPv6 を OS 側で拒否します。
会社・VPN の公開 IP も保護する場合は、管理者が `/etc/agent/protected-cidrs.nft` に追加してください。
会社へのアクセスやデータの外部送信許可は、この設定から推測しません。

インターネット通信を許可するため、worker が読めるデータの外送を完全に防ぐ DLP ではありません。
同じ作業 UID の仕事同士に強い相互隔離はありません。個人用と業務用は別 VM・データセットに分けてください。
実行中の disk quota はありません。容量不足や子プロセス回収の不確定時には停止し、管理者の確認が必要です。
HTTP はホスト loopback 向けです。LAN 公開、SSO、一般 MCP 管理、常設マルチ Agent、Office 文書、自己更新は提供しません。
