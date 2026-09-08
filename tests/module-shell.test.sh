#!/usr/bin/env bash
set -euo pipefail

main_path=${1:?main checkout path is required}
worktree_path=${2:?worktree path is required}
main="$(cd "$main_path" && pwd -P)"
worktree="$(cd "$worktree_path" && pwd -P)"

# Keep the Darwin absence check independent of the caller's environment.
unset PI_CODING_AGENT_DIR

cd "$worktree"
devenv allow >/dev/null

devenv shell -- bash -s -- "$main" "$worktree" <<'EOF'
set -euo pipefail

main=$1
worktree=$2
state="$main/.devenv/state"

assert_equal() {
  name=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_equal AGENTS_PROJECT_ROOT "$main" "$AGENTS_PROJECT_ROOT"
assert_equal AGENTS_PROJECT_STATE "$state" "$AGENTS_PROJECT_STATE"
assert_equal AGENTS_WORKTREE "$(basename "$worktree")" "$AGENTS_WORKTREE"
assert_equal AGENTS_SESSION "fixture-session" "$AGENTS_SESSION"
assert_equal RUSTUP_HOME "$state/rustup" "$RUSTUP_HOME"
assert_equal CARGO_HOME "$state/cargo" "$CARGO_HOME"
assert_equal NPM_CONFIG_PREFIX "$state/npm" "$NPM_CONFIG_PREFIX"
assert_equal NPM_CONFIG_CACHE "$state/npm-cache" "$NPM_CONFIG_CACHE"
assert_equal BUN_INSTALL "$state/bun" "$BUN_INSTALL"
assert_equal DENO_DIR "$state/deno" "$DENO_DIR"
assert_equal DISABLE_AUTOUPDATER "1" "$DISABLE_AUTOUPDATER"
assert_equal CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD "1" "$CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"
assert_equal TEST_SCOPED_SERVICE "disabled" "$TEST_SCOPED_SERVICE"

IFS=: read -r path_profile path_cargo path_npm path_bun path_rest <<< "$PATH"
assert_equal PATH[0] "$DEVENV_DOTFILE/profile/bin" "$path_profile"
assert_equal PATH[1] "$CARGO_HOME/bin" "$path_cargo"
assert_equal PATH[2] "$NPM_CONFIG_PREFIX/bin" "$path_npm"
assert_equal PATH[3] "$BUN_INSTALL/bin" "$path_bun"

case "$(uname -s)" in
  Linux)
    assert_equal CLAUDE_CONFIG_DIR "$HOME/.local/share/agents/claude" "$CLAUDE_CONFIG_DIR"
    assert_equal GH_CONFIG_DIR "$HOME/.local/share/agents/gh" "$GH_CONFIG_DIR"
    assert_equal PI_CODING_AGENT_DIR "$HOME/.local/share/agents/pi" "$PI_CODING_AGENT_DIR"
    ;;
  Darwin)
    if [ "${CLAUDE_CONFIG_DIR+x}" = x ] || [ "${GH_CONFIG_DIR+x}" = x ] || [ "${PI_CODING_AGENT_DIR+x}" = x ]; then
      printf 'Claude, gh, and Pi config paths must remain unset on Darwin\n' >&2
      exit 1
    fi
    ;;
  *)
    printf 'unsupported test platform: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac
EOF

cd "$main"
devenv shell -- bash -s -- "$main" <<'EOF'
set -euo pipefail

main=$1
state="$main/.devenv/state"

if [ "${AGENTS_WORKTREE+x}" = x ]; then
  printf 'AGENTS_WORKTREE must be unset in the main checkout\n' >&2
  exit 1
fi

if [ "$AGENTS_PROJECT_ROOT" != "$main" ]; then
  printf 'AGENTS_PROJECT_ROOT: expected %s, got %s\n' "$main" "$AGENTS_PROJECT_ROOT" >&2
  exit 1
fi
if [ "$AGENTS_PROJECT_STATE" != "$state" ]; then
  printf 'AGENTS_PROJECT_STATE: expected %s, got %s\n' "$state" "$AGENTS_PROJECT_STATE" >&2
  exit 1
fi
if [ "$TEST_SCOPED_SERVICE" != enabled ]; then
  printf 'TEST_SCOPED_SERVICE: expected enabled, got %s\n' "$TEST_SCOPED_SERVICE" >&2
  exit 1
fi
EOF
