#!/usr/bin/env bash
# Build the macOS menu bar app. Requires Xcode command line tools (swiftc).
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found: install Xcode command line tools" >&2; exit 1; }
mkdir -p "$here/dist"
swiftc -O -o "$here/dist/harness-bridge-tray" "$here/main.swift" -framework AppKit
echo "built $here/dist/harness-bridge-tray"