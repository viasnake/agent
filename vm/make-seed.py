#!/usr/bin/env python3
import argparse
import base64
import json
from pathlib import Path
import re
import uuid

args = argparse.ArgumentParser()
args.add_argument("--ssh-key", required=True)
args.add_argument("--output", required=True)
options = args.parse_args()
root = Path(__file__).resolve().parent
key = Path(options.ssh_key).read_text().strip()
if not re.fullmatch(r"(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: [^\r\n]+)?", key):
    raise SystemExit("An explicit single OpenSSH public key is required")
output = Path(options.output)
output.mkdir(mode=0o700)
content = (root / "cloud-init.yaml").read_text().replace("__SSH_KEY__", json.dumps(key)).replace("__DISK_SCRIPT__", base64.b64encode((root / "guest-disk.py").read_bytes()).decode())
(output / "user-data").write_text(content)
(output / "meta-data").write_text(f"instance-id: agent-{uuid.uuid4()}\nlocal-hostname: personal-agent\n")
