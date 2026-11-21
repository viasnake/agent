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

## Git リポジトリを使う

「設定」→「Git」で、作業ユーザーのコミット作成者名（`user.name`）とメールアドレス（`user.email`）を変更できます。空欄にして保存すると、該当するグローバル設定を削除します。リポジトリ個別の設定は引き続き優先されます。

エージェントはセッション内に clone を作ります。最新のコードが必要な作業では対象ブランチを作業直前に `fetch` し、取得したコミットを使います。

共有ミラーを使う場合は、管理者がリポジトリごとに設定します。ミラーはセッションから読み取り専用で、メモや成果物を置く `work/shared` は引き続き書き込めます。下の例では既定のデータパス `/srv/agent-data` を使います。変更している場合はコマンドとサービス定義のパスを合わせてください。

```sh
# 更新専用の一般ユーザーを初回だけ作成する
sudo useradd --system --create-home --home-dir /var/lib/agent-git --shell /usr/sbin/nologin agent-git
sudo chmod 0700 /var/lib/agent-git
sudo install -d -o root -g agent-work -m 0750 /srv/agent-data/git-mirrors

# リポジトリごとに名前と URL を設定する
name=owner--repo
url=https://github.com/OWNER/REPO.git
mirror="/srv/agent-data/git-mirrors/$name.git"
sudo install -d -o agent-git -g agent-work -m 2750 "$mirror"
sudo -u agent-git -g agent-work -- /bin/sh -c \
  'umask 027; exec /usr/bin/git clone --bare --no-tags --template= -- "$1" "$2"' sh "$url" "$mirror"

sudo install -m 0644 examples/agent-git-refresh@.service examples/agent-git-refresh@.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now "agent-git-refresh@$name.timer"
```

更新は毎時実行されます。非公開リポジトリでは `agent-git` に専用の読み取り用 SSH 鍵と検証済みの `known_hosts` を設定し、認証情報を含まない SSH URL を指定します。セッションでの `fetch` には Agent の作業用認証設定を使います。従来の共有チェックアウトを移行するには、必要なリモートからミラーを新規作成してください。

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
