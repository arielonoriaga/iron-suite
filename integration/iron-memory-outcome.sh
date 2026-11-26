#!/usr/bin/env bash
# Record a pass/fail/correction outcome into Iron Memory (local store or SSH hub). Fail-open.
# Usage: iron-memory-outcome.sh <pass|fail|correction> [project] [note]
set -uo pipefail
outcome="${1:-}"
project="${2:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
note="${3:-}"
case "$outcome" in
  pass|fail|correction) ;;
  *) echo "usage: iron-memory-outcome.sh <pass|fail|correction> [project] [note]" >&2; exit 2 ;;
esac

if [ -x "$HOME/.local/bin/iron" ] && [ -f "$HOME/.local/share/iron/memory.db" ]; then
  "$HOME/.local/bin/iron" memory outcome --outcome "$outcome" --project "$project" ${note:+--note "$note"} >/dev/null 2>&1 || true
elif [ -n "${IRON_SSH_HUB:-}" ]; then
  python3 -c 'import shlex, subprocess, sys
cmd = [".local/bin/iron", "memory", "outcome", "--outcome", sys.argv[2], "--project", sys.argv[3]]
if sys.argv[4]:
    cmd += ["--note", sys.argv[4]]
subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sys.argv[1], " ".join(shlex.quote(x) for x in cmd)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)' "$IRON_SSH_HUB" "$outcome" "$project" "$note" >/dev/null 2>&1 || true
fi
exit 0
