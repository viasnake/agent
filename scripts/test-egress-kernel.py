#!/usr/bin/env python3
"""Opt-in kernel test: isolated veth pair, no installed Agent or host rule changes."""

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "install"))
import system

WORK_UID = 65534
TARGET = "10.225.42.2"
PROTECTED = "10.225.42.3"
PORT = 2222


def command(*args):
    subprocess.run(args, check=True, timeout=10)


def probe(host, port, allowed, uid=WORK_UID):
    script = """
import errno, socket, sys
host, port, allowed = sys.argv[1:]
with socket.socket() as sock:
    sock.settimeout(2)
    result = sock.connect_ex((host, int(port)))
    expected = (0,) if allowed == 'True' else (errno.ECONNREFUSED, errno.EAGAIN)
    assert result in expected, (host, port, allowed, result)
"""
    command("setpriv", "--reuid", str(uid), "--regid", str(uid), "--clear-groups",
            sys.executable, "-c", script, host, str(port), str(allowed))


if (os.environ.get("AGENT_GUEST_TEST") != "1" or os.geteuid() != 0
        or os.readlink("/proc/self/ns/net") == os.readlink("/proc/1/ns/net")):
    sys.exit(77)

with tempfile.TemporaryDirectory(prefix="agent-egress-test-", dir="/run") as temporary:
    root = Path(temporary)
    system.DESTINATIONS = root / "destinations.json"
    system.EGRESS_TEMPLATE = root / "egress.nft"
    system.PROTECTED = root / "protected.nft"
    system.READY = root / "ready"
    system.EGRESS_LOCK = root / "lock"
    system.PROTECTED.write_text(f"define protected_cidrs = {{ {PROTECTED}/32 }}\n")
    system.EGRESS_TEMPLATE.write_text((ROOT / "install/egress.nft").read_text().replace(
        "/etc/agent/protected-cidrs.nft", str(system.PROTECTED)))
    peer = subprocess.Popen(["unshare", "--net", "--", "sleep", "120"])
    try:
        local_ns = os.readlink("/proc/self/ns/net")
        for _ in range(100):
            if os.readlink(f"/proc/{peer.pid}/ns/net") != local_ns:
                break
            time.sleep(0.02)
        else:
            raise RuntimeError("Peer did not enter its network namespace")
        inside = ("nsenter", "--target", str(peer.pid), "--net", "--")
        command("ip", "link", "add", "test-out", "type", "veth", "peer", "name", "test-in")
        command("ip", "link", "set", "test-in", "netns", str(peer.pid))
        command("ip", "addr", "add", "10.225.42.1/24", "dev", "test-out")
        command("ip", "link", "set", "test-out", "up")
        command("ip", "link", "set", "lo", "up")
        for addr in (TARGET, PROTECTED):
            command(*inside, "ip", "addr", "add", f"{addr}/24", "dev", "test-in")
        command(*inside, "ip", "link", "set", "test-in", "up")
        listener = """
import socket, sys, time
listeners = []
for host in sys.argv[1:]:
    for port in (2222, 2223):
        s = socket.socket()
        s.bind((host, port))
        s.listen(20)
        listeners.append(s)
print('ready', flush=True)
time.sleep(90)
"""
        with subprocess.Popen([*inside, sys.executable, "-u", "-c", listener, TARGET, PROTECTED], stdout=subprocess.PIPE, text=True) as server:
            try:
                assert server.stdout.readline().strip() == "ready"
                system.egress({"workUid": WORK_UID})
                original = system.destination_request({"operation": "read"})
                assert original["applied"] and original["entries"] == []
                probe(TARGET, PORT, True, uid=0)
                probe(TARGET, PORT + 1, True, uid=0)
                probe(PROTECTED, PORT, True, uid=0)
                probe(TARGET, PORT, False)
                entry = {"ip": TARGET, "port": PORT, "name": "fixture"}
                update = {"operation": "write", "revision": original["revision"], "entries": [entry]}
                assert system.destination_request({**update, "entries": [{**entry, "ip": PROTECTED}]})["status"] == "invalid"
                saved = system.destination_request(update)
                assert saved["applied"] and saved["entries"] == [entry]
                probe(TARGET, PORT, True)
                probe(TARGET, PORT + 1, False)
                probe(PROTECTED, PORT, False)
                with socket.socket() as local:
                    local.bind(("10.225.42.1", PORT))
                    local.listen()
                    # Even an explicitly registered local interface address cannot reach a VM service.
                    with_local = {"operation": "write", "revision": saved["revision"],
                                  "entries": [entry, {**entry, "ip": "10.225.42.1"}]}
                    saved = system.destination_request(with_local)
                    assert saved["applied"]
                    probe("10.225.42.1", PORT, False)
                system.egress({"workUid": WORK_UID})
                assert system.destination_request({"operation": "read"}) == saved
                cleared = system.destination_request({"operation": "write", "revision": saved["revision"], "entries": []})
                assert cleared["applied"] and cleared["entries"] == []
                probe(TARGET, PORT, False)
                print("Isolated nftables transaction, endpoint scope, restart and removal passed")
            finally:
                server.terminate()
    finally:
        peer.terminate()
        peer.wait(timeout=5)
