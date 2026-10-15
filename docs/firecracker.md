# Firecracker 環境

Firecracker 環境は既存の TUI、Pi、Harness、SQLite、通常の sandbox とは独立した
`ExecutionEnvironment` です。`execution.backend` は変更しません。PR1 では、ゲストの
`/workspace` と直接実行する argv だけを公開し、既存のホスト向け file tools が
ゲストと別の作業領域を見る中間状態を作りません。

## セットアップ（管理者の明示操作）

セットアップは自動診断や `agent` 起動から実行されません。root で実行する前に
スクリプト、pins、sudoers を確認してください。ここではホストの `/dev/kvm` の
権限や Proxmox、カーネル設定を変更しません。

1. 非特権ユーザーで、固定 URL の入力をダウンロードして検証します。

   ```sh
   python3 -I scripts/firecracker/fetch_assets.py /home/ubuntu/firecracker-pr1/assets
   ```

   Firecracker と jailer は公式 v1.16.2 の release checksum、kernel と Ubuntu
   squashfs は `assets.sha256` の固定 S3 URL と literal SHA256 で検証します。
   初期 fixture は Firecracker CI v1.12 の `vmlinux-6.1.128` と
   `ubuntu-24.04.squashfs` です。v1.16 の同一 S3 fixture が公開されていないため
   の互換性用入力であり、本番用に硬化済みだとは扱いません。管理者は kernel/rootfs
   を更新して再検査し、変換後 ext4 の digest を config に記録します。

2. まず非特権の dry run で固定先を確認します。

   ```sh
   python3 -I scripts/firecracker/install.py --user ubuntu --dry-run
   ```

3. レビューした setup files を root 専用の staging directory に置き、そこから
   承認された管理操作として実行します。root でユーザー書き込み可能な checkout の
   Python script や asset を直接実行・読み込みしないでください。

   ```sh
   sudo install -d -o root -g root -m 0700 /root/local-agent-firecracker-setup
   sudo install -o root -g root -m 0644 scripts/firecracker/assets.sha256 /root/local-agent-firecracker-setup/
   sudo install -o root -g root -m 0644 scripts/firecracker/helper.py /root/local-agent-firecracker-setup/
   sudo install -o root -g root -m 0644 scripts/firecracker/guest_runner.py /root/local-agent-firecracker-setup/
   sudo install -o root -g root -m 0700 scripts/firecracker/install.py /root/local-agent-firecracker-setup/
   sudo install -d -o root -g root -m 0700 /root/local-agent-firecracker-setup/assets
   sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-pr1/assets/firecracker-v1.16.2-x86_64.tgz /root/local-agent-firecracker-setup/assets/
   sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-pr1/assets/vmlinux-6.1.128 /root/local-agent-firecracker-setup/assets/
   sudo install -o root -g root -m 0600 /home/ubuntu/firecracker-pr1/assets/ubuntu-24.04.squashfs /root/local-agent-firecracker-setup/assets/
   ```

   staging directory 内の script と asset をここで改めてレビューし、すべて
   root-owned・非 writable であることを確認してから、次の明示操作を実行します。

   ```sh
   sudo -n python3 -I /root/local-agent-firecracker-setup/install.py --user ubuntu /root/local-agent-firecracker-setup/assets
   ```

   `unsquashfs` で trusted squashfs を一度展開し、SSH host key、authorized keys、
   cloud-init、SSH 関連を除去し、Guest Runner と systemd unit を注入して
   `mkfs.ext4 -d` で固定サイズの writable root disk を作ります。guest disk を
   host で mount/extract したり、VM 起動後の disk を image source にしたりしません。
   root-owned `/etc/local-agent/firecracker.json` には変換後 digest、バージョン、
   fixed limits、専用 VMM UID pool が記録されます。

4. helper は `/usr/local/libexec/local-agent-firecracker` という executable file、
   Firecracker と jailer は `/usr/local/lib/local-agent-firecracker/firecracker` と
   `jailer` に配置されます。installer は既存の deployment/state を上書きせず、
   destination の root ownership・symlink・writable ancestor を事前検査します。
   `--user` で指定した一つの非 root account だけに sudoers を限定し、`visudo -cf`
   の検証後に atomic install します。install 成功時点で、選択した account だけが
   fixed helper を実行できる sudoers rule が有効になります。runtime の `sudo` は `-n`、isolated Python、
   fixed absolute helper のみを使い、caller の path、uid、image、jailer flags は
   受け取りません。管理者が先に cgroup v2 の CPU/memory/pids と empty network
   namespace の要件を確認してください。guest RAM の `memory_mib` に加えて固定
   `vmm_overhead_mib`（初期値 256 MiB）を host cgroup の `memory.max` に計上するため、
   初期設定の host memory cap は 2304 MiB です（guest 2048 + VMM overhead 256）。

Helper は root-owned metadata、per-environment flock、global allocation lock を
使います。環境は所有者の `SUDO_UID` だけが操作でき、VMM は Agent/root ではない
pool UID に降格します。停止前には Guest Runner の認証済み `sync`（`os.sync`）を
必ず完了し、失敗時は回収しても clean success を返しません。persistent disk は
固定 inode のまま jail 内から hard link で開き、停止時に全体コピーしません。
停止時は cgroup v2 の `cgroup.kill` で確実に回収し、disk を保持します。destroy
だけが disk、network namespace、metadata を消します。

## CLI とプロトコル

```sh
agent --json environment doctor
agent --json environment create
agent --json environment start <uuid>
agent --json environment status <uuid>
agent --json environment exec <uuid> -- /bin/sh -c 'printf marker'
agent --json environment stop <uuid>
agent --json environment destroy <uuid>
```

`exec` は shell に再解釈されず argv をそのまま Guest Runner に渡し、通常は VM を
停止しません。`--timeout-ms` と `--max-output-bytes` は管理上限以下にだけ下げられ
ます。JSON stdin/stdout、frame、argv、output、timeout には上限があり、TS と helper
の両方で response shape を検査します。Guest Runner は boot args の環境 ID/secret、
nonce、双方向 HMAC、protocol version を検証します。認証・vsock・readiness・実行結果
が不明なら成功を返さず VM を停止して `failed` にします。

Readiness はプロセスが起動しただけでは成功せず、protocol version/ID、writable
`/workspace`、`/bin/sh`、`python3` を確認します。guest command は `/workspace`、
sanitized environment、process group cleanup、1 VM あたり同時 1 接続で実行します。
NIC/TAP、guest initiated host listener、host credential、original Git repository は
VM に公開しません。

## Proxmox / KVM diagnostics

`doctor` は KVM access、`KVM_GET_API_VERSION == 12`、`KVM_CREATE_VM`、CPU の
`vmx`/`svm` と nested virtualization、fixed assets/digests、cgroup v2、`ip`、
network policy を分けて報告します。`/dev/kvm` が `root:kvm 0660` で caller が kvm
group に入っていなくても、KVM check は root helper の access を検査するため caller
の直接 access は不要です。診断は CPU、cgroup、NIC/TAP を自動修復しません。
Proxmox の nested virtualization が無効、`vmx/ept` が無い、cgroup controller の
delegation が無い場合も修正を自動適用しません。管理者がこの VM の host policy を
確認してから再診断してください。

実 KVM テストは `AGENT_REQUIRE_FIRECRACKER=1` を明示した時だけ実行し、要件不足を
skip せず fail します。一般 CI は KVM を必要条件にしません。承認されていない間は
setup、sudo、netns、cgroup、permission change を実行しないでください。

## 現在 TUI でできないこと

TUI の既存 Shell、TaskTools の host file operations、PTY、persistence、snapshots、
network allowances、manifest、会話との環境 ID 紐付けはまだこの環境へ切り替わり
ません。これらを混在させる `execution.backend` 変更は行わず、PR2 以降で全操作を
同じ workspace 境界へ一括移行します。

## 検証状況

Python helper/Guest Runner unit tests と、Firecracker に限定した TypeScript tests は
pass しています。実 KVM boot/integration は、特権 setup の承認待ちのためまだ実行
していません。初期の v1.12 compatibility kernel/rootfs fixture は production-hardened
image ではなく、管理者による patch・更新・再検証が必要です。この PR の公開範囲は
専用 `agent environment` CLI のみで、TUI や `execution.backend` は変更しません。
