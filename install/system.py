#!/opt/agent-python/bin/python3
"""Shared installation and startup checks; never creates or mounts storage."""

import grp
import ipaddress
import json
import os
import pwd
import re
import subprocess
import sys
import tempfile
from pathlib import Path

RECORD = Path("/etc/agent/installation.json")
READY = Path("/run/agent-egress.ready")


def run(*args):
    result = subprocess.run(
        args, text=True, capture_output=True, timeout=30, check=False
    )
    if result.returncode:
        raise RuntimeError("Command failed: " + args[0])
    return result.stdout.strip()


def trusted(path):
    path = Path(path)
    for current in [path, *path.parents]:
        info = current.lstat()
        if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Expected an immutable root-owned path: " + str(current))


def data_path(value):
    path = Path(value)
    if (
        not re.fullmatch(r"/[a-zA-Z0-9_./-]+", str(value))
        or str(path) != value
        or ".." in path.parts
        or path == Path("/")
    ):
        raise RuntimeError("Use a normalized absolute data path without spaces")
    if path.resolve() != path:
        raise RuntimeError("Data path must not contain symlinks")
    return path


def storage(path):
    """Bind to the containing persistent mount, including a normal root filesystem."""
    result = json.loads(
        run(
            "/usr/bin/findmnt",
            "--json",
            "--target",
            str(path),
            "--output",
            "TARGET,UUID,FSTYPE,FSROOT",
        )
    )
    mounts = result.get("filesystems", [])
    if len(mounts) != 1:
        raise RuntimeError("Cannot identify the data mount")
    mount = mounts[0]
    if not mount.get("uuid") or mount.get("fstype") not in ("ext4", "xfs", "btrfs"):
        raise RuntimeError(
            "Data requires a mounted persistent ext4, xfs or btrfs filesystem with a UUID"
        )
    return {key: mount[key] for key in ("target", "uuid", "fstype", "fsroot")}


def account(name):
    user = pwd.getpwnam(name)
    group = grp.getgrnam(name)
    if (
        user.pw_uid == 0
        or user.pw_gid != group.gr_gid
        or user.pw_shell not in ("/usr/sbin/nologin", "/bin/false")
    ):
        raise RuntimeError(
            "Existing account is not a dedicated service identity: " + name
        )
    if len([u for u in pwd.getpwall() if u.pw_uid == user.pw_uid]) != 1:
        raise RuntimeError("Duplicate UID: " + name)
    if any(g.gr_name != name and g.gr_gid == group.gr_gid for g in grp.getgrall()):
        raise RuntimeError("Duplicate service GID: " + name)
    if any(
        u.pw_name != name and u.pw_gid == group.gr_gid for u in pwd.getpwall()
    ) or set(group.gr_mem) - {name}:
        raise RuntimeError("Service group is shared: " + name)
    if set(os.getgrouplist(name, user.pw_gid)) != {user.pw_gid}:
        raise RuntimeError("Unexpected supplementary groups: " + name)
    return user


def private_directory(path, uid, create=False, gid=None):
    path = Path(path)
    if not path.exists() and not path.is_symlink() and create:
        path.mkdir(mode=0o700)
        os.chown(path, uid, gid)
    info = path.lstat()
    if (
        path.is_symlink()
        or not path.is_dir()
        or info.st_uid != uid
        or info.st_mode & 0o077
    ):
        raise RuntimeError("Unsafe existing data directory: " + str(path))


def skills_directory(path, create=False):
    """Preserve administrator-managed contents; never repair existing ownership."""
    path = Path(path)
    if not os.path.lexists(path):
        if not create:
            # Older installations may not have any Skills yet.
            return
        path.mkdir(mode=0o755)
        os.chown(path, 0, 0)
    trusted(path)
    info = path.lstat()
    if not path.is_dir() or info.st_mode & 0o7000 or info.st_mode & 0o005 != 0o005:
        raise RuntimeError("Skills root must be a readable root-owned directory")


def load_record():
    if not RECORD.exists():
        raise RuntimeError(
            "No installation metadata; review existing users, storage and configuration before installation"
        )
    trusted(RECORD)
    if not RECORD.is_file() or RECORD.stat().st_size > 16384:
        raise RuntimeError("Invalid installation metadata")
    value = json.loads(RECORD.read_text())
    if value.get("schemaVersion") != 1:
        raise RuntimeError("Unsupported installation metadata")
    data_path(value["dataRoot"])
    return value


def check(value):
    root = data_path(value["dataRoot"])
    trusted(root)
    if storage(root) != value["storage"]:
        raise RuntimeError(
            "Approved data mount is missing or has changed; refusing fallback storage"
        )
    control, work = account("agent-control"), account("agent-work")
    if (
        control.pw_uid != value["controlUid"]
        or work.pw_uid != value["workUid"]
        or control.pw_uid == work.pw_uid
    ):
        raise RuntimeError("Installed service identities have changed")
    if control.pw_gid != value["controlGid"] or work.pw_gid != value["workGid"]:
        raise RuntimeError("Installed service groups have changed")
    if os.geteuid() not in (0, control.pw_uid):
        raise RuntimeError("Storage checks require the control identity")
    for name in ["control", "control/secrets"]:
        private_directory(root / name, control.pw_uid)
    skills_directory(root / "skills")
    private_directory(root / "work", work.pw_uid)
    if os.geteuid() == 0:
        for name in ["work/conversations", "work/home", "work/tmp"]:
            private_directory(root / name, work.pw_uid)
    return value


def dns_rules(text):
    rules = []
    for line in text.splitlines():
        fields = line.split("#", 1)[0].split()
        if not fields or fields[0] != "nameserver":
            continue
        if len(fields) != 2:
            raise RuntimeError("Invalid system resolver entry")
        value, _, scope = fields[1].partition("%")
        address = ipaddress.ip_address(value)
        if (
            address.is_unspecified
            or address.is_multicast
            or (
                scope
                and (
                    address.version != 6 or not re.fullmatch(r"[a-zA-Z0-9_.-]+", scope)
                )
            )
        ):
            raise RuntimeError("Unsupported system resolver address")
        prefix = f'oifname "{scope}" ' if scope else ""
        family = "ip" if address.version == 4 else "ip6"
        rules.append(
            f"{prefix}{family} daddr {address} meta l4proto {{ tcp, udp }} th dport 53 accept"
        )
    if not rules:
        raise RuntimeError("No system DNS servers; refusing unrestricted egress")
    return "\n    ".join(dict.fromkeys(rules))


def atomic_write(path, content, mode=0o644):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def egress(value):
    if os.geteuid() != 0:
        raise RuntimeError("Egress policy requires root")
    READY.unlink(missing_ok=True)
    template = Path("/etc/agent/egress.nft")
    trusted(template)
    trusted("/etc/agent/protected-cidrs.nft")
    policy = (
        template.read_text()
        .replace("@WORK_UID@", str(value["workUid"]))
        .replace("@DNS_RULES@", dns_rules(Path("/etc/resolv.conf").read_text()))
    )
    # Replace only our table in one nft transaction. Other applications' rules stay intact.
    exists = (
        subprocess.run(
            ["/usr/sbin/nft", "list", "table", "inet", "agent_work"],
            capture_output=True,
            timeout=30,
            check=False,
        ).returncode
        == 0
    )
    if exists:
        policy = "delete table inet agent_work\n" + policy
    fd, temporary = tempfile.mkstemp(prefix="agent-egress-", dir="/run")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(policy)
        run("/usr/sbin/nft", "--check", "--file", temporary)
        run("/usr/sbin/nft", "--file", temporary)
        run("/usr/sbin/nft", "list", "table", "inet", "agent_work")
        atomic_write(READY, f"agent-work-egress-v2:{value['workUid']}\n")
    finally:
        os.unlink(temporary)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("check", "preflight"):
            raise RuntimeError("Usage: system.py check|preflight")
        value = check(load_record())
        if sys.argv[1] == "preflight":
            egress(value)
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        sys.exit(str(error))
