#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${IRON_DB_PATH:-$HOME/.local/share/iron/memory.db}"
BACKUP_DIR="${IRON_BACKUP_DIR:-$HOME/.local/share/iron/backups}"
STORAGE_ROOT="${IRON_STORAGE_BACKUP_ROOT:-}"
STICK_ROOT="${IRON_STICK_BACKUP_ROOT:-}"
GIT_VAULT="${IRON_GIT_VAULT:-$HOME/.local/share/iron/git-vault}"
IRON_BIN="${IRON_BIN:-$HOME/.local/bin/iron}"
GITLEAKS_BIN="${GITLEAKS_BIN:-$HOME/.local/bin/gitleaks}"
KEEP_COUNT="${IRON_BACKUP_KEEP:-14}"

if ! [[ "$KEEP_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "iron-memory-backup: IRON_BACKUP_KEEP must be a positive integer, got '$KEEP_COUNT'" >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%F)"
dest="$BACKUP_DIR/iron-auto-${stamp}.db"

"$IRON_BIN" --db "$DB_PATH" memory backup --output "$dest" >/dev/null
"$IRON_BIN" --db "$dest" memory stats >/dev/null

prune_by_mtime() {
  local dir="$1" pattern="$2"
  local -a entries=()
  mapfile -d '' -t entries < <(find "$dir" -maxdepth 1 -type f -name "$pattern" -printf '%T@\t%p\0' | sort -zrn | cut -zf2-)
  if (( ${#entries[@]} > KEEP_COUNT )); then
    for old_f in "${entries[@]:KEEP_COUNT}"; do
      rm -f -- "$old_f"
    done
  fi
}

prune_by_mtime "$BACKUP_DIR" 'iron-auto-*.db'

mirror_db() {
  local target_dir="$1"
  local tmp_file="$target_dir/.iron-${day}-$$.db.tmp"
  mkdir -p "$target_dir" || return 1
  chmod 700 "$target_dir" || return 1
  if ! { cp -f -- "$dest" "$tmp_file" \
    && chmod 600 "$tmp_file" \
    && "$IRON_BIN" --db "$tmp_file" memory stats >/dev/null \
    && mv -f -- "$tmp_file" "$target_dir/iron-${day}.db"; }; then
    rm -f -- "$tmp_file"
    return 1
  fi
  local -a dated=()
  mapfile -d '' -t dated < <(find "$target_dir" -maxdepth 1 -type f -name 'iron-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].db' -print0 | sort -zr)
  if (( ${#dated[@]} > KEEP_COUNT )); then
    for old_d in "${dated[@]:KEEP_COUNT}"; do
      rm -f -- "$old_d"
    done
  fi
}

if [ -n "$STORAGE_ROOT" ]; then
  storage_parent="$(dirname "$STORAGE_ROOT")"
  if [ -d "$storage_parent" ] && [ -w "$storage_parent" ]; then
    mirror_db "$STORAGE_ROOT"
  fi
fi

if [ "${IRON_MIRROR_STICK:-0}" = "1" ] && [ -n "$STICK_ROOT" ]; then
  stick_parent="$(dirname "$STICK_ROOT")"
  if [ -d "$stick_parent" ] && [ -w "$stick_parent" ]; then
    if ! mirror_db "$STICK_ROOT"; then
      echo "iron-memory-backup: warning: stick mirror to $STICK_ROOT failed" >&2
    fi
  fi
fi

if [ -d "$GIT_VAULT/.git" ]; then
  stage_dir="$(mktemp -d)"
  trap 'rm -rf "$stage_dir"' EXIT
  mkdir -p "$stage_dir/scan"
  "$IRON_BIN" --db "$dest" memory export --scope native --output "$stage_dir/scan/memories.jsonl" >/dev/null
  "$IRON_BIN" --db "$dest" memory export --scope summaries --output "$stage_dir/scan/session-summaries.jsonl" >/dev/null

  GITLEAKS_CFG="${IRON_GITLEAKS_CONFIG:-$HOME/.config/iron/gitleaks-export.toml}"
  if [ -f "$GITLEAKS_CFG" ]; then
    "$GITLEAKS_BIN" dir --no-banner --redact=100 --config "$GITLEAKS_CFG" "$stage_dir/scan" >/dev/null
  else
    "$GITLEAKS_BIN" dir --no-banner --redact=100 "$stage_dir/scan" >/dev/null
  fi

  gzip -9 -n -c "$stage_dir/scan/session-summaries.jsonl" > "$stage_dir/session-summaries.jsonl.gz"
  "$IRON_BIN" --db "$dest" memory stats | jq -S '{schema_version, records, bodies, links, by_source_type}' > "$stage_dir/stats.json"

  if git -C "$GIT_VAULT" remote get-url origin >/dev/null 2>&1; then
    git -C "$GIT_VAULT" fetch -q origin main
    git -C "$GIT_VAULT" merge --ff-only origin/main >/dev/null
  fi

  mkdir -p "$GIT_VAULT/native" "$GIT_VAULT/summaries"
  install -m 600 "$stage_dir/scan/memories.jsonl" "$GIT_VAULT/native/memories.jsonl"
  install -m 600 "$stage_dir/session-summaries.jsonl.gz" "$GIT_VAULT/summaries/session-summaries.jsonl.gz"
  install -m 600 "$stage_dir/stats.json" "$GIT_VAULT/stats.json"

  if [ -n "$(git -C "$GIT_VAULT" status --porcelain)" ]; then
    git -C "$GIT_VAULT" add -- native/memories.jsonl summaries/session-summaries.jsonl.gz stats.json
    [ -f "$GIT_VAULT/README.md" ] && git -C "$GIT_VAULT" add -- README.md
    if ! git -C "$GIT_VAULT" diff --cached --quiet; then
      git -C "$GIT_VAULT" commit -q -m "chore(memories): sync native records and redacted session summaries ($day)"
      git -C "$GIT_VAULT" push -q origin main
    fi
  fi
fi
