#!/usr/bin/env python3
"""Auditable administrator setup for the fixed Firecracker environment helper."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

HELPER = Path("/usr/local/libexec/local-agent-firecracker")
BIN_ROOT = Path("/usr/local/lib/local-agent-firecracker")
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
    "vmm_overhead_mib": 256,
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


def _exists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


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


def validate_user(name: str) -> pwd.struct_passwd:
    if not name or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,31}", name) is None:
        raise SystemExit("--user must name one explicit local account")
    try:
        account = pwd.getpwnam(name)
    except KeyError as error:
        raise SystemExit(f"unknown local account: {name}") from error
    if account.pw_uid == 0:
        raise SystemExit("--user must not select root")
    return account


def preflight_destinations() -> None:
    destinations = (
        HELPER,
        BIN_ROOT,
        IMAGE_ROOT,
        CONFIG,
        SUDOERS,
        Path("/sys/fs/cgroup/local-agent-firecracker"),
    )
    for destination in destinations:
        if _exists(destination):
            raise SystemExit(f"refusing to overwrite an existing deployment path: {destination}")
        parent = destination.parent
        while not _exists(parent):
            parent = parent.parent
        require_root_owned(parent)
    visudo = Path("/usr/sbin/visudo")
    require_root_owned(visudo)
    if not visudo.is_file() or not os.access(visudo, os.X_OK):
        raise SystemExit("/usr/sbin/visudo is required")


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


def _resolve_guest_path(tree: Path, guest_path: str) -> Path:
    path = PurePosixPath(guest_path)
    if not path.is_absolute():
        raise SystemExit(f"guest path must be absolute: {guest_path}")
    pending = list(path.parts[1:])
    resolved: list[str] = []
    links = 0
    while pending:
        part = pending.pop(0)
        if part in {"", "."}:
            continue
        if part == "..":
            if resolved:
                resolved.pop()
            continue
        candidate = tree.joinpath(*resolved, part)
        try:
            metadata = candidate.lstat()
        except FileNotFoundError as error:
            raise SystemExit(f"missing guest path: {guest_path}") from error
        if stat.S_ISLNK(metadata.st_mode):
            links += 1
            if links > 40:
                raise SystemExit(f"too many guest symlinks: {guest_path}")
            target = os.readlink(candidate)
            if target.startswith("/"):
                resolved = []
            target_parts = list(PurePosixPath(target).parts)
            if target_parts and target_parts[0] == "/":
                target_parts = target_parts[1:]
            pending = target_parts + pending
            continue
        if pending and not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"guest path component is not a directory: {candidate}")
        resolved.append(part)
    return tree.joinpath(*resolved)


def _require_guest_executable(tree: Path, guest_path: str) -> None:
    resolved = _resolve_guest_path(tree, guest_path)
    metadata = resolved.lstat()
    if not stat.S_ISREG(metadata.st_mode) or not metadata.st_mode & 0o111:
        raise SystemExit(f"guest executable is invalid: {guest_path}")


def _guest_directory(tree: Path, guest_path: str, mode: int = 0o755) -> Path:
    path = PurePosixPath(guest_path)
    if not path.is_absolute():
        raise SystemExit(f"guest path must be absolute: {guest_path}")
    if not _exists(tree):
        tree.mkdir(mode=0o755, parents=True)
    current = tree
    for part in path.parts[1:]:
        current /= part
        if _exists(current):
            metadata = current.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise SystemExit(f"unsafe guest destination: {guest_path}")
        else:
            current.mkdir(mode=mode)
    return current


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
        _require_guest_executable(tree, "/usr/bin/python3")
        _require_guest_executable(tree, "/bin/sh")
        if not (tree / "lib/systemd/system").exists():
            raise SystemExit("the pinned guest fixture must include systemd")
        runner_destination = (
            _guest_directory(tree, "/usr/local/sbin")
            / "local-agent-guest-runner.py"
        )
        shutil.copyfile(runner, runner_destination)
        runner_destination.chmod(0o755)
        unit = (
            _guest_directory(tree, "/etc/systemd/system")
            / "local-agent-guest-runner.service"
        )
        unit.write_text(
            "[Unit]\nAfter=local-fs.target\nBefore=getty.target\n"
            "[Service]\nType=simple\nExecStart=/usr/bin/python3 -I /usr/local/sbin/local-agent-guest-runner.py\n"
            "Restart=always\nRestartSec=1\nPrivateTmp=true\nNoNewPrivileges=true\n"
            "[Install]\nWantedBy=multi-user.target\n",
            encoding="utf-8",
        )
        wants = _guest_directory(
            tree, "/etc/systemd/system/multi-user.target.wants"
        )
        (wants / unit.name).symlink_to(f"../{unit.name}")
        workspace = _guest_directory(tree, "/workspace", mode=0o777)
        workspace.chmod(0o777)
        output = destination.with_suffix(".new")
        try:
            subprocess.run(
                ["truncate", "-s", str(LIMITS["disk_bytes"]), str(output)],
                check=True,
            )
            subprocess.run(
                [mkfs, "-q", "-F", "-t", "ext4", "-d", str(tree), str(output)],
                check=True,
            )
            output.chmod(0o600)
            os.chown(output, 0, 0)
            output.replace(destination)
        finally:
            output.unlink(missing_ok=True)


def _atomic_write(path: Path, value: str, mode: int) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        mode,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _install_sudoers(user: str) -> None:
    value = f'{user} ALL=(root) NOPASSWD: {HELPER} ""\n'
    temporary = SUDOERS.with_name(f".{SUDOERS.name}.{os.getpid()}")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o440,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, 0, 0)
        validation = subprocess.run(
            ["/usr/sbin/visudo", "-cf", str(temporary)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=10,
        )
        if validation.returncode:
            raise SystemExit(
                validation.stderr.strip() or "visudo rejected the sudoers rule"
            )
        os.replace(temporary, SUDOERS)
    finally:
        temporary.unlink(missing_ok=True)


def install(assets: Path, user: str) -> None:
    require_root()
    account = validate_user(user)
    for path in (SOURCE, SOURCE / "helper.py", SOURCE / "guest_runner.py", SOURCE / "install.py"):
        require_root_owned(path)
    preflight_destinations()
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
    firecracker = BIN_ROOT / "firecracker"
    jailer = BIN_ROOT / "jailer"
    prepare_cgroup()
    BIN_ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    copy_mode(extracted / f"firecracker-v{VERSION}-x86_64", firecracker, 0o755)
    copy_mode(extracted / f"jailer-v{VERSION}-x86_64", jailer, 0o755)
    copy_mode(SOURCE / "helper.py", HELPER, 0o755)
    image_dir = IMAGE_ROOT / "images"
    image_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    kernel_destination = image_dir / "vmlinux-6.1.128"
    copy_mode(kernel, kernel_destination, 0o644)
    rootfs_destination = image_dir / "ubuntu-24.04.ext4"
    prepare_rootfs(squashfs, SOURCE / "guest_runner.py", rootfs_destination)
    for path in (BIN_ROOT, IMAGE_ROOT, image_dir, STATE_ROOT, JAILER_ROOT):
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
    _atomic_write(CONFIG, json.dumps(config, indent=2) + "\n", 0o600)
    _install_sudoers(account.pw_name)
    print(f"installed Firecracker {VERSION}; transformed rootfs digest: {config['pins']['base_rootfs']}")
    print(f"enabled the fixed helper for {account.pw_name} through the validated sudoers rule")
    print("Review the cgroup hierarchy and sudoers rule; no host kernel repair was performed.")


def _uid_exists(uid: int) -> bool:
    try:
        pwd.getpwuid(uid)
        return True
    except KeyError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("asset_directory", nargs="?")
    arguments = parser.parse_args()
    account = validate_user(arguments.user)
    if arguments.dry_run:
        if arguments.asset_directory is not None:
            parser.error("--dry-run does not accept ASSET_DIRECTORY")
        print(f"would install helper {HELPER}")
        print(f"would install Firecracker/jailer {VERSION} under {BIN_ROOT}")
        print(f"would prepare a {LIMITS['disk_bytes']} byte ext4 image under {IMAGE_ROOT / 'images'}")
        print(f"would grant only {account.pw_name} access through validated sudoers {SUDOERS}")
        return 0
    if arguments.asset_directory is None:
        parser.error("ASSET_DIRECTORY is required unless --dry-run is used")
    install(Path(arguments.asset_directory), account.pw_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
