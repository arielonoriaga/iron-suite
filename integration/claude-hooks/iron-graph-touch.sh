#!/usr/bin/env bash
set -uo pipefail
IRON_BIN="${IRON_BIN:-$HOME/.local/bin/iron}"
IRON_DB="${IRON_DB:-$HOME/.local/share/iron/memory.db}"
input="$(cat)"
path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$path" ] || exit 0
case "$path" in
  *.rs|*.ts|*.tsx) ;;
  *) exit 0 ;;
esac
[ -x "$IRON_BIN" ] && [ -f "$(dirname "$IRON_DB")/graph.db" ] || exit 0
impact="$(timeout 2 "$IRON_BIN" --db "$IRON_DB" memory graph touch "$path" 2>/dev/null | head -c 300)"
[ -n "$impact" ] || exit 0
jq -cn --arg ctx "$impact" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
