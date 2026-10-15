#!/usr/bin/env python3
"""Small stdlib-only authenticated command runner installed in the guest image."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import selectors
import signal
import socket
import struct
import subprocess
import time
from pathlib import Path
from typing import Any

MAX_FRAME_BYTES = 8 * 1024 * 1024
VERSION = 1
PORT = 5000
ENVIRONMENT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class RunnerError(Exception):
    pass


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _frame_send(channel: socket.socket, value: dict[str, Any]) -> None:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    if not encoded or len(encoded) > MAX_FRAME_BYTES:
        raise RunnerError("frame too large")
    channel.sendall(struct.pack("!I", len(encoded)) + encoded)


def _recv_exact(channel: socket.socket, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        part = channel.recv(size - len(result))
        if not part:
            raise RunnerError("peer closed")
        result.extend(part)
    return bytes(result)


def _frame_recv(channel: socket.socket) -> dict[str, Any]:
    size = struct.unpack("!I", _recv_exact(channel, 4))[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise RunnerError("invalid frame size")
    try:
        value = json.loads(_recv_exact(channel, size), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, ValueError) as exc:
        raise RunnerError("invalid JSON") from exc
    if not isinstance(value, dict):
        raise RunnerError("frame is not an object")
    return value


def _canonical(value: dict[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def _boot_identity() -> tuple[str, bytes]:
    values: dict[str, str] = {}
    for argument in Path("/proc/cmdline").read_text(encoding="ascii").split():
        if argument.startswith("agent.env_"):
            key, separator, value = argument.partition("=")
            if not separator or key in values:
                raise RunnerError("invalid boot identity")
            values[key] = value
    env_id = values.get("agent.env_id", "")
    secret_hex = values.get("agent.env_secret", "")
    if ENVIRONMENT_ID.fullmatch(env_id) is None or len(secret_hex) != 64:
        raise RunnerError("missing boot identity")
    try:
        secret = bytes.fromhex(secret_hex)
    except ValueError as exc:
        raise RunnerError("invalid boot secret") from exc
    return env_id, secret


def _ready(env_id: str) -> dict[str, Any]:
    workspace = Path("/workspace")
    writable = workspace.is_dir() and os.access(workspace, os.W_OK)
    marker = workspace / ".local-agent-runner-check"
    try:
        marker.write_text("ready\n", encoding="ascii")
        marker.unlink()
        writable = writable and True
    except OSError:
        writable = False
    return {
        "ok": True,
        "version": VERSION,
        "id": env_id,
        "workspace": writable,
        "shell": os.access("/bin/sh", os.X_OK),
        "python3": os.access("/usr/bin/python3", os.X_OK),
    }


def _decode_limited(value: bytes, limit: int) -> tuple[str, bool]:
    decoded = value.decode("utf-8", "replace")
    encoded = decoded.encode("utf-8")
    if len(encoded) <= limit:
        return decoded, False
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        if len(value[:middle].decode("utf-8", "replace").encode("utf-8")) <= limit:
            low = middle
        else:
            high = middle - 1
    return value[:low].decode("utf-8", "replace"), True


def _execute(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"op", "argv", "timeout_ms", "max_output_bytes"} or payload["op"] != "exec":
        raise RunnerError("invalid command shape")
    argv = payload["argv"]
    timeout_ms = payload["timeout_ms"]
    limit = payload["max_output_bytes"]
    if (
        not isinstance(argv, list)
        or not argv
        or len(argv) > 128
        or any(
            not isinstance(arg, str)
            or (index == 0 and not arg)
            or "\x00" in arg
            or len(arg.encode()) > 16384
            for index, arg in enumerate(argv)
        )
        or isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, int)
        or not 1 <= timeout_ms <= 600_000
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 1_048_576
    ):
        raise RunnerError("command limits are invalid")
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
    }
    try:
        child = subprocess.Popen(
            argv,
            cwd="/workspace",
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        return {"ok": True, "code": 127, "stdout": "", "stderr": str(error), "truncated": False}
    assert child.stdout is not None and child.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, "stdout")
    selector.register(child.stderr, selectors.EVENT_READ, "stderr")
    stdout = bytearray()
    stderr = bytearray()
    truncated = False
    deadline = time.monotonic() + timeout_ms / 1000
    stopped = False
    try:
        while selector.get_map() or child.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stopped = True
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                time.sleep(0.05)
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                break
            if not selector.get_map():
                try:
                    child.wait(timeout=min(remaining, 0.1))
                except subprocess.TimeoutExpired:
                    pass
                continue
            for key, _ in selector.select(min(remaining, 0.1)):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                target = stdout if key.data == "stdout" else stderr
                if len(stdout) + len(stderr) + len(block) > limit:
                    truncated = True
                    allowed = max(0, limit - len(stdout) - len(stderr))
                    target.extend(block[:allowed])
                    stopped = True
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    break
                target.extend(block)
            if stopped:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                break
        child.wait(timeout=1)
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.05)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    finally:
        selector.close()
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
    stdout_text, stdout_limited = _decode_limited(bytes(stdout), limit)
    remaining = max(0, limit - len(stdout_text.encode("utf-8")))
    stderr_text, stderr_limited = _decode_limited(bytes(stderr), remaining)
    return {
        "ok": True,
        "code": 124 if stopped else (child.returncode if child.returncode is not None else 1),
        "stdout": stdout_text,
        "stderr": stderr_text,
        "truncated": truncated or stdout_limited or stderr_limited,
    }


def _session(channel: socket.socket, env_id: str, secret: bytes) -> None:
    hello = _frame_recv(channel)
    nonce = hello.get("nonce")
    if (
        set(hello) != {"type", "version", "id", "nonce"}
        or hello.get("type") != "hello"
        or isinstance(hello.get("version"), bool)
        or not isinstance(hello.get("version"), int)
        or hello.get("version") != VERSION
        or hello.get("id") != env_id
        or not isinstance(nonce, str)
        or re.fullmatch(r"[0-9a-f]{64}", nonce) is None
    ):
        raise RunnerError("invalid host identity")
    guest_nonce = os.urandom(32).hex()
    mac = hmac.new(secret, b"guest:" + env_id.encode() + nonce.encode() + guest_nonce.encode(), hashlib.sha256).hexdigest()
    _frame_send(channel, {"type": "hello", "version": VERSION, "id": env_id, "nonce": guest_nonce, "mac": mac})
    proof = _frame_recv(channel)
    expected = hmac.new(secret, b"host:" + env_id.encode() + nonce.encode() + guest_nonce.encode(), hashlib.sha256).hexdigest()
    if (
        set(proof) != {"type", "mac"}
        or proof.get("type") != "proof"
        or not isinstance(proof.get("mac"), str)
        or not hmac.compare_digest(proof["mac"], expected)
    ):
        raise RunnerError("invalid host proof")
    envelope = _frame_recv(channel)
    if (
        set(envelope) != {"payload", "nonce", "guest_nonce", "mac"}
        or envelope.get("nonce") != nonce
        or envelope.get("guest_nonce") != guest_nonce
    ):
        raise RunnerError("invalid request nonce")
    mac = envelope.pop("mac", None)
    if not isinstance(mac, str) or not hmac.compare_digest(mac, hmac.new(secret, _canonical(envelope), hashlib.sha256).hexdigest()):
        raise RunnerError("invalid request authentication")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise RunnerError("invalid request payload")
    result = _ready(env_id) if payload.get("op") == "ready" and set(payload) == {"op"} else _execute(payload)
    response = {"payload": result, "nonce": nonce, "guest_nonce": guest_nonce}
    response["mac"] = hmac.new(secret, _canonical(response), hashlib.sha256).hexdigest()
    _frame_send(channel, response)


def main() -> int:
    env_id, secret = _boot_identity()
    address = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    address.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    address.bind((socket.VMADDR_CID_ANY, PORT))
    address.listen(16)
    while True:
        channel, _ = address.accept()
        channel.settimeout(30)
        try:
            _session(channel, env_id, secret)
        except (OSError, RunnerError, ValueError):
            pass
        finally:
            channel.close()


if __name__ == "__main__":
    raise SystemExit(main())
