#!/usr/bin/env python3
"""Provision only the explicitly serialized, empty data disk. Never repair unknown data."""
import json
import os
from pathlib import Path
import pwd
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def assert_empty(stream, size):
    if size <= 0:
        raise RuntimeError("Disk has no usable size")
    zero = bytes(8 * 1024 * 1024)
    remaining = size
    while remaining:
        chunk = stream.read(min(len(zero), remaining))
        if not chunk or chunk != zero[:len(chunk)]:
            raise RuntimeError("Disk is not empty; refusing to format")
        remaining -= len(chunk)


def provision():
    if os.geteuid() != 0:
        raise RuntimeError("Run only in the provisioned guest as administrator")
    disk = Path("/dev/disk/by-id/virtio-AGENT_DATA_DISK").resolve(strict=True)
    info = json.loads(run("lsblk", "--json", "--output", "NAME,TYPE,FSTYPE,LABEL,UUID,SERIAL", str(disk)))["blockdevices"][0]
    if info["type"] != "disk" or info.get("serial", "").strip() != "AGENT_DATA_DISK" or info.get("children"):
        raise RuntimeError("Unexpected disk or partitions")
    if not info.get("fstype"):
        signatures = json.loads(run("wipefs", "--json", "--no-act", str(disk)))
        if signatures.get("signatures"):
            raise RuntimeError("Disk contains signatures; refusing to format")
        size = int(run("blockdev", "--getsize64", str(disk)))
        with disk.open("rb", buffering=0) as stream:
            assert_empty(stream, size)
        subprocess.run(["mkfs.ext4", "-L", "AGENT_DATA", str(disk)], check=True)
    elif info.get("fstype") != "ext4" or info.get("label") != "AGENT_DATA":
        raise RuntimeError("Existing filesystem is not the expected AGENT_DATA disk")
    uuid = run("blkid", "-s", "UUID", "-o", "value", str(disk))
    identity = Path("/etc/agent-data.uuid")
    if identity.exists() and identity.read_text().strip() != uuid:
        raise RuntimeError("Unexpected data UUID; administrator review is required")
    if not identity.exists():
        identity.write_text(uuid + "\n")
        identity.chmod(0o644)
    root = Path("/srv/agent-data")
    root.mkdir(mode=0o755, exist_ok=True)
    fstab = Path("/etc/fstab")
    lines = fstab.read_text().splitlines()
    existing = [line for line in lines if not line.lstrip().startswith("#") and "/srv/agent-data" in line.split()]
    entry = f"UUID={uuid} /srv/agent-data ext4 defaults,nosuid,nodev 0 2"
    if existing and existing != [entry]:
        raise RuntimeError("Existing data mount differs; refusing to replace it")
    if not existing:
        with fstab.open("a") as stream:
            stream.write("\n" + entry + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    subprocess.run(["mount", "/srv/agent-data"], check=not os.path.ismount(root))
    if run("findmnt", "-n", "-o", "UUID", "--mountpoint", str(root)) != uuid:
        raise RuntimeError("Wrong data mount")
    for user, names in {"agent-control": ["control", "control/secrets"], "agent-work": ["work", "work/conversations", "work/home", "work/tmp"]}.items():
        account = pwd.getpwnam(user)
        for name in names:
            path = root / name
            if path.exists():
                current = path.lstat()
                if not path.is_dir() or path.is_symlink() or current.st_uid != account.pw_uid or current.st_mode & 0o077:
                    raise RuntimeError(f"Existing directory has unexpected ownership or mode: {name}")
            else:
                path.mkdir(mode=0o700)
                os.chown(path, account.pw_uid, account.pw_gid)


if __name__ == "__main__":
    provision()
