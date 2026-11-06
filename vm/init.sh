#!/bin/bash
set -euo pipefail
if [[ $# != 2 ]]; then echo 'Usage: vm/init.sh VM_HOME SSH_PUBLIC_KEY' >&2; exit 64; fi
vm_dir=$(realpath -m -- "$1")
key_file=$(realpath -- "$2")
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
for tool in qemu-img qemu-system-x86_64 cloud-localds curl python3 sha256sum; do command -v "$tool" >/dev/null; done
[[ ! -e "$vm_dir" ]] || { echo 'VM home already exists; refusing to overwrite' >&2; exit 1; }
mkdir -m 700 -- "$vm_dir"
readarray -t image < <(python3 - "$script_dir/assets.json" <<'PY'
import json,sys
asset=json.load(open(sys.argv[1]))['ubuntu']
print(asset['url']);print(asset['sha256'])
PY
)
curl --fail --location --proto '=https' --tlsv1.2 "${image[0]}" -o "$vm_dir/base.img"
(cd -- "$vm_dir" && printf '%s  base.img\n' "${image[1]}" | sha256sum --check)
qemu-img convert -O qcow2 "$vm_dir/base.img" "$vm_dir/os.qcow2"
qemu-img resize "$vm_dir/os.qcow2" 32G
qemu-img create -f qcow2 "$vm_dir/data.qcow2" 64G
python3 "$script_dir/make-seed.py" --ssh-key "$key_file" --output "$vm_dir/seed"
cloud-localds "$vm_dir/seed.iso" "$vm_dir/seed/user-data" "$vm_dir/seed/meta-data"
qemu-system-x86_64 --version > "$vm_dir/qemu-version.txt"
sha256sum "$(command -v qemu-system-x86_64)" "$(command -v qemu-img)" > "$vm_dir/qemu-binaries.sha256"
printf 'Prepared %s. Start manually with vm/start.sh.\n' "$vm_dir"
