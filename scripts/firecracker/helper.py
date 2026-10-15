#!/usr/bin/python3 -I
"""Root-only lifecycle helper for the fixed Firecracker installation."""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import pwd
import re
import select
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

CONFIG_PATH = Path("/etc/local-agent/firecracker.json")
FIXED_STATE_DIR = Path("/var/lib/local-agent-firecracker/state")
FIXED_JAILER_DIR = Path("/var/lib/local-agent-firecracker/jailer")
FIXED_CGROUP_PARENT = "local-agent-firecracker"
FIXED_VMM_UIDS = [2000, 2001, 2002, 2003]
MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_FRAME_BYTES = 8 * 1024 * 1024
PROTOCOL_VERSION = 1
ENVIRONMENT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    __import__("re").IGNORECASE,
)
OPS = {"diagnose", "create", "start", "status", "execute", "stop", "destroy"}
ALLOWED_REQUEST_KEYS = {
    "diagnose": {"op"},
    "create": {"op"},
    "start": {"op", "id"},
    "status": {"op", "id"},
    "execute": {"op", "id", "command"},
    "stop": {"op", "id"},
    "destroy": {"op", "id"},
}
ACTIVE: list[tuple[dict[str, Any], str]] = []
CLEANED: set[str] = set()
WATCHDOG_SECONDS = 15 * 60
LOCK_WAIT_SECONDS = 120


class HelperError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message[:4096])
        self.code = code[:128]


def _record(value: Any) -> bool:
    return isinstance(value, dict)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _bounded_text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise HelperError("INVALID_REQUEST", f"{name} must be a non-empty string")
    if len(value.encode()) > maximum:
        raise HelperError("INVALID_REQUEST", f"{name} is too large")
    return value


def validate_id(value: Any) -> str:
    value = _bounded_text(value, "id", 64)
    if ENVIRONMENT_ID.fullmatch(value) is None:
        raise HelperError("INVALID_ID", "Environment ID is not a UUID")
    return value


def validate_request(request: Any) -> dict[str, Any]:
    if not _record(request) or "op" not in request:
        raise HelperError("INVALID_REQUEST", "Request must be an object with an operation")
    op = request.get("op")
    if not isinstance(op, str) or op not in OPS or set(request) - ALLOWED_REQUEST_KEYS[op]:
        raise HelperError("INVALID_REQUEST", "Unknown or incomplete request fields")
    if op in {"start", "status", "stop", "destroy", "execute"}:
        request["id"] = validate_id(request.get("id"))
    if op == "execute":
        command = request.get("command")
        if not _record(command) or set(command) != {"argv", "timeoutMs", "maxOutputBytes"}:
            raise HelperError("INVALID_COMMAND", "Command shape is invalid")
        argv = command["argv"]
        if not isinstance(argv, list) or not 0 < len(argv) <= 128:
            raise HelperError("INVALID_COMMAND", "argv length is outside the limit")
        if not isinstance(argv[0], str) or not argv[0] or "\x00" in argv[0]:
            raise HelperError("INVALID_COMMAND", "argv[0] must name a command")
        for arg in argv:
            if not isinstance(arg, str) or "\x00" in arg or len(arg.encode()) > 16 * 1024:
                raise HelperError("INVALID_COMMAND", "argv entries must be bounded strings")
        timeout = command["timeoutMs"]
        output = command["maxOutputBytes"]
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, int)
            or not 1 <= timeout <= 600_000
            or isinstance(output, bool)
            or not isinstance(output, int)
            or not 1 <= output <= 1_048_576
        ):
            raise HelperError("INVALID_COMMAND", "Command limits exceed administrator bounds")
    return request


def _safe_path(path: Path, *, expect_file: bool = False) -> None:
    current = Path(path.anchor or "/")
    for part in path.parts[1:]:
        current /= part
        try:
            stat = current.lstat()
        except FileNotFoundError as exc:
            raise HelperError("INSTALLATION", f"Missing installation path: {current}") from exc
        if stat.st_uid != 0 or stat.st_mode & 0o022:
            raise HelperError("INSTALLATION", f"Unsafe ownership or mode: {current}")
        if current.is_symlink():
            raise HelperError("INSTALLATION", f"Symlink in installation path: {current}")
    if expect_file and not path.is_file():
        raise HelperError("INSTALLATION", f"Not a regular file: {path}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_config(*, verify_installation: bool = True) -> dict[str, Any]:
    _safe_path(CONFIG_PATH, expect_file=True)
    if CONFIG_PATH.stat().st_mode & 0o077:
        raise HelperError("INSTALLATION", "Configuration must not be accessible to other users")
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HelperError("INSTALLATION", "Configuration is not valid JSON") from exc
    if not _record(config) or config.get("version") != 1:
        raise HelperError("INSTALLATION", "Unsupported configuration version")
    required = {
        "version",
        "firecracker_version",
        "jailer_version",
        "firecracker",
        "jailer",
        "kernel",
        "base_rootfs",
        "state_dir",
        "jailer_dir",
        "cgroup_parent",
        "vmm_uids",
        "limits",
        "pins",
    }
    if set(config) != required:
        raise HelperError("INSTALLATION", "Configuration fields are not fixed")
    if config["firecracker_version"] != "1.16.2" or config["jailer_version"] != "1.16.2":
        raise HelperError("INSTALLATION", "Firecracker and jailer versions are not pinned")
    paths = [Path(config[key]) for key in ("firecracker", "jailer", "kernel", "base_rootfs")]
    if verify_installation:
        for path in paths:
            _safe_path(path, expect_file=True)
    for key in ("state_dir", "jailer_dir"):
        path = Path(config[key])
        _safe_path(path)
        if not path.is_dir():
            raise HelperError("INSTALLATION", f"Missing installation directory: {path}")
    if not isinstance(config["cgroup_parent"], str) or "/" in config["cgroup_parent"].strip("/"):
        raise HelperError("INSTALLATION", "Invalid fixed cgroup parent")
    uids = config["vmm_uids"]
    if (
        not isinstance(uids, list)
        or not uids
        or len(set(uids)) != len(uids)
        or any(isinstance(uid, bool) or not isinstance(uid, int) or uid < 2 or uid > 65534 for uid in uids)
        or 1000 in uids
    ):
        raise HelperError("INSTALLATION", "Invalid VMM UID pool")
    limits = config["limits"]
    if not _record(limits) or set(limits) != {
        "max_vms",
        "vcpu_count",
        "memory_mib",
        "vmm_overhead_mib",
        "disk_bytes",
        "start_ms",
        "exec_ms",
        "output_bytes",
    }:
        raise HelperError("INSTALLATION", "Invalid fixed limits")
    for value in limits.values():
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise HelperError("INSTALLATION", "Limits must be positive integers")
    upper_bounds = {
        "max_vms": 64,
        "vcpu_count": 16,
        "memory_mib": 65_536,
        "vmm_overhead_mib": 4_096,
        "disk_bytes": 64 * 1024 * 1024 * 1024,
        "start_ms": 120_000,
        "exec_ms": 600_000,
        "output_bytes": 1_048_576,
    }
    if any(limits[key] > maximum for key, maximum in upper_bounds.items()):
        raise HelperError("INSTALLATION", "Fixed limits exceed hard administrator bounds")
    cgroup_name = config["cgroup_parent"]
    if (
        not isinstance(cgroup_name, str)
        or cgroup_name in {"", ".", ".."}
        or re.fullmatch(r"[A-Za-z0-9_.-]+", cgroup_name) is None
    ):
        raise HelperError("INSTALLATION", "Invalid fixed cgroup parent")
    pins = config["pins"]
    if not _record(pins) or set(pins) != {"firecracker", "jailer", "kernel", "base_rootfs"}:
        raise HelperError("INSTALLATION", "Invalid digest pins")
    for value in pins.values():
        if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
            raise HelperError("INSTALLATION", "Digest pins must be lowercase SHA256 values")
    if verify_installation:
        for key, path in zip(("firecracker", "jailer", "kernel", "base_rootfs"), paths):
            if _sha256(path) != pins[key]:
                raise HelperError("INSTALLATION", f"Digest mismatch for {key}")
        if Path(config["firecracker"]).name != "firecracker":
            raise HelperError("INSTALLATION", "Firecracker binary name must be pinned")
        if Path(config["jailer"]).name != "jailer":
            raise HelperError("INSTALLATION", "Jailer binary name must be pinned")
    return config


def _sudo_uid() -> int:
    value = os.environ.get("SUDO_UID")
    if value is None:
        raise HelperError("OWNERSHIP", "SUDO_UID is required")
    try:
        uid = int(value)
    except ValueError as exc:
        raise HelperError("OWNERSHIP", "SUDO_UID is invalid") from exc
    if uid <= 0 or uid == 0:
        raise HelperError("OWNERSHIP", "Root cannot own an agent environment")
    return uid


def _require_root() -> None:
    if os.geteuid() != 0:
        raise HelperError("OWNERSHIP", "The lifecycle helper must run as root")
    _sudo_uid()


def _state_dir(config: dict[str, Any]) -> Path:
    return Path(config["state_dir"])


def _env_dir(config: dict[str, Any], env_id: str) -> Path:
    return _state_dir(config) / env_id


def _metadata_path(config: dict[str, Any], env_id: str) -> Path:
    return _env_dir(config, env_id) / "metadata.json"


def _write_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_metadata(config: dict[str, Any], env_id: str) -> dict[str, Any]:
    path = _metadata_path(config, env_id)
    _safe_path(path, expect_file=True)
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HelperError("STATE", "Environment metadata is invalid") from exc
    expected_fields = {
        "id",
        "owner_uid",
        "vmm_uid",
        "state",
        "secret",
        "disk",
        "jail_root",
        "netns",
    }
    if not _record(metadata) or set(metadata) != expected_fields or metadata.get("id") != env_id:
        raise HelperError("STATE", "Environment metadata identity mismatch")
    if (
        isinstance(metadata.get("owner_uid"), bool)
        or not isinstance(metadata.get("owner_uid"), int)
        or metadata["owner_uid"] != _sudo_uid()
    ):
        raise HelperError("OWNERSHIP", "Environment belongs to another user")
    if (
        isinstance(metadata.get("vmm_uid"), bool)
        or not isinstance(metadata.get("vmm_uid"), int)
        or metadata["vmm_uid"] not in config["vmm_uids"]
        or metadata["vmm_uid"] in (0, metadata["owner_uid"])
        or metadata.get("state") not in {"stopped", "starting", "ready", "failed"}
        or not isinstance(metadata.get("secret"), str)
        or re.fullmatch(r"[0-9a-f]{64}", metadata["secret"]) is None
        or metadata.get("disk") != str(_env_dir(config, env_id) / "disk.ext4")
        or metadata.get("jail_root")
        != str(Path(config["jailer_dir"]) / "firecracker" / env_id / "root")
        or (metadata.get("netns") is not None and metadata["netns"] != f"local-agent-{env_id}")
    ):
        raise HelperError("STATE", "Invalid VMM identity")
    return metadata


def _shutdown_config() -> dict[str, Any]:
    return {
        "state_dir": str(FIXED_STATE_DIR),
        "jailer_dir": str(FIXED_JAILER_DIR),
        "cgroup_parent": FIXED_CGROUP_PARENT,
        "vmm_uids": FIXED_VMM_UIDS,
        "limits": {"exec_ms": 600_000, "output_bytes": 1_048_576},
    }


@contextmanager
def _lock(path: Path, *, create_parent: bool = True) -> Iterator[None]:
    if create_parent:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except FileNotFoundError as exc:
        raise HelperError("NOT_FOUND", "Environment does not exist") from exc
    try:
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise HelperError("BUSY", "Another operation holds this environment lock") from None
                time.sleep(0.05)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _global_lock(config: dict[str, Any]) -> Path:
    return _state_dir(config) / ".global.lock"


def _info(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": metadata["id"],
        "backend": "firecracker",
        "state": metadata["state"],
        "workspace": "/workspace",
    }


def _checks(config: dict[str, Any] | None) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    if os.geteuid() != 0:
        checks.append({"name": "root-helper", "ok": False, "detail": "helper is not running as root"})
        return checks
    try:
        _sudo_uid()
        checks.append({"name": "sudo-uid", "ok": True, "detail": "non-root caller identity is present"})
    except HelperError as error:
        checks.append({"name": "sudo-uid", "ok": False, "detail": str(error)})
    if config is None:
        try:
            config = load_config()
        except HelperError as error:
            checks.append({"name": "installation", "ok": False, "detail": str(error)})
            return checks
    checks.append({"name": "installation", "ok": True, "detail": "pinned binaries, images, and configuration verified"})
    cgroup = Path("/sys/fs/cgroup") / config["cgroup_parent"]
    try:
        _ensure_cgroup_parent(config)
        checks.append({"name": "cgroup-v2", "ok": True, "detail": str(cgroup)})
    except HelperError as error:
        checks.append({"name": "cgroup-v2", "ok": False, "detail": str(error)})
    checks.append(_kvm_check())
    checks.append(_cpu_check())
    ip = Path("/usr/sbin/ip").is_file()
    checks.append({"name": "network-namespace-tool", "ok": ip, "detail": "fixed ip utility is installed" if ip else "install iproute2"})
    checks.append({"name": "network-policy", "ok": True, "detail": "VMs receive an empty network namespace and no NIC/TAP"})
    return checks


def _diagnose(config: dict[str, Any]) -> dict[str, Any]:
    checks = _checks(config)
    return {"ok": all(check["ok"] for check in checks), "checks": checks}


def _kvm_check() -> dict[str, Any]:
    try:
        descriptor = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
    except OSError as error:
        return {"name": "kvm", "ok": False, "detail": f"cannot open /dev/kvm: {error.strerror}"}
    try:
        version = fcntl.ioctl(descriptor, 0xAE00, 0)
        if version != 12:
            return {"name": "kvm", "ok": False, "detail": f"unsupported KVM API version: {version}"}
        vm = fcntl.ioctl(descriptor, 0xAE01, 0)
    except OSError as error:
        return {"name": "kvm", "ok": False, "detail": f"KVM ioctl failed: {error.strerror}"}
    finally:
        os.close(descriptor)
    try:
        os.close(vm)
    except OSError:
        pass
    return {"name": "kvm", "ok": True, "detail": "KVM_GET_API_VERSION is 12 and KVM_CREATE_VM succeeded"}


def _cpu_check() -> dict[str, Any]:
    try:
        flags = set()
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("flags"):
                flags = set(line.partition(":")[2].split())
                break
    except OSError as error:
        return {"name": "cpu-virtualization", "ok": False, "detail": f"cannot read /proc/cpuinfo: {error.strerror}"}
    nested = "unknown"
    for module in ("kvm_intel", "kvm_amd"):
        parameter = Path(f"/sys/module/{module}/parameters/nested")
        if parameter.is_file():
            try:
                nested = f"{module}={parameter.read_text(encoding='ascii').strip()}"
            except OSError:
                nested = f"{module}=unreadable"
            break
    supported = bool({"vmx", "svm"} & flags)
    return {
        "name": "cpu-virtualization",
        "ok": supported,
        "detail": f"hardware virtualization {'present' if supported else 'absent'}; nested {nested}",
    }


def _ensure_cgroup_parent(config: dict[str, Any]) -> Path:
    parent = Path("/sys/fs/cgroup") / config["cgroup_parent"]
    if not parent.is_dir():
        raise HelperError("CGROUP", "The administrator cgroup parent is missing")
    if not (parent / "cgroup.controllers").is_file() or not (parent / "cgroup.kill").is_file():
        raise HelperError("CGROUP", "A cgroup v2 parent with cgroup.kill is required")
    controllers = set((parent / "cgroup.controllers").read_text(encoding="ascii").split())
    if not {"cpu", "memory", "pids"}.issubset(controllers):
        raise HelperError("CGROUP", "The cgroup parent must expose cpu, memory, and pids controllers")
    return parent


def _create_netns(env_id: str) -> str:
    name = f"local-agent-{env_id}"
    try:
        result = subprocess.run(
            ["/usr/sbin/ip", "netns", "add", name],
            env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        _destroy_netns(name)
        raise HelperError("NETWORK_NAMESPACE", "Timed out creating the isolated network namespace") from exc
    if result.returncode:
        raise HelperError("NETWORK_NAMESPACE", result.stderr.strip() or "Could not create network namespace")
    return name


def _destroy_netns(name: str) -> None:
    result = subprocess.run(
        ["/usr/sbin/ip", "netns", "del", name],
        env={"PATH": "/usr/sbin:/usr/bin:/bin"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=10,
    )
    if result.returncode and "No such file" not in result.stderr:
        raise HelperError("NETWORK_NAMESPACE", "Could not remove network namespace")


def _cgroup_path(config: dict[str, Any], env_id: str) -> Path:
    return Path("/sys/fs/cgroup") / config["cgroup_parent"] / env_id


def _kill_cgroup(config: dict[str, Any], env_id: str) -> None:
    path = _cgroup_path(config, env_id)
    if not path.exists():
        return
    kill = path / "cgroup.kill"
    if not kill.is_file():
        raise HelperError("CLEANUP_UNKNOWN", "VM cgroup has no cgroup.kill")
    try:
        kill.write_text("1", encoding="ascii")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not (path / "cgroup.procs").read_text(encoding="ascii").strip():
                try:
                    path.rmdir()
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    raise HelperError("CLEANUP_UNKNOWN", "Could not reclaim the VM cgroup") from exc
                return
            time.sleep(0.05)
    except OSError as exc:
        raise HelperError("CLEANUP_UNKNOWN", "Could not kill the VM cgroup") from exc
    raise HelperError("CLEANUP_UNKNOWN", "VM cgroup did not become empty")


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HelperError("TIMEOUT", "The host deadline for this operation expired")
    return remaining


def _read_acknowledgement(channel: socket.socket, deadline: float) -> None:
    acknowledgement = b""
    while not acknowledgement.endswith(b"\n"):
        if len(acknowledgement) >= 64:
            raise HelperError("TRANSPORT", "Guest vsock acknowledgement was too long")
        channel.settimeout(_remaining(deadline))
        block = channel.recv(1)
        if not block:
            raise HelperError("TRANSPORT", "Guest closed the vsock control connection")
        acknowledgement += block
    match = re.fullmatch(rb"OK (\d{1,10})\n", acknowledgement)
    if match is None or not 0 <= int(match.group(1)) <= 0xFFFFFFFF:
        raise HelperError("TRANSPORT", "Guest vsock acknowledgement was invalid")


def _connect_vsock(path: Path, deadline: float) -> socket.socket:
    while True:
        remaining = _remaining(deadline)
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            channel.settimeout(remaining)
            channel.connect(os.fspath(path))
            _send_all(channel, b"CONNECT 5000\n", deadline)
            _read_acknowledgement(channel, deadline)
            return channel
        except HelperError:
            channel.close()
            raise
        except OSError:
            channel.close()
            if deadline - time.monotonic() <= 0.05:
                raise HelperError("READINESS", "Guest Runner did not accept a vsock connection") from None
            time.sleep(0.05)


def _wait_writable(channel: socket.socket, deadline: float | None) -> None:
    if deadline is None:
        return
    readable, writable, _ = select.select([], [channel], [], _remaining(deadline))
    if not writable:
        raise HelperError("TIMEOUT", "The host deadline for a guest write expired")


def _send_all(channel: socket.socket, value: bytes, deadline: float | None) -> None:
    if deadline is None:
        channel.sendall(value)
        return
    channel.setblocking(False)
    sent = 0
    while sent < len(value):
        _wait_writable(channel, deadline)
        try:
            sent += channel.send(value[sent:])
        except BlockingIOError:
            continue


def _frame_send(
    channel: socket.socket, value: dict[str, Any], deadline: float | None = None
) -> None:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    if not encoded or len(encoded) > MAX_FRAME_BYTES:
        raise HelperError("PROTOCOL", "Guest frame is too large")
    _send_all(channel, struct.pack("!I", len(encoded)) + encoded, deadline)


def _frame_recv(
    channel: socket.socket, deadline: float | None = None
) -> dict[str, Any]:
    header = _recv_exact(channel, 4, deadline)
    size = struct.unpack("!I", header)[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise HelperError("PROTOCOL", "Guest frame length is invalid")
    try:
        value = json.loads(
            _recv_exact(channel, size, deadline), object_pairs_hook=_unique_object
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise HelperError("PROTOCOL", "Guest frame is not JSON") from exc
    if not _record(value):
        raise HelperError("PROTOCOL", "Guest frame is not an object")
    return value


def _recv_exact(
    channel: socket.socket, size: int, deadline: float | None = None
) -> bytes:
    chunks = bytearray()
    if deadline is not None:
        channel.setblocking(False)
    while len(chunks) < size:
        if deadline is not None:
            readable, _, _ = select.select([channel], [], [], _remaining(deadline))
            if not readable:
                raise HelperError("TIMEOUT", "The host deadline for a guest read expired")
        try:
            block = channel.recv(size - len(chunks))
        except BlockingIOError:
            continue
        if not block:
            raise HelperError("TRANSPORT", "Guest closed the authenticated channel")
        chunks.extend(block)
    return bytes(chunks)


def _canonical(value: dict[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def _authenticated_request(metadata: dict[str, Any], payload: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
    deadline = time.monotonic() + min(timeout_ms, 605_000) / 1000
    channel = _connect_vsock(Path(metadata["jail_root"]) / "run" / "vsock.sock", deadline)
    secret = bytes.fromhex(metadata["secret"])
    environment_id = metadata["id"].encode()
    nonce = secrets.token_bytes(32).hex()
    try:
        _frame_send(
            channel,
            {"type": "hello", "version": PROTOCOL_VERSION, "id": metadata["id"], "nonce": nonce},
            deadline,
        )
        hello = _frame_recv(channel, deadline)
        if (
            hello.get("type") != "hello"
            or hello.get("version") != PROTOCOL_VERSION
            or hello.get("id") != metadata["id"]
            or set(hello) != {"type", "version", "id", "nonce", "mac"}
            or isinstance(hello.get("version"), bool)
            or not isinstance(hello.get("version"), int)
            or not isinstance(hello.get("nonce"), str)
            or re.fullmatch(r"[0-9a-f]{64}", hello["nonce"]) is None
            or not isinstance(hello.get("mac"), str)
            or re.fullmatch(r"[0-9a-f]{64}", hello["mac"]) is None
        ):
            raise HelperError("AUTHENTICATION", "Guest identity handshake was invalid")
        expected = hmac.new(secret, b"guest:" + environment_id + nonce.encode() + hello["nonce"].encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(str(hello.get("mac", "")), expected):
            raise HelperError("AUTHENTICATION", "Guest identity proof was invalid")
        proof = hmac.new(secret, b"host:" + environment_id + nonce.encode() + hello["nonce"].encode(), hashlib.sha256).hexdigest()
        _frame_send(channel, {"type": "proof", "mac": proof}, deadline)
        envelope = {"payload": payload, "nonce": nonce, "guest_nonce": hello["nonce"]}
        envelope["mac"] = hmac.new(secret, _canonical(envelope), hashlib.sha256).hexdigest()
        _frame_send(channel, envelope, deadline)
        response = _frame_recv(channel, deadline)
        if (
            set(response) != {"payload", "nonce", "guest_nonce", "mac"}
            or response.get("nonce") != nonce
            or response.get("guest_nonce") != hello["nonce"]
        ):
            raise HelperError("AUTHENTICATION", "Guest response nonce was invalid")
        mac = response.pop("mac", None)
        if not isinstance(mac, str) or not hmac.compare_digest(mac, hmac.new(secret, _canonical(response), hashlib.sha256).hexdigest()):
            raise HelperError("AUTHENTICATION", "Guest response authentication was invalid")
        result = response.get("payload")
        if not _record(result):
            raise HelperError("PROTOCOL", "Guest result shape was invalid")
        return result
    finally:
        channel.close()


def _cgroup_is_live(config: dict[str, Any], env_id: str) -> bool:
    path = _cgroup_path(config, env_id)
    try:
        return bool((path / "cgroup.procs").read_text(encoding="ascii").strip())
    except OSError:
        return False


def _ready(metadata: dict[str, Any], config: dict[str, Any], timeout_ms: int = 10_000) -> None:
    if not _cgroup_is_live(config, metadata["id"]):
        raise HelperError("READINESS", "The owned VM cgroup has no live process")
    result = _authenticated_request(metadata, {"op": "ready"}, timeout_ms)
    if (
        set(result) != {"ok", "version", "id", "workspace", "shell", "python3"}
        or isinstance(result.get("version"), bool)
        or not isinstance(result.get("version"), int)
        or result.get("ok") is not True
        or result.get("version") != PROTOCOL_VERSION
        or result.get("id") != metadata["id"]
        or result.get("workspace") is not True
        or result.get("shell") is not True
        or result.get("python3") is not True
    ):
        raise HelperError("READINESS", "Guest Runner readiness contract was not satisfied")
    if not _cgroup_is_live(config, metadata["id"]):
        raise HelperError("READINESS", "The VM disappeared after responding")


def _start(metadata: dict[str, Any], config: dict[str, Any]) -> None:
    _ensure_cgroup_parent(config)
    CLEANED.discard(metadata["id"])
    metadata["state"] = "starting"
    _write_json(_metadata_path(config, metadata["id"]), metadata)
    jail_root = Path(metadata["jail_root"])
    jail_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        run_dir = jail_root / "run"
        run_dir.mkdir(mode=0o755, exist_ok=True)
        os.chown(run_dir, metadata["vmm_uid"], metadata["vmm_uid"])
        shutil.copyfile(Path(config["kernel"]), jail_root / "vmlinux")
        (jail_root / "vmlinux").chmod(0o644)
        link = jail_root / "rootfs.ext4"
        link.unlink(missing_ok=True)
        os.link(metadata["disk"], link)
        os.chown(link, metadata["vmm_uid"], metadata["vmm_uid"])
        link.chmod(0o600)
        jail_root.chmod(0o755)
    except BaseException:
        _stop(metadata, config, failed=True)
        raise
    vm_config = {
        "boot-source": {
            "kernel_image_path": "/vmlinux",
            "boot_args": f"console=ttyS0 reboot=k panic=1 root=/dev/vda rw rootwait agent.env_id={metadata['id']} agent.env_secret={metadata['secret']} init=/sbin/init",
        },
        "drives": [{"drive_id": "rootfs", "path_on_host": "/rootfs.ext4", "is_root_device": True, "is_read_only": False}],
        "machine-config": {
            "vcpu_count": config["limits"]["vcpu_count"],
            "mem_size_mib": config["limits"]["memory_mib"],
            "smt": False,
        },
        "vsock": {"guest_cid": 3, "uds_path": "/run/vsock.sock"},
    }
    try:
        _write_json(jail_root / "config.json", vm_config)
        (jail_root / "config.json").chmod(0o644)
    except BaseException:
        _stop(metadata, config, failed=True)
        raise
    try:
        metadata["netns"] = _create_netns(metadata["id"])
        _write_json(_metadata_path(config, metadata["id"]), metadata)
        limits = config["limits"]
        command = [
            config["jailer"],
            "--id", metadata["id"],
            "--exec-file", config["firecracker"],
            "--uid", str(metadata["vmm_uid"]),
            "--gid", str(metadata["vmm_uid"]),
            "--parent-cgroup", config["cgroup_parent"],
            "--cgroup-version", "2",
            "--cgroup", f"cpu.max={limits['vcpu_count'] * 100000} 100000",
            "--cgroup", f"memory.max={(limits['memory_mib'] + limits['vmm_overhead_mib']) * 1024 * 1024}",
            "--cgroup", "pids.max=128",
            "--chroot-base-dir", str(Path(config["jailer_dir"])),
            "--netns", f"/run/netns/{metadata['netns']}",
            "--new-pid-ns",
            "--daemonize",
            "--resource-limit", f"fsize={limits['disk_bytes']}",
            "--resource-limit", "no-file=1024",
            "--",
            "--no-api",
            "--config-file", "/config.json",
        ]
        result = subprocess.run(
            command,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=15,
        )
        if result.returncode:
            raise HelperError("START", result.stderr.strip() or "Jailer failed to start Firecracker")
        _ready(metadata, config, min(config["limits"]["start_ms"], 120_000))
    except BaseException:
        _stop(metadata, config, failed=True)
        raise
    metadata["state"] = "ready"
    _write_json(_metadata_path(config, metadata["id"]), metadata)


def _sync_guest(metadata: dict[str, Any], config: dict[str, Any]) -> None:
    result = _authenticated_request(metadata, {"op": "sync"}, 30_000)
    if set(result) != {"ok", "synced"} or result.get("ok") is not True or result.get("synced") is not True:
        raise HelperError("SYNC", "The guest did not confirm a durable filesystem sync")


def _stop(metadata: dict[str, Any], config: dict[str, Any], *, failed: bool = False) -> None:
    env_id = metadata["id"]
    if env_id in CLEANED:
        return
    CLEANED.add(env_id)
    try:
        _stop_inner(metadata, config, failed=failed)
    finally:
        CLEANED.discard(env_id)


def _stop_inner(
    metadata: dict[str, Any], config: dict[str, Any], *, failed: bool = False
) -> None:
    env_id = metadata["id"]
    uncertain = failed
    kill_error: HelperError | None = None
    if metadata["state"] in {"ready", "starting", "failed"}:
        if metadata["state"] == "ready" and not failed:
            try:
                _sync_guest(metadata, config)
            except (HelperError, OSError, ValueError):
                uncertain = True
        try:
            _kill_cgroup(config, env_id)
        except HelperError as error:
            kill_error = error
            uncertain = True
    netns = metadata.get("netns") or (
        f"local-agent-{env_id}" if metadata["state"] in {"ready", "starting", "failed"} else None
    )
    if netns:
        try:
            _destroy_netns(netns)
        except HelperError:
            uncertain = True
        metadata["netns"] = None
    jail_root = Path(metadata["jail_root"])
    link = jail_root / "rootfs.ext4"
    try:
        link.unlink(missing_ok=True)
        if jail_root.parent.exists():
            shutil.rmtree(jail_root.parent, ignore_errors=False)
    except OSError:
        uncertain = True
    metadata["state"] = "failed" if uncertain else "stopped"
    _write_json(_metadata_path(config, env_id), metadata)
    if kill_error is not None:
        raise kill_error
    if uncertain and not failed:
        raise HelperError("UNKNOWN_RESULT", "The VM was reclaimed without a confirmed clean shutdown")


def _create(config: dict[str, Any]) -> dict[str, Any]:
    owner = _sudo_uid()
    with _lock(_global_lock(config)):
        state = _state_dir(config)
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        existing = [item for item in state.iterdir() if item.is_dir() and ENVIRONMENT_ID.fullmatch(item.name)]
        if len(existing) >= config["limits"]["max_vms"]:
            raise HelperError("QUOTA", "The administrator VM quota is exhausted")
        used_uids = set()
        used_uids.add(owner)
        for item in existing:
            try:
                used_uids.add(json.loads((item / "metadata.json").read_text())["vmm_uid"])
            except (OSError, ValueError, KeyError):
                continue
        in_use = set()
        for uid in config["vmm_uids"]:
            try:
                pwd.getpwuid(uid)
                in_use.add(uid)
            except KeyError:
                pass
        vmm_uid = next((uid for uid in config["vmm_uids"] if uid not in used_uids | in_use), None)
        if vmm_uid is None:
            raise HelperError("QUOTA", "The administrator VMM UID pool is exhausted")
        env_id = str(uuid.uuid4())
        directory = _env_dir(config, env_id)
        directory.mkdir(mode=0o700)
        disk = directory / "disk.ext4"
        temporary = directory / ".disk.ext4.new"
        try:
            shutil.copyfile(config["base_rootfs"], temporary)
            os.replace(temporary, disk)
            disk.chmod(0o600)
            os.chown(disk, 0, 0)
            metadata = {
                "id": env_id,
                "owner_uid": owner,
                "vmm_uid": vmm_uid,
                "state": "stopped",
                "secret": secrets.token_hex(32),
                "disk": str(disk),
                "jail_root": str(Path(config["jailer_dir"]) / "firecracker" / env_id / "root"),
                "netns": None,
            }
            _write_json(_metadata_path(config, env_id), metadata)
            return _info(metadata)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise


def _operate(config: dict[str, Any], operation: str, env_id: str | None = None, command: dict[str, Any] | None = None) -> Any:
    if operation == "diagnose":
        return _diagnose(config)
    if operation == "create":
        return _create(config)
    if env_id is None:
        raise HelperError("INVALID_REQUEST", "Environment ID is required")
    env_id = validate_id(env_id)
    lock_path = _env_dir(config, env_id) / "operation.lock"
    with _lock(lock_path, create_parent=False):
        metadata = _read_metadata(config, env_id)
        if operation == "status":
            if metadata["state"] in {"ready", "starting"}:
                try:
                    _ready(metadata, config)
                    metadata["state"] = "ready"
                    _write_json(_metadata_path(config, env_id), metadata)
                except (HelperError, OSError, ValueError):
                    _stop(metadata, config, failed=True)
                    metadata["state"] = "failed"
                    _write_json(_metadata_path(config, env_id), metadata)
            return _info(metadata)
        if operation == "start":
            if metadata["state"] in {"ready", "starting"}:
                try:
                    _ready(metadata, config)
                    metadata["state"] = "ready"
                    _write_json(_metadata_path(config, env_id), metadata)
                    return _info(metadata)
                except (HelperError, OSError, ValueError):
                    _stop(metadata, config, failed=True)
                    CLEANED.discard(env_id)
            if metadata["state"] not in {"stopped", "failed"}:
                raise HelperError("STATE", "Environment is busy or in an unknown state")
            ACTIVE.append((config, env_id))
            try:
                _start(metadata, config)
            finally:
                ACTIVE.remove((config, env_id))
            return _info(metadata)
        if operation == "stop":
            _stop(metadata, config)
            return _info(metadata)
        if operation == "destroy":
            with _lock(_global_lock(config)):
                try:
                    _stop(metadata, config, failed=True)
                except HelperError:
                    raise
                shutil.rmtree(_env_dir(config, env_id), ignore_errors=False)
                return None
        if operation == "execute":
            if metadata["state"] != "ready":
                raise HelperError("STATE", "Environment is not ready")
            assert command is not None
            if (
                command["timeoutMs"] > config["limits"]["exec_ms"]
                or command["maxOutputBytes"] > config["limits"]["output_bytes"]
            ):
                raise HelperError("INVALID_COMMAND", "Command limits exceed configured administrator limits")
            ACTIVE.append((config, env_id))
            try:
                result = _authenticated_request(
                    metadata,
                    {
                        "op": "exec",
                        "argv": command["argv"],
                        "timeout_ms": command["timeoutMs"],
                        "max_output_bytes": command["maxOutputBytes"],
                    },
                    command["timeoutMs"] + 5000,
                )
                if (
                    set(result) != {"ok", "code", "stdout", "stderr", "truncated"}
                    or result.get("ok") is not True
                    or isinstance(result.get("code"), bool)
                    or not isinstance(result.get("code"), int)
                    or not isinstance(result.get("stdout"), str)
                    or not isinstance(result.get("stderr"), str)
                    or not isinstance(result.get("truncated"), bool)
                    or len(result["stdout"].encode()) + len(result["stderr"].encode()) > command["maxOutputBytes"]
                ):
                    raise HelperError("PROTOCOL", "Guest command result shape was invalid")
                return {key: result[key] for key in ("code", "stdout", "stderr", "truncated")}
            except (HelperError, OSError, ValueError, struct.error):
                _stop(metadata, config, failed=True)
                raise
            finally:
                ACTIVE.remove((config, env_id))
    raise HelperError("INVALID_REQUEST", f"Unsupported operation: {operation}")


def _response(value: Any) -> dict[str, Any]:
    response = {"ok": True, "result": value}
    if len(json.dumps(response, separators=(",", ":")).encode()) > MAX_RESPONSE_BYTES:
        return {"ok": False, "error": {"code": "PROTOCOL", "message": "Response exceeded the protocol limit"}}
    return response


def main() -> int:
    reclaiming = False

    def reclaim() -> None:
        nonlocal reclaiming
        if reclaiming:
            return
        reclaiming = True
        for config, env_id in list(ACTIVE):
            try:
                metadata = _read_metadata(config, env_id)
                _stop(metadata, config, failed=True)
            except Exception:
                try:
                    _kill_cgroup(config, env_id)
                except Exception:
                    pass

    def terminate(signum: int, _frame: Any) -> None:
        signal.alarm(0)
        reclaim()
        raise SystemExit(128 + signum)

    def watchdog(_signum: int, _frame: Any) -> None:
        reclaim()
        raise SystemExit(128 + signal.SIGALRM)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGALRM, watchdog)
    signal.alarm(WATCHDOG_SECONDS)
    invalid_arguments = len(sys.argv) != 1
    raw = b"" if invalid_arguments else sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if invalid_arguments:
        response = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "The helper does not accept command-line arguments"}}
    else:
        if len(raw) > MAX_REQUEST_BYTES:
            response = {"ok": False, "error": {"code": "PROTOCOL", "message": "Request exceeded the protocol limit"}}
        else:
            try:
                request = validate_request(
                    json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
                )
                _require_root()
                try:
                    config = load_config(
                        verify_installation=request["op"] not in {"stop", "destroy"}
                    )
                except HelperError:
                    if request["op"] not in {"stop", "destroy"}:
                        raise
                    config = _shutdown_config()
                result = _operate(config, request["op"], request.get("id"), request.get("command"))
                response = _response(result)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                response = {"ok": False, "error": {"code": "PROTOCOL", "message": "Request is not UTF-8 JSON"}}
            except HelperError as error:
                response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
            except Exception:
                response = {"ok": False, "error": {"code": "INTERNAL", "message": "The helper failed closed"}}
    encoded = json.dumps(response, separators=(",", ":")).encode()
    if len(encoded) > MAX_RESPONSE_BYTES:
        encoded = b'{"ok":false,"error":{"code":"PROTOCOL","message":"response too large"}}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()
    signal.alarm(0)
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
