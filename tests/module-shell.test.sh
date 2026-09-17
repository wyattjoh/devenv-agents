#!/usr/bin/env bash
set -euo pipefail

main_path=${1:?main checkout path is required}
worktree_path=${2:?worktree path is required}
main="$(cd "$main_path" && pwd -P)"
worktree="$(cd "$worktree_path" && pwd -P)"

# Linux replaces these with absolute host-layer paths; Darwin preserves them.
caller_claude_config_dir=${CLAUDE_CONFIG_DIR:?CLAUDE_CONFIG_DIR is required}
caller_gh_config_dir=${GH_CONFIG_DIR:?GH_CONFIG_DIR is required}
caller_pi_coding_agent_dir=${PI_CODING_AGENT_DIR:?PI_CODING_AGENT_DIR is required}

cd "$worktree"
devenv allow >/dev/null
cat > .envrc <<'EOF_ENVRC'
#!/usr/bin/env bash

eval "$(devenv direnvrc)"
use devenv
export TEST_DIRENV_MARKER=loaded
EOF_ENVRC
# Approve the fixture .envrc through the module-provided direnv binary.
devenv shell -- direnv allow >/dev/null

MAIN="$main" \
  WORKTREE="$worktree" \
  EXPECTED_CLAUDE_CONFIG_DIR="$caller_claude_config_dir" \
  EXPECTED_GH_CONFIG_DIR="$caller_gh_config_dir" \
  EXPECTED_PI_CODING_AGENT_DIR="$caller_pi_coding_agent_dir" \
  devenv --shell bash shell <<'EOF'
set -euo pipefail

main=$MAIN
worktree=$WORKTREE
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

if ! command -v direnv >/dev/null; then
  printf 'direnv must be provided by the shared module\n' >&2
  exit 1
fi
if ! declare -F _direnv_hook >/dev/null; then
  printf 'direnv Bash hook must be enabled by the shared module\n' >&2
  exit 1
fi
claude_path="$(direnv exec "$worktree" bash -c 'command -v claude')"
assert_equal "direnv Claude Code path" "$DEVENV_DOTFILE/profile/bin/claude" "$claude_path"
# Pi and the status line come from the shared module too, so a consumer that
# declares neither still resolves both out of the project profile.
pi_path="$(direnv exec "$worktree" bash -c 'command -v pi')"
assert_equal "direnv Pi path" "$DEVENV_DOTFILE/profile/bin/pi" "$pi_path"
status_line_path="$(direnv exec "$worktree" bash -c 'command -v claude-status-line')"
assert_equal "direnv status line path" "$DEVENV_DOTFILE/profile/bin/claude-status-line" "$status_line_path"
# The Herdr Claude integration hook execs python3. Without it the hook exits
# silently and a running Claude is never reported as an agent.
if ! direnv exec "$worktree" bash -c 'command -v python3 >/dev/null'; then
  printf 'python3 must resolve through direnv exec\n' >&2
  exit 1
fi

# Exercise the hook in this same long-lived Bash process, rather than checking
# an exported function in a child shell. A prompt cycle must load the .envrc
# marker in place as the pane changes into the worktree.
unset TEST_DIRENV_MARKER
cd "$main"
eval "${PROMPT_COMMAND[*]:-}"
if [ "${TEST_DIRENV_MARKER+x}" = x ]; then
  printf 'direnv marker must be unloaded outside the worktree\n' >&2
  exit 1
fi
cd "$worktree"
eval "${PROMPT_COMMAND[*]:-}"
assert_equal TEST_DIRENV_MARKER loaded "${TEST_DIRENV_MARKER:-}"

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
    assert_equal CLAUDE_CONFIG_DIR "$EXPECTED_CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR"
    assert_equal GH_CONFIG_DIR "$EXPECTED_GH_CONFIG_DIR" "$GH_CONFIG_DIR"
    assert_equal PI_CODING_AGENT_DIR "$EXPECTED_PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_DIR"
    ;;
  *)
    printf 'unsupported test platform: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac

# Check the environment through direnv's evaluated exec path, not only the
# variables already present in the devenv shell.
assert_equal "direnv CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR" "$(direnv exec "$worktree" printenv CLAUDE_CONFIG_DIR)"
assert_equal "direnv GH_CONFIG_DIR" "$GH_CONFIG_DIR" "$(direnv exec "$worktree" printenv GH_CONFIG_DIR)"
assert_equal "direnv PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_DIR" "$(direnv exec "$worktree" printenv PI_CODING_AGENT_DIR)"
EOF

cd "$main"
MAIN="$main" devenv --shell bash shell <<'EOF'
set -euo pipefail

main=$MAIN
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
