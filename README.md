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

[http://127.0.0.1:8080](http://127.0.0.1:8080) を開き、「設定 → モデル」で接続を登録します。

会話には各ターンの最終回答が表示されます。回答内の `![説明](outputs/図.png)` のような画像は、クリックで拡大できます。セッション内の PNG・JPEG・WebP（各辺2,048px以下、1枚5 MBまで）に対応しています。

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
