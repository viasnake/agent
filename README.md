# Agent

## インストール

Ubuntu Server 26.04 で一般ユーザーとして実行します。

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates
git clone https://github.com/viasnake/agent.git
cd agent
bash install/install.sh
```

## 接続

別端末からは SSH で転送します。UI に認証がないため、手元の待ち受けは `127.0.0.1` に限定します。

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 USER@SERVER
```

CLI のログインにはサイドバーの「ターミナル」を使います。別タブで `agent-work` のホームを開き、CLI がホームに保存した認証情報はエージェントの実行でも使えます。デバイスコード方式は手元のブラウザで認証できます。タブを閉じるか「切断」を押すとシェルは終了します。同時に開ける端末は1つで、接続は最長30分です。

## 更新

```sh
git pull --ff-only
sudo systemctl stop agent.service
bash install/install.sh --update
```

## テスト

```sh
export PATH="/opt/agent-node/bin:/opt/agent-python/bin:$PATH"
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
```
