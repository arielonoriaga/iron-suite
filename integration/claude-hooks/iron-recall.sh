#!/usr/bin/env bash
set -uo pipefail
IRON_BIN="${IRON_BIN:-$HOME/.local/bin/iron}"
IRON_DB="${IRON_DB:-$HOME/.local/share/iron/memory.db}"
input="$(cat)"
path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$path" ] && [ -n "$session" ] || exit 0
case "$path" in
  */MEMORY.md) exit 0 ;;
  */.claude/memory/projects/*.md|*/.claude/projects/*/memory/*.md|*/.claude/agent-memory/*.md) ;;
  *) exit 0 ;;
esac
if [ -x "$IRON_BIN" ] && [ -f "$IRON_DB" ]; then
  ( "$IRON_BIN" --db "$IRON_DB" memory recall --path "$path" --session "claude-$session" >/dev/null 2>&1 & )
elif [ -n "${IRON_REMOTE_HOST:-}" ]; then
  ( timeout 10 ssh -T -o BatchMode=yes -o ConnectTimeout=5 "$IRON_REMOTE_HOST" ".local/bin/iron memory recall --path $(printf '%q' "$path") --session $(printf '%q' "claude-$session")" >/dev/null 2>&1 & )
fi
exit 0
