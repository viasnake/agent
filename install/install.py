#!/opt/agent-python/bin/python3
"""Install an application into prepared Ubuntu; never provision the operating system."""

import argparse
import grp
import ipaddress
import json
import os
import pwd
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from system import (
    account,
    atomic_write,
    check,
    data_path,
    dns_rules,
    load_record,
    private_directory,
    run,
    storage,
    skills_directory,
    trusted,
)

APP = Path("/opt/agent")
NODE = Path("/opt/agent-node")
PYTHON = Path("/opt/agent-python")
ETC = Path("/etc/agent")
RECORD = ETC / "installation.json"
UNITS = Path("/etc/systemd/system")
LIBEXEC = Path("/usr/local/libexec")
SUDOERS = Path("/etc/sudoers.d/agent-work")


def copy_tree(source, destination):
    # Copy only regular files/directories and links contained in the reviewed input.
    if source.is_symlink():
        raise RuntimeError("Installation input directory cannot be a symlink")
    for current, dirs, files in os.walk(source, followlinks=False):
        for name in dirs + files:
            path = Path(current) / name
            if path.is_symlink():
                if Path(os.readlink(path)).is_absolute() or not path.resolve(
                    strict=True
                ).is_relative_to(source):
                    raise RuntimeError("External installation symlink: " + str(path))
            elif not path.is_file() and not path.is_dir():
                raise RuntimeError("Nonregular installation input: " + str(path))
    shutil.copytree(source, destination, symlinks=True)
    for current, dirs, files in os.walk(destination, followlinks=False):
        os.chmod(current, 0o755)
        for name in files:
            path = Path(current) / name
            if not path.is_symlink():
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)


def ensure_account(name, home):
    try:
        pwd.getpwnam(name)
    except KeyError:
        try:
            group = grp.getgrnam(name)
            if group.gr_mem or any(u.pw_gid == group.gr_gid for u in pwd.getpwall()):
                raise RuntimeError("Existing group is in use: " + name)
        except KeyError:
            run("/usr/sbin/groupadd", "--system", name)
        run(
            "/usr/sbin/useradd",
            "--system",
            "--gid",
            name,
            "--no-create-home",
            "--home-dir",
            home,
            "--shell",
            "/usr/sbin/nologin",
            name,
        )
    user = account(name)
    if user.pw_dir != home:
        raise RuntimeError("Existing account has an unexpected home: " + name)
    if run("/usr/bin/passwd", "--status", name).split()[1] != "L":
        raise RuntimeError("Service account must have a locked password: " + name)
    return user


def origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError("Use an exact loopback browser origin")
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    default_port = 443 if parsed.scheme == "https" else 80
    port = f":{parsed.port}" if parsed.port not in (None, default_port) else ""
    if value != f"{parsed.scheme}://{host}{port}" or parsed.port == 0:
        raise argparse.ArgumentTypeError(
            "Use a canonical browser origin without a default port"
        )
    return value


def address(value):
    parsed = ipaddress.ip_address(value)
    if "%" in value or getattr(parsed, "ipv4_mapped", None):
        raise argparse.ArgumentTypeError("Use a plain IPv4 or IPv6 address")
    return str(parsed)


def inactive():
    result = subprocess.run(
        ["/usr/bin/systemctl", "is-active", "agent.service"],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if result.stdout.strip() not in ("inactive", "failed", "unknown"):
        raise RuntimeError("Stop agent.service before installation or update")


def require_host():
    if os.geteuid() != 0:
        raise RuntimeError("Run the installer as root")
    os.umask(0o022)
    if not Path("/run/systemd/system").is_dir():
        raise RuntimeError("A running systemd host is required")
    os_release = Path("/etc/os-release").read_text()
    if "ID=ubuntu\n" not in os_release or 'VERSION_ID="26.04"' not in os_release:
        raise RuntimeError("Ubuntu Server 26.04 is required")
    for binary in [
        "findmnt",
        "nft",
        "sudo",
        "visudo",
        "setpriv",
        "flock",
        "getent",
        "systemctl",
        "pgrep",
    ]:
        if not shutil.which(binary):
            raise RuntimeError("Install required OS dependency: " + binary)


def install(args):
    require_host()
    inactive()
    if len(args.trusted_peer or []) > 16:
        raise RuntimeError("At most 16 forwarding peers are supported")
    source, node, python = (
        Path(args.source).resolve(strict=True),
        Path(args.node).resolve(strict=True),
        Path(args.python).resolve(strict=True),
    )
    if (
        not (node / "bin/node").is_file()
        or run(str(node / "bin/node"), "--version") != "v26.13.0"
    ):
        raise RuntimeError("Provide the extracted Node.js 26.13.0 directory")
    if (
        not (python / "bin/python3").is_file()
        or run(
            str(python / "bin/python3"),
            "-I",
            "-B",
            "-c",
            "import ssl, sqlite3, venv, ensurepip, sys; print(sys.version.split()[0])",
        )
        != "3.14.10"
    ):
        raise RuntimeError("Provide the extracted standalone Python 3.14.10 directory")
    for name in [
        "dist/src/main.js",
        "dist/web/app.js",
        "node_modules",
        "install/system.py",
        "package.json",
    ]:
        if not (source / name).exists():
            raise RuntimeError(
                "Build the application and install dependencies first: " + name
            )
    dns_rules(Path("/etc/resolv.conf").read_text())
    record = None
    if args.update:
        record = check(load_record())
        if args.data_dir or args.listen or args.origin or args.trusted_peer:
            raise RuntimeError(
                "Update preserves installation settings; edit config.yaml separately"
            )
        for path in [
            APP,
            NODE,
            ETC,
            SUDOERS,
            LIBEXEC / "agent-work",
            LIBEXEC / "agent-preflight",
        ]:
            trusted(path)
        if os.path.lexists(PYTHON):
            trusted(PYTHON)
    else:
        for path in [
            APP,
            NODE,
            PYTHON,
            ETC,
            SUDOERS,
            LIBEXEC / "agent-work",
            LIBEXEC / "agent-preflight",
            UNITS / "agent.service",
            UNITS / "agent-egress.service",
        ]:
            if os.path.lexists(path):
                raise RuntimeError(
                    "Existing installation requires review or --update; not overwriting: "
                    + str(path)
                )
    for destination in [
        APP,
        NODE,
        PYTHON,
        ETC,
        SUDOERS,
        LIBEXEC / "agent-work",
        UNITS / "agent.service",
    ]:
        parent = destination.parent
        while not parent.exists():
            parent = parent.parent
        trusted(parent)
    root = data_path(
        record["dataRoot"] if record else (args.data_dir or "/srv/agent-data")
    )
    if any(root.is_relative_to(path) for path in [APP, NODE, PYTHON, ETC]):
        raise RuntimeError(
            "Data must be outside application, runtime and configuration directories"
        )
    ancestor = root
    while not ancestor.exists():
        ancestor = ancestor.parent
    trusted(ancestor)
    approved_storage = storage(ancestor)
    if record and approved_storage != record["storage"]:
        raise RuntimeError("Approved storage changed")
    # Existing data requires already-established owners; never adopt it by recursive chown.
    for user, names in {
        "agent-control": ["control", "control/secrets"],
        "agent-work": ["work", "work/home", "work/tmp", "work/conversations"],
    }.items():
        for name in names:
            path = root / name
            if os.path.lexists(path):
                private_directory(path, account(user).pw_uid)
    control = ensure_account("agent-control", "/nonexistent")
    work = ensure_account("agent-work", str(root / "work/home"))
    if control.pw_uid == work.pw_uid or control.pw_gid == work.pw_gid:
        raise RuntimeError("Control and work must have distinct identities")
    for identity in [control, work]:
        if (
            subprocess.run(
                ["/usr/bin/pgrep", "-u", str(identity.pw_uid)],
                capture_output=True,
                check=False,
                timeout=30,
            ).returncode
            != 1
        ):
            raise RuntimeError(
                "Stop all service-user processes before installation or update: "
                + identity.pw_name
            )
    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    trusted(root)
    if storage(root) != approved_storage:
        raise RuntimeError("Storage changed while preparing the data directory")
    for user, names in [
        (control, ["control", "control/secrets"]),
        (work, ["work", "work/home", "work/tmp", "work/conversations"]),
    ]:
        for name in names:
            private_directory(root / name, user.pw_uid, create=True, gid=user.pw_gid)
    skills_directory(root / "skills", control.pw_uid, create=True, gid=control.pw_gid)
    value = record or {
        "schemaVersion": 1,
        "dataRoot": str(root),
        "controlUid": control.pw_uid,
        "controlGid": control.pw_gid,
        "workUid": work.pw_uid,
        "workGid": work.pw_gid,
        "storage": approved_storage,
    }
    check(value)
    token = uuid.uuid4().hex
    staged_app = APP.with_name(APP.name + ".next-" + token)
    staged_node = NODE.with_name(NODE.name + ".next-" + token)
    staged_python = PYTHON.with_name(PYTHON.name + ".next-" + token)
    staged_app.mkdir(mode=0o755)
    for name in ["dist", "node_modules", "install", "examples", "scripts"]:
        copy_tree(source / name, staged_app / name)
    for name in ["package.json", "package-lock.json", "README.md"]:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Invalid application input: " + name)
        shutil.copyfile(path, staged_app / name)
    copy_tree(node, staged_node)
    copy_tree(python, staged_python)
    sudoers = (staged_app / "install/agent.sudoers").read_text()
    run("/usr/sbin/visudo", "-cf", str(staged_app / "install/agent.sudoers"))
    # Keep recoverable installation copies. Config, credentials and data are never replaced.
    for target, staged in [
        (APP, staged_app),
        (NODE, staged_node),
        (PYTHON, staged_python),
    ]:
        if target.exists():
            target.rename(str(target) + ".previous-" + token)
        staged.rename(target)
    ETC.mkdir(mode=0o755, exist_ok=True)
    if not record:
        atomic_write(RECORD, json.dumps(value, indent=2) + "\n")
        config = {
            "schemaVersion": 2,
            "dataRoot": str(root),
            "server": {
                "host": args.listen or "127.0.0.1",
                "port": 8080,
                "origins": args.origin
                or ["http://127.0.0.1:8080", "http://localhost:8080"],
                "trustedPeers": args.trusted_peer or [],
            },
            "model": None,
            "mcp": [],
            "instructions": "",
            "limits": {},
        }
        atomic_write(ETC / "config.yaml", json.dumps(config, indent=2) + "\n", 0o640)
        os.chown(ETC / "config.yaml", 0, control.pw_gid)
    LIBEXEC.mkdir(parents=True, exist_ok=True)
    for name in ["agent-work", "agent-preflight"]:
        atomic_write(
            LIBEXEC / name,
            (APP / "install" / name).read_text().replace("@DATA_ROOT@", str(root)),
            0o755,
        )
    atomic_write(SUDOERS, sudoers, 0o440)
    for name in ["egress.nft", "protected-cidrs.nft"]:
        if not (ETC / name).exists():
            atomic_write(ETC / name, (APP / "install" / name).read_text())
    for name in ["agent.service", "agent-egress.service"]:
        atomic_write(
            UNITS / name,
            (APP / "install" / name).read_text().replace("@DATA_ROOT@", str(root)),
        )
    run("/usr/bin/systemctl", "daemon-reload")
    # Validate the actual kernel policy before claiming a usable installation.
    from system import egress

    egress(value)
    print("Installed. Start with: sudo systemctl enable --now agent.service")
    print("Data: " + str(root) + "; approved mount: " + approved_storage["target"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Install Agent into prepared Ubuntu; does not create storage or manage machines."
    )
    parser.add_argument("source", help="built application directory")
    parser.add_argument("node", help="extracted Node.js 26.13.0 directory")
    parser.add_argument("python", help="extracted standalone Python 3.14.10 directory")
    parser.add_argument(
        "--data-dir",
        help="directory on mounted persistent storage (default: /srv/agent-data)",
    )
    parser.add_argument("--listen", type=address, help="listen IP (default: 127.0.0.1)")
    parser.add_argument(
        "--origin",
        type=origin,
        action="append",
        help="exact browser origin; repeat for multiple origins",
    )
    parser.add_argument(
        "--trusted-peer",
        type=address,
        action="append",
        help="explicitly trusted forwarding peer IP; repeat as needed",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="preserve configuration and data; requires a stopped existing installation",
    )
    try:
        install(parser.parse_args())
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        sys.exit(str(error))
