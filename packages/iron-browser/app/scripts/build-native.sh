#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"

cargo build --release --manifest-path "$ROOT_DIR/Cargo.toml" -p iron-browser-bus --target-dir "$TARGET_DIR"

mkdir -p "$APP_DIR/dist/native"
DEST="$APP_DIR/dist/native/iron_browser_bus.node"
TMP_DEST="$APP_DIR/dist/native/.iron_browser_bus.node.tmp.$$.$RANDOM"

if [[ -f "$TARGET_DIR/release/libiron_browser_bus.so" ]]; then
  SRC="$TARGET_DIR/release/libiron_browser_bus.so"
elif [[ -f "$TARGET_DIR/release/libiron_browser_bus.dylib" ]]; then
  SRC="$TARGET_DIR/release/libiron_browser_bus.dylib"
elif [[ -f "$TARGET_DIR/release/iron_browser_bus.dll" ]]; then
  SRC="$TARGET_DIR/release/iron_browser_bus.dll"
else
  echo "build-native: compiled library not found in $TARGET_DIR/release" >&2
  exit 1
fi

# Atomic copy + rename(2) so running Electron processes that mmap'd the previous inode never SIGSEGV!
cp "$SRC" "$TMP_DEST"
chmod 0755 "$TMP_DEST"
mv -f "$TMP_DEST" "$DEST"
