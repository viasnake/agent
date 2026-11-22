#!/opt/agent-python/bin/python3
"""Install an application into prepared Ubuntu; never provision the operating system."""

import argparse
import fcntl
import grp
import ipaddress
import json
import os
import pwd
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
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
DEPLOY_SOCKET = Path("/run/agent/deploy.sock")
INSTALL_LOCK = Path("/run/agent-install.lock")
SYSTEMCTL = "/usr/bin/systemctl"


def install_network_policy(source):
    template = (source / "egress.nft").read_text()
    destination = ETC / "egress.nft"
    if os.path.lexists(destination):
        trusted(destination)
        previous = template.replace(
            "tcp dport { 22, 80, 443 }", "tcp dport { 80, 443 }"
        )
        # Upgrade only the shipped policy; administrator rules remain authoritative.
        if destination.read_text() == previous:
            atomic_write(destination, template)
    else:
        atomic_write(destination, template)
    protected = ETC / "protected-cidrs.nft"
    if not os.path.lexists(protected):
        atomic_write(protected, (source / "protected-cidrs.nft").read_text())


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


def copy_app(source, destination):
    for name in ["dist", "node_modules", "install", "examples", "scripts"]:
        copy_tree(source / name, destination / name)
    for name in ["package.json", "package-lock.json", "README.md"]:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Invalid application input: " + name)
        shutil.copyfile(path, destination / name)


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


@contextmanager
def installation_lock():
    trusted(INSTALL_LOCK.parent)
    fd = os.open(
        INSTALL_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
    )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise RuntimeError("Unsafe installation lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another installation or update is running") from error
        yield
    finally:
        os.close(fd)


def check_hot_compatibility(current, staged):
    # A hot update never replaces deployment code run as root, runtimes or policy.
    left, right = current / "install", staged / "install"
    files = {path.relative_to(left) for path in left.rglob("*")}
    if files != {path.relative_to(right) for path in right.rglob("*")}:
        raise RuntimeError("Installation files changed; use a stopped update")
    for name in files:
        old, new = left / name, right / name
        trusted(old)
        if new.is_symlink() or not (
            old.is_dir() and new.is_dir()
            or old.is_file() and new.is_file() and old.read_bytes() == new.read_bytes()
        ):
            raise RuntimeError("Installation files changed; use a stopped update")
    key = "agentHotDeployEpoch"
    epoch = json.loads((current / "package.json").read_text()).get(key)
    candidate_epoch = json.loads((staged / "package.json").read_text()).get(key)
    if type(epoch) is not int or type(candidate_epoch) is not int or epoch != candidate_epoch:
        raise RuntimeError(
            "Storage or configuration compatibility changed; use a stopped update"
        )

    def locked_sdk(app):
        packages = json.loads((app / "package-lock.json").read_text())["packages"]
        return packages["node_modules/@earendil-works/pi-durable"]

    if locked_sdk(current) != locked_sdk(staged):
        raise RuntimeError("Pi Durable changed; use a stopped update")
    for name in ["dist/src/main.js", "dist/src/deploy.js", "dist/web/app.js"]:
        path = staged / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("Build the application first: " + name)


@contextmanager
def deployment_connection(uid, timeout):
    trusted(DEPLOY_SOCKET.parent.parent)
    private_directory(DEPLOY_SOCKET.parent, uid)
    info = DEPLOY_SOCKET.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise RuntimeError("Unsafe deployment socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(DEPLOY_SOCKET))
        peer = connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
        )
        if struct.unpack("3i", peer)[1] != uid:
            raise RuntimeError("Unexpected deployment peer")
        with connection.makefile("rb") as reader:
            yield connection, reader


def unit_status():
    output = run(SYSTEMCTL, "show", "agent.service", "-p", "ActiveState", "-p", "Result")
    return dict(line.split("=", 1) for line in output.splitlines())


def wait_for_clean_stop():
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        status = unit_status()
        if status["ActiveState"] == "inactive" and status["Result"] == "success":
            return
        if status["Result"] != "success" or status["ActiveState"] == "failed":
            break
        time.sleep(0.2)
    raise RuntimeError("Agent did not stop cleanly; application not switched")


def wait_for_ready(uid):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with deployment_connection(uid, 1) as (connection, reader):
                connection.sendall(b"ping 1\n")
                if reader.readline(32) == b"ready 1\n":
                    return
        except (FileNotFoundError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.2)
    raise RuntimeError("Agent did not report readiness")


def hot_update(source):
    trusted(APP)
    trusted(NODE)
    trusted(PYTHON)
    record = check(load_record())
    uid = record["controlUid"]
    if unit_status()["ActiveState"] != "active":
        raise RuntimeError("Hot update requires a running agent.service")
    source = Path(source).resolve(strict=True)
    staged = Path(tempfile.mkdtemp(prefix=APP.name + ".previous-", dir=APP.parent))
    keep_stage = False
    try:
        copy_app(source, staged)
        check_hot_compatibility(APP, staged)
        staged.chmod(0o755)
        print("Waiting up to 60 seconds for Agent work and terminals to finish", flush=True)
        with deployment_connection(uid, 70) as (connection, reader):
            connection.sendall(b"drain 1\n")
            if reader.readline(32) != b"drained\n":
                raise RuntimeError("Agent was not drained; application not switched")
            connection.sendall(b"stop\n")
            if reader.readline(32) != b"stopping\n":
                raise RuntimeError("Agent did not confirm shutdown; check service status")
        wait_for_clean_stop()
        # Once the atomic exchange is attempted, this path may contain the old
        # application. Preserve it even if the installer dies mid-command.
        keep_stage = True
        previous = APP.stat()
        try:
            run("/usr/bin/mv", "--exchange", "--no-copy", "-T", str(staged), str(APP))
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            if os.path.samestat(previous, APP.stat()):
                run(SYSTEMCTL, "start", "agent.service")
                keep_stage = False
                raise RuntimeError(
                    "Application exchange failed; previous Agent restart requested"
                ) from error
            raise RuntimeError(
                f"Application exchange not confirmed; inspect {APP} and {staged}"
            ) from error
        print(f"Previous application: {staged}", flush=True)
        try:
            run(SYSTEMCTL, "start", "agent.service")
            wait_for_ready(uid)
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            # Once a new service may have admitted work, do not stop it blindly.
            raise RuntimeError(
                f"New Agent startup not confirmed; inspect agent.service. Previous application: {staged}"
            ) from error
    finally:
        if not keep_stage:
            shutil.rmtree(staged)


def install(args):
    require_host()
    inactive()
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
        if args.data_dir or args.listen or args.origin:
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
    copy_app(source, staged_app)
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
                "host": args.listen or "0.0.0.0",
                "port": 8080,
                "origins": args.origin
                or ["http://127.0.0.1:8080", "http://localhost:8080"],
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
    install_network_policy(APP / "install")
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
    parser.add_argument("node", nargs="?", help="extracted Node.js 26.13.0 directory")
    parser.add_argument("python", nargs="?", help="extracted standalone Python 3.14.10 directory")
    parser.add_argument(
        "--data-dir",
        help="directory on mounted persistent storage (default: /srv/agent-data)",
    )
    parser.add_argument("--listen", type=address, help="listen IP (default: 0.0.0.0)")
    parser.add_argument(
        "--origin",
        type=origin,
        action="append",
        help="exact browser origin; repeat for multiple origins",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="preserve configuration and data; requires a stopped existing installation",
    )
    parser.add_argument("--hot-update", action="store_true", help="update the running application only")
    args = parser.parse_args()
    if args.hot_update:
        if any([args.update, args.node, args.python, args.data_dir, args.listen, args.origin]):
            parser.error("--hot-update takes only the built application directory")
    elif not args.node or not args.python:
        parser.error("Provide the extracted Node.js and Python directories")
    try:
        require_host()
        with installation_lock():
            if args.hot_update:
                hot_update(args.source)
            else:
                install(args)
    except (RuntimeError, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(str(error))
