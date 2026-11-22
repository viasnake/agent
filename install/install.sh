#!/bin/bash
set -euo pipefail

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$source_root/install/runtimes.sh"

usage() {
  cat <<'EOF'
Usage: bash install/install.sh [options]
  --data-dir PATH     Persistent data directory (default: /srv/agent-data)
  --listen IP         Listen address (default: 0.0.0.0)
  --origin URL        Exact loopback browser origin; repeat as needed
  --update            Update a stopped installation, preserving settings and data
  --hot-update        Update only the application after active work finishes
  --build-only        Download runtimes and build without sudo or installation
  -h, --help          Show this help without downloading or changing anything

Run as a regular user on prepared Ubuntu Server 26.04. Installation uses sudo
for OS dependencies, dedicated runtime deployment and systemd service startup.
Stop agent.service explicitly before --update. --hot-update requires a running
installation with hot update support. Storage is never created or mounted.
EOF
}

build_only=0
update=0
hot_update=0
install_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --build-only) build_only=1; shift ;;
    --update) update=1; install_args+=("$1"); shift ;;
    --hot-update) hot_update=1; install_args+=("$1"); shift ;;
    --data-dir|--listen|--origin)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "Missing value for $1" >&2
        exit 64
      fi
      install_args+=("$1" "$2")
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
if [[ "$build_only" == 1 && ${#install_args[@]} -ne 0 ]]; then
  echo '--build-only cannot be combined with installation options' >&2
  exit 64
fi
if [[ ( "$update" == 1 || "$hot_update" == 1 ) && ${#install_args[@]} -ne 1 ]]; then
  echo 'Update modes cannot be combined with other installation options' >&2
  exit 64
fi
case "$(uname -sm)" in
  'Linux x86_64'|'Linux aarch64') ;;
  *) echo 'A Linux x86-64 or ARM64 host is required' >&2; exit 1 ;;
esac

if [[ "$build_only" == 0 ]]; then
  if [[ "$(id -u)" == 0 ]]; then
    echo 'Run without sudo; the installer requests sudo only for system changes' >&2
    exit 1
  fi
  source /etc/os-release
  if [[ "$ID" != ubuntu || "$VERSION_ID" != 26.04 || ! -d /run/systemd/system ]]; then
    echo 'A running Ubuntu Server 26.04 systemd host is required' >&2
    exit 1
  fi
  if [[ "$hot_update" == 0 ]]; then
    sudo -v
    if sudo /usr/bin/systemctl is-active --quiet agent.service; then
      echo 'Stop agent.service explicitly before installation or update' >&2
      exit 1
    fi
    sudo /usr/bin/apt-get update
    sudo /usr/bin/apt-get install -y ca-certificates curl xz-utils openssl nftables sudo util-linux procps openssh-client acl
  fi
fi
if [[ "$hot_update" == 1 ]]; then
  export PATH="/opt/agent-node/bin:/opt/agent-python/bin:/usr/bin:/bin"
else
  for binary in curl tar xz sha256sum; do
    command -v "$binary" >/dev/null || { echo "Missing dependency: $binary" >&2; exit 1; }
  done
  runtime_root="$(mktemp -d)"
  trap 'rm -rf -- "${runtime_root:?}"' EXIT
  prepare_runtimes "$runtime_root"
  export PATH="$runtime_root/node/bin:$runtime_root/python/bin:/usr/bin:/bin"
fi
unset NODE_OPTIONS NODE_PATH PYTHONHOME PYTHONPATH
if [[ "$hot_update" == 1 ]]; then
  if [[ ! -f /opt/agent/dist/src/deploy.js ]]; then
    echo 'Install a version with hot update support using --update first' >&2
    exit 1
  fi
  if [[ "$(/opt/agent-node/bin/node --version)" != "v$NODE_VERSION" ||
      "$(/opt/agent-python/bin/python3 --version)" != "Python $PYTHON_VERSION" ]]; then
    echo 'Installed runtime versions differ; use a stopped update' >&2
    exit 1
  fi
fi
cd "$source_root"
# The pinned Node.js already supplies the DOMException used by fetch-blob.
npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier --no-color 2>&1 |
  sed -u "/^npm warn deprecated node-domexception@1\.0\.0: Use your platform's native DOMException instead$/d"
npm --no-update-notifier run build
if [[ "$build_only" == 1 ]]; then
  echo 'Build complete; no installation or service changes were made'
  exit 0
fi

if [[ "$hot_update" == 1 ]]; then
  sudo /opt/agent-python/bin/python3 -E -s -B /opt/agent/install/install.py "$source_root" --hot-update
  echo 'Agent application updated.'
  exit 0
fi

sudo "$runtime_root/python/bin/python3" -E -s -B "$source_root/install/install.py" \
  "$source_root" "$runtime_root/node" "$runtime_root/python" "${install_args[@]}"
if [[ "$update" == 1 ]]; then
  sudo /usr/bin/systemctl start agent.service
else
  sudo /usr/bin/systemctl enable --now agent.service
fi
echo 'Installed. Open the configured local browser URL, using SSH forwarding if needed.'
