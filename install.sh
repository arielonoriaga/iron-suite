#!/usr/bin/env bash
set -euo pipefail

REPO="${IRON_STACK_REPO:-${IRON_SUITE_REPO:-arielonoriaga/iron-stack}}"
INSTALL_BIN_DIR="${IRON_BIN_DIR:-$HOME/.local/bin}"
INSTALL_SHARE_DIR="${IRON_STACK_SHARE_DIR:-$HOME/.local/share/iron-stack}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
AGENTS_SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
INSTALL_SKILLS=1
INSTALL_BINARY=1
INSTALL_BROWSER=0
INSTALL_TERM=0
REGISTER_MCP=1

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install The Iron Stack (https://github.com/arielonoriaga/iron-stack):
  Default:
    - `iron` Rust CLI & stdio MCP memory server -> ~/.local/bin/iron
    - 10 Iron engineering, browser, design & maintenance skills (iron-design, iron-browser, irondev, iron-hunt, iron-audit, iron-debug, iron-perf, iron-maintain, ...)
    - 7 Iron subagent role definitions -> ~/.claude/agents/
    - Registers `iron-memory` MCP server in Claude Code (when `claude` CLI is present)

  Optional Stack Packages:
    --browser       Also build & install `packages/iron-browser` (dual-viewport Chromium + 26-tool `iron-browser-mcp`)
    --term          Also build & install `packages/iron-term` (native Rust + GPUI terminal, `iron-agentd`, `iron-termctl`)
    --all           Install everything (memory + skills + agents + iron-browser + iron-term)

  Other Options:
    --binary-only   Install only the `iron` binary
    --skills-only   Install only skills & subagent definitions
    --no-mcp        Do not auto-register MCP servers in Claude Code
    --help, -h      Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary-only) INSTALL_SKILLS=0 ;;
    --skills-only) INSTALL_BINARY=0; REGISTER_MCP=0 ;;
    --browser) INSTALL_BROWSER=1 ;;
    --term) INSTALL_TERM=1 ;;
    --all) INSTALL_BINARY=1; INSTALL_SKILLS=1; INSTALL_BROWSER=1; INSTALL_TERM=1 ;;
    --no-mcp) REGISTER_MCP=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}:${arch}" in
    Linux:x86_64)  printf 'x86_64-unknown-linux-gnu' ;;
    Linux:aarch64|Linux:arm64) printf 'aarch64-unknown-linux-gnu' ;;
    Darwin:arm64)  printf 'aarch64-apple-darwin' ;;
    Darwin:x86_64) printf 'x86_64-apple-darwin' ;;
    *) return 1 ;;
  esac
}

atomic_install_bin() {
  local src="$1"
  local name="$2"
  mkdir -p "$INSTALL_BIN_DIR"
  local staging="$INSTALL_BIN_DIR/.${name}.new.$$"
  cp "$src" "$staging"
  chmod 0755 "$staging"
  mv -f "$staging" "$INSTALL_BIN_DIR/$name"
}

TMP_WORK="$(mktemp -d)"
trap 'rm -rf "$TMP_WORK"' EXIT

resolve_source_tree() {
  if [[ -f "./Cargo.toml" && -d "./skills/irondev" ]]; then
    pwd
    return 0
  fi
  log "Downloading ${REPO} snapshot..." >&2
  curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" -o "$TMP_WORK/src.tar.gz"
  tar -xzf "$TMP_WORK/src.tar.gz" -C "$TMP_WORK"
  find "$TMP_WORK" -maxdepth 1 -type d \( -name 'iron-stack-*' -o -name 'iron-suite-*' \) | head -n 1
}

install_binary() {
  mkdir -p "$INSTALL_BIN_DIR"
  local target=""
  target="$(detect_target || true)"

  if [[ -n "$target" ]]; then
    local release_url="https://github.com/${REPO}/releases/latest/download/iron-${target}.tar.gz"
    if curl -fsSL "$release_url" -o "$TMP_WORK/iron.tar.gz" 2>/dev/null; then
      tar -xzf "$TMP_WORK/iron.tar.gz" -C "$TMP_WORK"
      if [[ -f "$TMP_WORK/iron" ]]; then
        atomic_install_bin "$TMP_WORK/iron" "iron"
        ok "Installed prebuilt iron (${target}) -> $INSTALL_BIN_DIR/iron"
        return 0
      fi
    fi
  fi

  local src_dir="$1"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Prebuilt binary not available for this platform and 'cargo' is not installed. Install Rust via https://rustup.rs first." >&2
    exit 1
  fi
  log "Building iron from source with Cargo (release profile)..."
  local target_dir="${CARGO_TARGET_DIR:-$HOME/.cache/cargo-targets/iron-stack-install}"
  mkdir -p "$target_dir"
  CARGO_TARGET_DIR="$target_dir" cargo build --release --locked --manifest-path "$src_dir/Cargo.toml"
  atomic_install_bin "$target_dir/release/iron" "iron"
  ok "Built & installed iron -> $INSTALL_BIN_DIR/iron"
}

install_skills_and_agents() {
  local src_dir="$1"
  mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/agents"
  local skill_path skill_name
  for skill_path in "$src_dir"/skills/*; do
    [[ -d "$skill_path" ]] || continue
    skill_name="$(basename "$skill_path")"
    rm -rf "${CLAUDE_DIR:?}/skills/${skill_name:?}"
    cp -R "$skill_path" "$CLAUDE_DIR/skills/$skill_name"
    if [[ -d "$HOME/.agents" ]]; then
      mkdir -p "$AGENTS_SKILLS_DIR"
      rm -rf "${AGENTS_SKILLS_DIR:?}/${skill_name:?}"
      cp -R "$skill_path" "$AGENTS_SKILLS_DIR/$skill_name"
    fi
  done
  ok "Installed 10 Iron skills -> $CLAUDE_DIR/skills/"

  local agent_file
  for agent_file in "$src_dir"/agents/iron-*.md; do
    [[ -f "$agent_file" ]] || continue
    install -m 0644 "$agent_file" "$CLAUDE_DIR/agents/$(basename "$agent_file")"
  done
  ok "Installed 7 Iron subagent roles -> $CLAUDE_DIR/agents/"
}

install_browser() {
  local src_dir="$1"
  local pkg_dir="$src_dir/packages/iron-browser"
  if [[ ! -d "$pkg_dir" ]]; then
    echo "packages/iron-browser not found under $src_dir" >&2
    exit 1
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "'bun' is required to build IronBrowser (https://bun.sh)." >&2
    exit 1
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "'cargo' is required to build IronBrowser's native Rust bus and MCP server (https://rustup.rs)." >&2
    exit 1
  fi

  # If running from a temporary curl snapshot, persist packages/iron-browser so symlinks remain valid after exit.
  local runtime_dir="$pkg_dir"
  if [[ "$src_dir" == "$TMP_WORK"* ]]; then
    runtime_dir="$INSTALL_SHARE_DIR/iron-browser"
    mkdir -p "$INSTALL_SHARE_DIR"
    rm -rf "${runtime_dir:?}"
    cp -R "$pkg_dir" "$runtime_dir"
  fi

  log "Building IronBrowser (app + Rust TabEventBus + 26-tool MCP server)..."
  local target_dir="${CARGO_TARGET_DIR:-$HOME/.cache/cargo-targets/iron-stack-browser}"
  mkdir -p "$target_dir"
  (
    cd "$runtime_dir/app"
    bun install
    CARGO_TARGET_DIR="$target_dir" bun run build
  )
  CARGO_TARGET_DIR="$target_dir" cargo build --release --manifest-path "$runtime_dir/Cargo.toml" -p iron-browser-mcp

  atomic_install_bin "$target_dir/release/iron-browser-mcp" "iron-browser-mcp"
  ln -sfn "$runtime_dir/bin/iron-browser" "$INSTALL_BIN_DIR/iron-browser"
  if [[ -x "$runtime_dir/packaging/install-desktop.sh" ]]; then
    IRON_BIN_DIR="$INSTALL_BIN_DIR" "$runtime_dir/packaging/install-desktop.sh" >/dev/null 2>&1 || true
  fi
  ok "Installed iron-browser + iron-browser-mcp -> $INSTALL_BIN_DIR/"
}

install_term() {
  local src_dir="$1"
  local pkg_dir="$src_dir/packages/iron-term"
  if [[ ! -d "$pkg_dir" ]]; then
    echo "packages/iron-term not found under $src_dir" >&2
    exit 1
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "'cargo' is required to build IronTerm (https://rustup.rs)." >&2
    exit 1
  fi

  log "Building IronTerm workspace (iron-term, iron-agentd, iron-termctl)..."
  local target_dir="${CARGO_TARGET_DIR:-$HOME/.cache/cargo-targets/iron-stack-term}"
  mkdir -p "$target_dir"
  CARGO_TARGET_DIR="$target_dir" cargo build --release --manifest-path "$pkg_dir/Cargo.toml" --workspace
  for bin in iron-term iron-agentd iron-termctl; do
    atomic_install_bin "$target_dir/release/$bin" "$bin"
  done
  if [[ -x "$pkg_dir/packaging/install-desktop.sh" ]]; then
    CARGO_TARGET_DIR="$target_dir" "$pkg_dir/packaging/install-desktop.sh" --no-build >/dev/null 2>&1 || true
  fi
  ok "Installed iron-term, iron-agentd, iron-termctl -> $INSTALL_BIN_DIR/"
}

register_mcp() {
  mkdir -p "$HOME/.local/share/iron"
  chmod 700 "$HOME/.local/share/iron"
  if [[ -d "$CLAUDE_DIR" && -x "$INSTALL_BIN_DIR/iron" ]]; then
    "$INSTALL_BIN_DIR/iron" --db "$HOME/.local/share/iron/memory.db" memory import --claude-root "$CLAUDE_DIR" >/dev/null 2>&1 || true
  fi
  if command -v claude >/dev/null 2>&1 && [[ -x "$INSTALL_BIN_DIR/iron" ]]; then
    if ! claude mcp get iron-memory >/dev/null 2>&1; then
      if claude mcp add-json iron-memory "{\"type\":\"stdio\",\"command\":\"$INSTALL_BIN_DIR/iron\",\"args\":[\"mcp\"]}" --scope user >/dev/null 2>&1; then
        ok "Registered iron-memory stdio MCP server in Claude Code"
      else
        warn "Run manually: claude mcp add-json iron-memory '{\"type\":\"stdio\",\"command\":\"$INSTALL_BIN_DIR/iron\",\"args\":[\"mcp\"]}' --scope user"
      fi
    else
      ok "iron-memory MCP already registered in Claude Code"
    fi
  fi
  if [[ "$INSTALL_BROWSER" -eq 1 ]] && command -v claude >/dev/null 2>&1 && [[ -x "$INSTALL_BIN_DIR/iron-browser-mcp" ]]; then
    if ! claude mcp get iron-browser >/dev/null 2>&1; then
      if claude mcp add-json iron-browser "{\"type\":\"stdio\",\"command\":\"$INSTALL_BIN_DIR/iron-browser-mcp\",\"args\":[]}" --scope user >/dev/null 2>&1; then
        ok "Registered iron-browser stdio MCP server in Claude Code"
      else
        warn "Run manually: claude mcp add-json iron-browser '{\"type\":\"stdio\",\"command\":\"$INSTALL_BIN_DIR/iron-browser-mcp\",\"args\":[]}' --scope user"
      fi
    else
      ok "iron-browser MCP already registered in Claude Code"
    fi
  fi
}

SRC_TREE="$(resolve_source_tree)"
[[ "$INSTALL_BINARY" -eq 1 ]]  && install_binary "$SRC_TREE"
[[ "$INSTALL_SKILLS" -eq 1 ]]  && install_skills_and_agents "$SRC_TREE"
[[ "$INSTALL_BROWSER" -eq 1 ]] && install_browser "$SRC_TREE"
[[ "$INSTALL_TERM" -eq 1 ]]    && install_term "$SRC_TREE"
[[ "$REGISTER_MCP" -eq 1 ]]    && register_mcp

log "The Iron Stack is ready. Ensure $INSTALL_BIN_DIR is on your PATH."
