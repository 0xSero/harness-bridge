#!/usr/bin/env bash
# Build the macOS menu bar app bundle. Requires Xcode command line tools (swiftc).
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found: install Xcode command line tools" >&2; exit 1; }

app="$here/dist/Local AI.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

# the Local AI mark, rendered from the same vector the plugin uses
iconset=$(mktemp -d)/AppIcon.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$here/assets/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$here/assets/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
cp "$here/assets/mark-256.png" "$app/Contents/Resources/LocalAIMark.png"

swiftc -O -o "$app/Contents/MacOS/harness-bridge-tray" "$here/Bridge.swift" "$here/MainView.swift" "$here/SettingsView.swift" "$here/App.swift" "$here/main.swift" -framework AppKit

cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Local AI</string>
  <key>CFBundleDisplayName</key><string>Local AI</string>
  <key>CFBundleIdentifier</key><string>sero.local-ai.tray</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
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

# a DMG with the app and a shortcut to Applications
dmg="$here/dist/Local AI.dmg"
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "Local AI" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
echo "built $dmg"
