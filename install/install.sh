#!/bin/sh
set -eu
exec /usr/bin/python3 "$(dirname "$(realpath "$0")")/install.py" "$@"
