#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="dist/OW Bridge.app"
NODE_BINARY="${NODE_BINARY:-$(command -v node)}"
if otool -L "$NODE_BINARY" | /usr/bin/grep -Eq '/opt/|@rpath'; then
  echo 'Use NODE_BINARY pointing to a standalone official Node binary (for example an nvm installation).' >&2
  exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O macos/App.swift -o "$APP/Contents/MacOS/OWBridge" -framework Cocoa
if [ -f "$APP/Contents/Resources/node" ]; then chmod u+w "$APP/Contents/Resources/node"; fi
cp "$NODE_BINARY" "$APP/Contents/Resources/node"
cp -R src "$APP/Contents/Resources/"
cp package.json "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>OW Bridge</string>
<key>CFBundleIdentifier</key><string>local.buddy.bridge</string>
<key>CFBundleExecutable</key><string>OWBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP/Contents/Resources/node"
codesign --force --sign - "$APP"
echo "Built: $PWD/$APP"
