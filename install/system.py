#!/opt/agent-python/bin/python3
"""Shared installation and startup checks; never creates or mounts storage."""

import fcntl
import hashlib
import grp
import ipaddress
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

RECORD = Path("/etc/agent/installation.json")
READY = Path("/run/agent-egress.ready")
EGRESS_LOCK = Path("/run/agent-egress.lock")
EGRESS_TEMPLATE = Path("/etc/agent/egress.nft")
PROTECTED = Path("/etc/agent/protected-cidrs.nft")
DESTINATIONS = Path("/etc/agent/egress.d/destinations.json")
DESTINATION_MARKER = "@DESTINATION_ELEMENTS@"
NFT = "/usr/sbin/nft"
SPECIAL_DESTINATIONS = tuple(map(ipaddress.IPv4Network, (
    "0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "192.0.0.0/24",
    "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/3", "100.100.100.200/32",
)))


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


def skills_directory(path, uid, create=False, gid=None):
    """Keep work read-only; migrate a validated legacy tree only during installation."""
    path = Path(path)
    trusted(path.parent)
    if not os.path.lexists(path):
        if not create:
            return
        path.mkdir(mode=0o755)
        path.chmod(0o755)
        os.chown(path, uid, gid)
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid not in (0, uid)
        or info.st_mode & 0o7022
        or info.st_mode & 0o005 != 0o005
    ):
        raise RuntimeError(
            "Skills root must be readable and writable only by control or root"
        )
    if info.st_uid != 0 or not create or uid == 0:
        return
    # The installer has stopped both service identities. Validate the entire
    # legacy tree before changing any owner; never repair unsafe shared content.
    paths = []

    def visit(current, depth):
        if depth > 10 or len(paths) >= 33000:
            raise RuntimeError("Legacy Skills tree exceeds migration limits")
        entry = current.lstat()
        directory = stat.S_ISDIR(entry.st_mode)
        if (
            entry.st_uid not in (0, uid)
            or entry.st_mode & 0o7022
            or (directory and entry.st_mode & 0o005 != 0o005)
            or (
                not directory
                and (
                    not stat.S_ISREG(entry.st_mode)
                    or entry.st_nlink != 1
                    or not entry.st_mode & 0o004
                )
            )
        ):
            raise RuntimeError("Unsafe legacy Skills entry: " + str(current))
        paths.append(current)
        if directory:
            for child in current.iterdir():
                visit(child, depth + 1)

    visit(path, 0)
    # Reown the root last so a failed migration remains detectable and retryable.
    for entry in reversed(paths):
        os.chown(entry, uid, gid, follow_symlinks=False)


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
    skills_directory(root / "skills", control.pw_uid)
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



@contextmanager
def egress_lock():
    fd = os.open(EGRESS_LOCK, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def destination_entries(entries):
    if not isinstance(entries, list) or len(entries) > 64:
        raise ValueError("Invalid destination list")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"name", "ip", "port"}:
            raise ValueError("Invalid destination fields")
        name, ip, port = (entry[key] for key in ("name", "ip", "port"))
        if (not isinstance(name, str) or len(name) > 80 or (name and not name.isprintable())
                or not isinstance(ip, str) or len(ip) > 15 or type(port) is not int
                or not 1 <= port <= 65535):
            raise ValueError("Invalid destination entry")
        address = ipaddress.IPv4Address(ip)
        if any(address in network for network in SPECIAL_DESTINATIONS):
            raise ValueError("Special address")
        if (ip, port) in seen:
            raise ValueError("Duplicate destination")
        seen.add((ip, port))
    return entries


def protected_networks():
    trusted(PROTECTED)
    source = re.sub(r"#.*", "", PROTECTED.read_text())
    match = re.fullmatch(r"\s*define\s+protected_cidrs\s*=\s*\{([^}]+)\}\s*", source)
    if match is None:
        raise RuntimeError("Invalid protected address policy")
    return [ipaddress.IPv4Network(item.strip(), strict=False) for item in match[1].split(",")]


def read_destinations():
    trusted(DESTINATIONS.parent)
    if not os.path.lexists(DESTINATIONS):
        return []
    trusted(DESTINATIONS)
    with DESTINATIONS.open("rb") as stream:
        return destination_entries(json.loads(stream.read(65537)))


def destination_json(entries):
    return json.dumps(entries, sort_keys=True, ensure_ascii=True)


def endpoint_pairs(entries):
    return {(entry["ip"], entry["port"]) for entry in entries}


def nft_elements(pairs):
    # The only interpolations are validated IPv4 literals and bounded integers.
    return ", ".join(f"{ip} . {port}" for ip, port in sorted(pairs))


def active_endpoints():
    listing = json.loads(run(NFT, "--json", "--numeric", "list", "set", "inet", "agent_work", "allowed_tcp_v4"))
    (definition,) = (item["set"] for item in listing["nftables"] if "set" in item)
    return {tuple(item["concat"]) for item in definition.get("elem", [])}


def replace_endpoints(pairs):
    script = "flush set inet agent_work allowed_tcp_v4\n"
    if pairs:
        script += "add element inet agent_work allowed_tcp_v4 { " + nft_elements(pairs) + " }\n"
    result = subprocess.run([NFT, "--file", "-"], input=script, text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError("Cannot update destination set")


def persist_destinations(entries):
    atomic_write(DESTINATIONS, destination_json(entries) + "\n", 0o600)
    fd = os.open(DESTINATIONS.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_destinations(before, after, old):
    new = endpoint_pairs(after)
    keep = old & new
    if old != keep:
        replace_endpoints(keep)
    # On interruption, the live set must never be broader than the durable policy.
    try:
        persist_destinations(after)
        if new != keep:
            replace_endpoints(new)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        if new != keep:
            replace_endpoints(keep)
        persist_destinations(before)
        if old != keep:
            replace_endpoints(old)
        raise


def destination_request(request):
    with egress_lock():
        trusted(EGRESS_TEMPLATE)
        if DESTINATION_MARKER not in EGRESS_TEMPLATE.read_text():
            return {"status": "unavailable"}
        entries = read_destinations()
        pairs = endpoint_pairs(entries)
        active = active_endpoints()
        revision = hashlib.sha256(destination_json(entries).encode()).hexdigest()
        if request != {"operation": "read"}:
            try:
                if not isinstance(request, dict) or set(request) != {"operation", "revision", "entries"} or request["operation"] != "write":
                    raise ValueError("Invalid operation")
                updated = destination_entries(request["entries"])
                protected = protected_networks()
                if any(ipaddress.IPv4Address(ip) in network for ip, _ in endpoint_pairs(updated) - pairs for network in protected):
                    raise ValueError("Protected address")
            except ValueError:
                return {"status": "invalid"}
            if request["revision"] != revision:
                return {"status": "conflict"}
            if not active <= pairs:
                return {"status": "unavailable"}
            if updated != entries or active != pairs:
                save_destinations(entries, updated, active)
            entries = updated
            revision = hashlib.sha256(destination_json(entries).encode()).hexdigest()
            active = active_endpoints()
        return {"status": "ok", "revision": revision, "entries": entries,
                "applied": active == endpoint_pairs(entries)}


def egress(value):
    if os.geteuid() != 0:
        raise RuntimeError("Egress policy requires root")
    with egress_lock():
        apply_egress(value)


def apply_egress(value):
    READY.unlink(missing_ok=True)
    trusted(EGRESS_TEMPLATE)
    trusted(PROTECTED)
    policy = (
        EGRESS_TEMPLATE.read_text()
        .replace("@WORK_UID@", str(value["workUid"]))
        .replace("@DNS_RULES@", dns_rules(Path("/etc/resolv.conf").read_text()))
    )
    if DESTINATION_MARKER in policy:
        elements = nft_elements(endpoint_pairs(read_destinations()))
        policy = policy.replace(DESTINATION_MARKER, f"elements = {{ {elements} }}" if elements else "")
    # Replace only our table in one nft transaction. Other applications' rules stay intact.
    exists = (
        subprocess.run(
            [NFT, "list", "table", "inet", "agent_work"],
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
        run(NFT, "--check", "--file", temporary)
        run(NFT, "--file", temporary)
        run(NFT, "list", "table", "inet", "agent_work")
        atomic_write(READY, f"agent-work-egress-v2:{value['workUid']}\n")
    finally:
        os.unlink(temporary)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["destinations"]:
            if os.geteuid() != 0:
                raise RuntimeError("Egress policy requires root")
            request = sys.stdin.buffer.read(65537)
            if len(request) > 65536:
                raise ValueError("Destination request too large")
            print(json.dumps(destination_request(json.loads(request)), ensure_ascii=True))
        else:
            if len(sys.argv) != 2 or sys.argv[1] not in ("check", "preflight"):
                raise RuntimeError("Usage: system.py check|preflight|destinations")
            value = check(load_record())
            if sys.argv[1] == "preflight":
                egress(value)
    except (RuntimeError, OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
