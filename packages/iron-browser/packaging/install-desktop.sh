#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

LOCAL_BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_256_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
ICON_SVG_DIR="$DATA_HOME/icons/hicolor/scalable/apps"

mkdir -p "$LOCAL_BIN" "$APPS_DIR" "$ICON_256_DIR" "$ICON_SVG_DIR"

ln -sfn "$ROOT_DIR/bin/iron-browser" "$LOCAL_BIN/iron-browser"
if [[ -x "$ROOT_DIR/target/release/iron-browser-mcp" ]]; then
  ln -sfn "$ROOT_DIR/target/release/iron-browser-mcp" "$LOCAL_BIN/iron-browser-mcp"
fi

install -m 0644 "$ROOT_DIR/packaging/iron-browser.png" "$ICON_256_DIR/iron-browser.png"
install -m 0644 "$ROOT_DIR/packaging/iron-browser.svg" "$ICON_SVG_DIR/iron-browser.svg"

cat > "$APPS_DIR/iron-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=IronBrowser
GenericName=Dual-Viewport Developer Browser
Comment=Site-agnostic Zen Chromium browser with simultaneous Portrait + Landscape viewports, mirrored interaction, live telemetry, and native MCP
TryExec=$LOCAL_BIN/iron-browser
Exec=$LOCAL_BIN/iron-browser %U
Icon=iron-browser
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=iron-browser
StartupNotify=true
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
Keywords=browser;iron-browser;devtools;responsive;portrait;landscape;mcp;iron;
EOF
chmod 0644 "$APPS_DIR/iron-browser.desktop"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS_DIR/iron-browser.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed IronBrowser launcher:"
echo "  Binary:  $LOCAL_BIN/iron-browser -> $(readlink -f "$LOCAL_BIN/iron-browser")"
echo "  Desktop: $APPS_DIR/iron-browser.desktop"
echo "  Icons:   $ICON_SVG_DIR/iron-browser.svg, $ICON_256_DIR/iron-browser.png"
