#!/bin/bash
set -euo pipefail
if [[ $EUID != 0 || $# != 2 ]]; then echo 'Usage (guest administrator only): guest-setup.sh BUILT_SOURCE NODE_DIRECTORY' >&2; exit 64; fi
source_dir=$(realpath -- "$1")
node_dir=$(realpath -- "$2")
[[ $(findmnt -n -o LABEL --mountpoint /srv/agent-data) == AGENT_DATA ]]
[[ $(id -u agent-control) == 980 && $(id -u agent-work) == 981 ]]
[[ ! -e /opt/agent && ! -e /opt/agent-node && ! -e /etc/agent ]] || { echo 'Installation exists; refusing to overwrite' >&2; exit 1; }
[[ -f "$source_dir/dist/src/main.js" && -f "$source_dir/dist/web/app.js" && -f "$source_dir/package-lock.json" ]]
[[ $("$node_dir/bin/node" --version) == v26.13.0 ]]
# Copy only reviewed installation inputs; no user state, Git metadata, or external symlink targets.
python3 - "$source_dir" "$node_dir" <<'PY'
from pathlib import Path
import os,shutil,sys
source,node=map(Path,sys.argv[1:])
for root in [source,node]:
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            path=Path(current)/name
            if path.is_symlink() and not path.resolve().is_relative_to(root):
                raise RuntimeError('External install symlink: '+str(path))
Path('/opt/agent').mkdir(mode=0o755)
for name in ['dist','node_modules','vm','examples','scripts']:
    shutil.copytree(source/name,Path('/opt/agent')/name,symlinks=True)
for name in ['package.json','package-lock.json','README.md']:
    shutil.copy2(source/name,Path('/opt/agent')/name)
shutil.copytree(node,'/opt/agent-node',symlinks=True)
for root in ['/opt/agent','/opt/agent-node']:
    for current,dirs,files in os.walk(root,followlinks=False):
        os.chmod(current,0o755)
        for name in files:
            path=Path(current)/name
            if not path.is_symlink():
                os.chmod(path,0o755 if path.stat().st_mode & 0o111 else 0o644)
        os.chown(current,0,0)
        for name in dirs+files:
            os.chown(Path(current)/name,0,0,follow_symlinks=False)
PY
install -d -o root -g agent-control -m 0750 /etc/agent
install -o root -g agent-control -m 0640 "$source_dir/examples/config.yaml" /etc/agent/config.yaml
# Work UID DNS must not use systemd-resolved's blocked loopback stub.
[[ ! -L /etc/resolv.conf ]] || rm -- /etc/resolv.conf
install -o root -g root -m 0644 "$source_dir/vm/resolv.conf" /etc/resolv.conf
install -o root -g root -m 0644 "$source_dir/vm/egress.nft" /etc/agent/egress.nft
install -o root -g root -m 0644 "$source_dir/vm/protected-cidrs.nft" /etc/agent/protected-cidrs.nft
install -o root -g root -m 0755 "$source_dir/vm/agent-work" /usr/local/libexec/agent-work
install -o root -g root -m 0755 "$source_dir/vm/agent-preflight" /usr/local/libexec/agent-preflight
visudo -cf "$source_dir/vm/agent.sudoers"
install -o root -g root -m 0440 "$source_dir/vm/agent.sudoers" /etc/sudoers.d/agent-work
install -o root -g root -m 0644 "$source_dir/vm/agent.service" /etc/systemd/system/agent.service
install -o root -g root -m 0644 "$source_dir/vm/agent-egress.service" /etc/systemd/system/agent-egress.service
systemctl daemon-reload
systemctl enable --now agent.service
printf 'Installed. Open http://127.0.0.1:8080 on the QEMU host.\n'
