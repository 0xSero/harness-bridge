#!/usr/bin/env bash
# Build the macOS menu bar app bundle. Requires Xcode command line tools (swiftc).
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found: install Xcode command line tools" >&2; exit 1; }

app="$here/dist/Local AI.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"

swiftc -O -o "$app/Contents/MacOS/harness-bridge-tray" "$here/Bridge.swift" "$here/MainView.swift" "$here/SettingsView.swift" "$here/App.swift" "$here/main.swift" -framework AppKit

cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Local AI</string>
  <key>CFBundleDisplayName</key><string>Local AI</string>
  <key>CFBundleIdentifier</key><string>sero.local-ai.tray</string>
  <key>CFBundleExecutable</key><string>harness-bridge-tray</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- menu bar only: no Dock icon, no window -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "built $app"