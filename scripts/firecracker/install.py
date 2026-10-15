#!/usr/bin/env python3
"""Auditable administrator setup for the fixed Firecracker environment helper."""

from __future__ import annotations

import hashlib
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path("/usr/local/libexec/local-agent-firecracker")
IMAGE_ROOT = Path("/var/lib/local-agent-firecracker")
STATE_ROOT = IMAGE_ROOT / "state"
JAILER_ROOT = IMAGE_ROOT / "jailer"
CONFIG = Path("/etc/local-agent/firecracker.json")
SUDOERS = Path("/etc/sudoers.d/local-agent-firecracker")
SOURCE = Path(__file__).resolve().parent
LOCK = SOURCE / "assets.sha256"
VERSION = "1.16.2"
LIMITS = {
    "max_vms": 4,
    "vcpu_count": 2,
    "memory_mib": 2048,
    "disk_bytes": 4 * 1024 * 1024 * 1024,
    "start_ms": 60_000,
    "exec_ms": 600_000,
    "output_bytes": 1_048_576,
}
VMM_UIDS = [2000, 2001, 2002, 2003]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_root() -> None:
    if os.geteuid() != 0:
        raise SystemExit("run this explicit setup as root after reviewing it; --dry-run needs no privileges")


def copy_mode(source: Path, destination: Path, mode: int) -> None:
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(mode)
    os.chown(destination, 0, 0)


def require_root_owned(path: Path) -> None:
    current = Path(os.path.abspath(path))
    for component in (current, *current.parents):
        try:
            metadata = component.lstat()
        except OSError as error:
            raise SystemExit(f"missing setup path: {component}") from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_mode & 0o022
        ):
            raise SystemExit(f"setup path must be root-owned and not group/world-writable: {component}")


def verify_assets(assets: Path) -> dict[str, Path]:
    require_root_owned(assets)
    require_root_owned(LOCK)
    expected_names = {
        f"firecracker-v{VERSION}-x86_64.tgz",
        "vmlinux-6.1.128",
        "ubuntu-24.04.squashfs",
    }
    pins: dict[str, tuple[str, str]] = {}
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            name, digest, _url = line.split()
            pins[name] = (digest, _url)
    if set(pins) != expected_names:
        raise SystemExit("the pinned asset lock is incomplete or contains unexpected inputs")
    verified = {}
    for name, (expected, _url) in pins.items():
        path = assets / name
        require_root_owned(path)
        if not path.is_file() or sha256(path) != expected:
            raise SystemExit(f"missing or invalid pinned setup input: {name}")
        verified[name] = path
    return verified


def prepare_cgroup() -> None:
    parent = Path("/sys/fs/cgroup/local-agent-firecracker")
    parent.mkdir(mode=0o755, exist_ok=True)
    controllers = (parent / "cgroup.controllers").read_text(encoding="ascii").split()
    required = {"cpu", "memory", "pids"}
    if not required.issubset(controllers):
        raise SystemExit("the host cgroup parent must expose cpu, memory, and pids controllers")
    subtree = parent / "cgroup.subtree_control"
    enabled = set(subtree.read_text(encoding="ascii").split())
    missing = required - enabled
    if missing:
        subtree.write_text(" ".join(f"+{name}" for name in sorted(missing)), encoding="ascii")
    if not (parent / "cgroup.kill").is_file():
        raise SystemExit("the host must provide cgroup.kill in cgroup v2")


def prepare_rootfs(source: Path, runner: Path, destination: Path) -> None:
    unsquashfs = shutil.which("unsquashfs")
    mkfs = shutil.which("mkfs.ext4")
    if not unsquashfs or not mkfs:
        raise SystemExit("unsquashfs and mkfs.ext4 are required for explicit image preparation")
    with tempfile.TemporaryDirectory(prefix="local-agent-image-", dir=IMAGE_ROOT) as temporary:
        tree = Path(temporary) / "rootfs"
        subprocess.run([unsquashfs, "-no-progress", "-no-xattrs", "-d", str(tree), str(source)], check=True)
        for path in (
            tree / "etc/ssh",
            tree / "etc/cloud",
            tree / "var/lib/cloud",
            tree / "var/lib/amazon",
        ):
            if path.exists():
                shutil.rmtree(path)
        authorized = list(tree.glob("**/authorized_keys"))
        for path in authorized:
            path.unlink(missing_ok=True)
        shadow = tree / "etc/shadow"
        if shadow.exists():
            lines = []
            for line in shadow.read_text(encoding="utf-8").splitlines():
                fields = line.split(":")
                if fields and fields[0] == "root" and len(fields) > 1:
                    fields[1] = "!"
                lines.append(":".join(fields))
            shadow.write_text("\n".join(lines) + "\n", encoding="utf-8")
        for service in ("ssh.service", "sshd.service", "cloud-init.service", "cloud-init-local.service"):
            (tree / "etc/systemd/system/multi-user.target.wants" / service).unlink(missing_ok=True)
        if not (tree / "usr/bin/python3").exists() or not (tree / "bin/sh").exists():
            raise SystemExit("the pinned guest fixture must include /usr/bin/python3 and /bin/sh")
        if not (tree / "lib/systemd/system").exists():
            raise SystemExit("the pinned guest fixture must include systemd")
        runner_destination = tree / "usr/local/sbin/local-agent-guest-runner.py"
        runner_destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        shutil.copyfile(runner, runner_destination)
        runner_destination.chmod(0o755)
        unit = tree / "etc/systemd/system/local-agent-guest-runner.service"
        unit.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        unit.write_text(
            "[Unit]\nAfter=local-fs.target\nBefore=getty.target\n"
            "[Service]\nType=simple\nExecStart=/usr/bin/python3 -I /usr/local/sbin/local-agent-guest-runner.py\n"
            "Restart=always\nRestartSec=1\nPrivateTmp=true\nNoNewPrivileges=true\n"
            "[Install]\nWantedBy=multi-user.target\n",
            encoding="utf-8",
        )
        wants = tree / "etc/systemd/system/multi-user.target.wants"
        wants.mkdir(mode=0o755, parents=True, exist_ok=True)
        (wants / unit.name).symlink_to(unit)
        workspace = tree / "workspace"
        workspace.mkdir(mode=0o777, exist_ok=True)
        output = destination.with_suffix(".new")
        subprocess.run(["truncate", "-s", str(LIMITS["disk_bytes"]), str(output)], check=True)
        subprocess.run([mkfs, "-q", "-F", "-t", "ext4", "-d", str(tree), str(output)], check=True)
        output.chmod(0o600)
        os.chown(output, 0, 0)
        output.replace(destination)


def install(assets: Path) -> None:
    require_root()
    for path in (SOURCE, SOURCE / "helper.py", SOURCE / "guest_runner.py", SOURCE / "install.py"):
        require_root_owned(path)
    if any(_uid_exists(uid) for uid in VMM_UIDS):
        raise SystemExit("the reserved VMM UID pool overlaps an existing host account")
    verified = verify_assets(assets)
    archive = verified[f"firecracker-v{VERSION}-x86_64.tgz"]
    kernel = verified["vmlinux-6.1.128"]
    squashfs = verified["ubuntu-24.04.squashfs"]
    release = IMAGE_ROOT / "release"
    release.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run(["tar", "-xzf", str(archive), "-C", str(release), "--no-same-owner"], check=True)
    extracted = release / f"release-v{VERSION}-x86_64"
    firecracker = ROOT / f"firecracker-v{VERSION}-x86_64"
    jailer = ROOT / f"jailer-v{VERSION}-x86_64"
    prepare_cgroup()
    ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    copy_mode(extracted / f"firecracker-v{VERSION}-x86_64", firecracker, 0o755)
    copy_mode(extracted / f"jailer-v{VERSION}-x86_64", jailer, 0o755)
    copy_mode(SOURCE / "helper.py", ROOT / "local-agent-firecracker", 0o755)
    image_dir = IMAGE_ROOT / "images"
    image_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    kernel_destination = image_dir / "vmlinux-6.1.128"
    copy_mode(kernel, kernel_destination, 0o644)
    rootfs_destination = image_dir / "ubuntu-24.04.ext4"
    prepare_rootfs(squashfs, SOURCE / "guest_runner.py", rootfs_destination)
    for path in (ROOT, IMAGE_ROOT, image_dir, STATE_ROOT, JAILER_ROOT):
        path.mkdir(mode=0o700 if path in (STATE_ROOT, JAILER_ROOT) else 0o755, parents=True, exist_ok=True)
        os.chown(path, 0, 0)
    config = {
        "version": 1,
        "firecracker_version": VERSION,
        "jailer_version": VERSION,
        "firecracker": str(firecracker),
        "jailer": str(jailer),
        "kernel": str(kernel_destination),
        "base_rootfs": str(rootfs_destination),
        "state_dir": str(STATE_ROOT),
        "jailer_dir": str(JAILER_ROOT),
        "cgroup_parent": "local-agent-firecracker",
        "vmm_uids": VMM_UIDS,
        "limits": LIMITS,
        "pins": {
            "firecracker": sha256(firecracker),
            "jailer": sha256(jailer),
            "kernel": sha256(kernel_destination),
            "base_rootfs": sha256(rootfs_destination),
        },
    }
    CONFIG.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    CONFIG.chmod(0o600)
    os.chown(CONFIG, 0, 0)
    SUDOERS.write_text(
        f'ALL ALL=(root) NOPASSWD: {ROOT / "local-agent-firecracker"} ""\n',
        encoding="utf-8",
    )
    SUDOERS.chmod(0o440)
    os.chown(SUDOERS, 0, 0)
    print(f"installed Firecracker {VERSION}; transformed rootfs digest: {config['pins']['base_rootfs']}")
    print("Review the cgroup hierarchy and sudoers rule before enabling the helper.")


def _uid_exists(uid: int) -> bool:
    try:
        pwd.getpwuid(uid)
        return True
    except KeyError:
        return False


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--dry-run":
        print(f"would install Firecracker/jailer {VERSION} under {ROOT}")
        print(f"would prepare a {LIMITS['disk_bytes']} byte ext4 image under {IMAGE_ROOT / 'images'}")
        print(f"would write root-owned config {CONFIG} and sudoers {SUDOERS}")
        return 0
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} ASSET_DIRECTORY | --dry-run")
    install(Path(sys.argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
