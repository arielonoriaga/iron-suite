#!/usr/bin/env bash
set -euo pipefail

SRC_DB="${CAVEMEM_DB:-$HOME/.cavemem/data.db}"
REMOTE_HOST="${IRON_HUB_HOST:-desktop}"
REMOTE_DEST="${IRON_REMOTE_DEST:-.local/share/iron/sources/laptop-cavemem.db}"
REMOTE_BIN="${IRON_REMOTE_BIN:-.local/bin/iron}"

if [ -L "$SRC_DB" ]; then
  echo "iron-sync-laptop-cavemem: refusing symlink source: $SRC_DB" >&2
  exit 1
fi
[ -e "$SRC_DB" ] || exit 0
if [ ! -f "$SRC_DB" ] || [ ! -s "$SRC_DB" ]; then
  echo "iron-sync-laptop-cavemem: source must be a non-empty regular file: $SRC_DB" >&2
  exit 1
fi

umask 077
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/laptop-cavemem-XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
tmp_snap="$tmp_dir/snapshot.db"

python3 - "$SRC_DB" "$tmp_snap" << 'PY'
import sqlite3, sys, urllib.parse
uri = "file:" + urllib.parse.quote(sys.argv[1]) + "?mode=ro"
src = sqlite3.connect(uri, uri=True, timeout=15.0)
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst, pages=512, sleep=0.02)
dst.execute("PRAGMA journal_mode = DELETE")
rows = dst.execute("PRAGMA quick_check").fetchall()
tables = dst.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
dst.close()
src.close()
if rows != [("ok",)] or tables <= 0:
    raise SystemExit(f"local snapshot validation failed: quick_check={rows}, tables={tables}")
PY

snap_size="$(stat -c %s "$tmp_snap")"
if ! [[ "$snap_size" =~ ^[1-9][0-9]*$ ]]; then
  echo "iron-sync-laptop-cavemem: invalid snapshot size: $snap_size" >&2
  exit 1
fi
snap_sha="$(sha256sum "$tmp_snap" | cut -d' ' -f1)"

# shellcheck disable=SC2016
REMOTE_SCRIPT='
set -euo pipefail
umask 077
case "$1" in /*) dest="$1" ;; *) dest="$HOME/$1" ;; esac
case "$2" in /*) iron_bin="$2" ;; *) iron_bin="$HOME/$2" ;; esac
expected_size="$3"
expected_sha="$4"
if [ -L "$dest" ] || [ -d "$dest" ]; then
  echo "iron-sync-laptop-cavemem: refusing symlink or directory destination: $dest" >&2
  exit 1
fi
dest_dir="$(dirname "$dest")"
mkdir -p "$dest_dir"
chmod 700 "$dest_dir"
rtmp="$(mktemp "$dest_dir/.laptop-cavemem-XXXXXX.tmp")"
trap '\''rm -f -- "$rtmp"'\'' EXIT
cat > "$rtmp"
python3 -c '\''
import hashlib, os, sqlite3, sys, urllib.parse
path, exp_size, exp_sha = sys.argv[1], int(sys.argv[2]), sys.argv[3]
actual_size = os.path.getsize(path)
if actual_size <= 0 or actual_size != exp_size:
    raise SystemExit(f"remote snapshot size mismatch: got {actual_size}, expected {exp_size}")
h = hashlib.sha256()
with open(path, "rb") as fh:
    while chunk := fh.read(1048576):
        h.update(chunk)
actual_sha = h.hexdigest()
if actual_sha != exp_sha:
    raise SystemExit(f"remote snapshot sha256 mismatch: got {actual_sha}, expected {exp_sha}")
uri = "file:" + urllib.parse.quote(path) + "?mode=ro"
conn = sqlite3.connect(uri, uri=True)
rows = conn.execute("PRAGMA quick_check").fetchall()
tables = conn.execute("SELECT count(*) FROM sqlite_master WHERE type=\x27table\x27").fetchone()[0]
conn.close()
if rows != [("ok",)] or tables <= 0:
    raise SystemExit(f"remote snapshot validation failed: quick_check={rows}, tables={tables}")
'\'' "$rtmp" "$expected_size" "$expected_sha"
chmod 600 "$rtmp"
mv -f -- "$rtmp" "$dest"
trap - EXIT
"$iron_bin" memory import --cavemem-db "$dest" >/dev/null
'

ssh -T -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" \
  "bash -c $(printf '%q' "$REMOTE_SCRIPT") _ $(printf '%q' "$REMOTE_DEST") $(printf '%q' "$REMOTE_BIN") $(printf '%q' "$snap_size") $(printf '%q' "$snap_sha")" < "$tmp_snap"
