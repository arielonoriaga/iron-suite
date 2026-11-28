#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

NO_BUILD=0
BIN_DIR=""

usage() {
  cat <<'EOF'
Usage: install-desktop.sh [--no-build] [--bin-dir <DIR>] [-h|--help]

Builds (unless --no-build) and installs IronTerm binaries, hicolor icons,
and XDG desktop launcher entry into XDG_BIN_HOME and XDG_DATA_HOME.

Options:
  --no-build        Skip cargo release build and install existing binaries
  --bin-dir <DIR>   Directory containing prebuilt iron-term, iron-agentd, iron-termctl
  -h, --help        Show this help message and exit

Environment:
  XDG_BIN_HOME      Target binary directory (default: ~/.local/bin)
  XDG_DATA_HOME     Target XDG data directory (default: ~/.local/share)
  CARGO_TARGET_DIR  Cargo target directory (default: <repo>/target)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --bin-dir)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --bin-dir requires a directory path" >&2
        exit 1
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

LOCAL_BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_256_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
ICON_SVG_DIR="$DATA_HOME/icons/hicolor/scalable/apps"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
RELEASE_DIR="$TARGET_DIR/release"

mkdir -p "$LOCAL_BIN" "$APPS_DIR" "$ICON_256_DIR" "$ICON_SVG_DIR"

if [[ "$NO_BUILD" -eq 0 ]]; then
  (cd "$ROOT_DIR" && cargo build --release --workspace)
fi

resolve_binary() {
  local bin="$1"
  if [[ -n "$BIN_DIR" ]]; then
    if [[ -x "$BIN_DIR/$bin" ]]; then
      printf '%s\n' "$BIN_DIR/$bin"
      return 0
    fi
    return 1
  fi

  if [[ -x "$RELEASE_DIR/$bin" ]]; then
    printf '%s\n' "$RELEASE_DIR/$bin"
    return 0
  fi

  if [[ "$NO_BUILD" -eq 1 ]]; then
    if [[ -x "$LOCAL_BIN/$bin" ]]; then
      printf '%s\n' "$LOCAL_BIN/$bin"
      return 0
    fi
    local from_path
    from_path="$(command -v "$bin" 2>/dev/null || true)"
    if [[ -n "$from_path" && -x "$from_path" ]]; then
      printf '%s\n' "$from_path"
      return 0
    fi
  fi

  return 1
}

for bin in iron-term iron-agentd iron-termctl; do
  if ! src_bin="$(resolve_binary "$bin")"; then
    echo "error: could not locate executable '$bin' (checked ${BIN_DIR:-$RELEASE_DIR})" >&2
    exit 1
  fi
  dst_bin="$LOCAL_BIN/$bin"
  if ! [[ "$src_bin" -ef "$dst_bin" ]]; then
    install -m 0755 "$src_bin" "$dst_bin"
  fi
done

install -m 0644 "$ROOT_DIR/packaging/iron-term.png" "$ICON_256_DIR/iron-term.png"
install -m 0644 "$ROOT_DIR/packaging/iron-term.svg" "$ICON_SVG_DIR/iron-term.svg"

escape_desktop_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s// /\\s}"
  printf '%s' "$s"
}

escape_desktop_exec_arg() {
  local s="$1"
  if [[ "$s" =~ [[:space:]\"\'\\\>\<\~\|\&\;\$\*\?\#\(\)\`%] ]]; then
    s="${s//\\/\\\\\\\\}"
    s="${s//\"/\\\\\"}"
    s="${s//\$/\\\\\$}"
    s="${s//\`/\\\\\`}"
    s="${s//%/%%}"
    printf '"%s"' "$s"
  else
    printf '%s' "$s"
  fi
}

TRY_EXEC_VAL="$(escape_desktop_string "$LOCAL_BIN/iron-term")"
EXEC_BIN_VAL="$(escape_desktop_exec_arg "$LOCAL_BIN/iron-term")"

TRY_EXEC="$TRY_EXEC_VAL" EXEC_BIN="$EXEC_BIN_VAL" awk '
  /^TryExec=/ { print "TryExec=" ENVIRON["TRY_EXEC"]; next }
  /^Exec=iron-term$/ { print "Exec=" ENVIRON["EXEC_BIN"]; next }
  /^Exec=iron-term --new-session$/ { print "Exec=" ENVIRON["EXEC_BIN"] " --new-session"; next }
  { print }
' "$ROOT_DIR/packaging/iron-term.desktop" > "$APPS_DIR/iron-term.desktop"
chmod 0644 "$APPS_DIR/iron-term.desktop"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS_DIR/iron-term.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed IronTerm launcher:"
echo "  Binaries: $LOCAL_BIN/{iron-term,iron-agentd,iron-termctl}"
echo "  Desktop:  $APPS_DIR/iron-term.desktop"
echo "  Icons:    $ICON_SVG_DIR/iron-term.svg, $ICON_256_DIR/iron-term.png"
