#!/bin/bash
# Verified, relocatable runtimes; never replace the operating system interpreters.
NODE_VERSION=26.13.0
PYTHON_VERSION=3.14.10
PYTHON_BUILD=20261110

download_runtime() {
  local url=$1 checksum=$2 destination=$3
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --retry 3 --connect-timeout 15 --max-time 300 "$url" --output "$destination" || return
  if ! printf '%s  %s\n' "$checksum" "$destination" | sha256sum --check --status; then
    echo "Runtime checksum mismatch: $destination" >&2
    return 1
  fi
}

prepare_runtimes() {
  local destination=$1 node_arch python_arch node_hash python_hash
  case "$(uname -m)" in
    x86_64)
      node_arch=x64
      python_arch=x86_64
      node_hash=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
      python_hash=c2ff2e97422f5d3896a16e0317fd212ba977bbf2688d93a6f7a03d817506bd30
      ;;
    aarch64)
      node_arch=arm64
      python_arch=aarch64
      node_hash=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
      python_hash=38fd50f07170adc29d481913d1c30b17ecb538fbe290315fe1f83d84fdd5b694
      ;;
    *) echo 'Supported CPUs: x86-64 and ARM64' >&2; return 1 ;;
  esac
  local node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  local python_archive="cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-${python_arch}-unknown-linux-gnu-install_only_stripped.tar.gz"
  download_runtime "https://nodejs.org/download/release/v${NODE_VERSION}/${node_archive}" \
    "$node_hash" "$destination/node.tar.xz" || return
  download_runtime "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/${python_archive}" \
    "$python_hash" "$destination/python.tar.gz" || return
  mkdir "$destination/node" || return
  tar -xJf "$destination/node.tar.xz" -C "$destination/node" --strip-components=1 --no-same-owner || return
  tar -xzf "$destination/python.tar.gz" -C "$destination" --no-same-owner || return
  "$destination/node/bin/node" --version || return
  "$destination/python/bin/python3" -I -B -c 'import ssl, sqlite3, venv, ensurepip; import sys; print(sys.version)'
}
