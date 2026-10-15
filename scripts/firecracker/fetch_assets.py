#!/usr/bin/env python3
"""Fetch only the pinned setup inputs; never used by the runtime helper."""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

LOCK = Path(__file__).with_name("assets.sha256")


def entries() -> list[tuple[str, str, str]]:
    result = []
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        name, digest, url = line.split()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError(f"invalid digest in {LOCK}: {name}")
        result.append((name, digest, url))
    if len(result) != 3:
        raise ValueError("the setup lock must contain exactly three inputs")
    return result


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def fetch(output: Path) -> None:
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name, expected, url in entries():
        if name.startswith("firecracker-"):
            checksum_url = f"{url}.sha256.txt"
            with urllib.request.urlopen(checksum_url, timeout=30) as response:
                upstream = response.read(4096).decode("ascii").split()
            if len(upstream) < 2 or upstream[0] != expected or upstream[1] != name:
                raise RuntimeError("official Firecracker release checksum does not match the lock")
        destination = output / name
        temporary = output / f".{name}.partial"
        print(f"fetching {name} from the pinned URL")
        with urllib.request.urlopen(url, timeout=60) as source, temporary.open("wb") as target:
            while block := source.read(1024 * 1024):
                target.write(block)
        if digest(temporary) != expected:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"SHA256 mismatch for {name}")
        temporary.replace(destination)
        destination.chmod(0o600)
        print(f"verified {name}: {expected}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} OUTPUT_DIRECTORY")
    fetch(Path(sys.argv[1]).resolve())
