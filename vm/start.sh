#!/bin/bash
set -euo pipefail
if [[ $# != 1 ]]; then echo 'Usage: vm/start.sh VM_HOME' >&2; exit 64; fi
vm_dir=$(realpath -- "$1")
[[ "$vm_dir" != *','* ]] || { echo 'VM path cannot contain commas' >&2; exit 1; }
[[ -r /dev/kvm && -w /dev/kvm ]] || { echo 'KVM unavailable; no software fallback' >&2; exit 1; }
exec 9>"$vm_dir/qemu.lock"
flock --exclusive --nonblock 9 || { echo 'VM already running' >&2; exit 1; }
sha256sum "$(command -v qemu-system-x86_64)" "$(command -v qemu-img)" | cmp - "$vm_dir/qemu-binaries.sha256"
qemu-system-x86_64 --version | cmp - "$vm_dir/qemu-version.txt"
for name in os.qcow2 data.qcow2; do qemu-img check -f qcow2 "$vm_dir/$name"; done
exec qemu-system-x86_64 -accel kvm -machine q35 -cpu host -smp 4 -m 8192 \
  -drive "file=$vm_dir/os.qcow2,if=virtio,format=qcow2" \
  -drive "file=$vm_dir/data.qcow2,if=none,id=agentdata,format=qcow2" \
  -device virtio-blk-pci,drive=agentdata,serial=AGENT_DATA_DISK \
  -drive "file=$vm_dir/seed.iso,media=cdrom,readonly=on" \
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:8080-:8080,hostfwd=tcp:127.0.0.1:2222-:22 \
  -display none -monitor none -serial stdio
