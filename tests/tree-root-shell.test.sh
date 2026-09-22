#!/usr/bin/env bash
# Asserts the tree-root shape: one environment above several checkouts, where
# the devenv root is not a Git checkout of its own. The nested repositories
# carry no devenv files, so direnv must walk up to the tree and every one of
# them must resolve the same project state.
set -euo pipefail

tree_path=${1:?tree root path is required}
checkout_path=${2:?nested checkout path is required}
tree="$(cd "$tree_path" && pwd -P)"
checkout="$(cd "$checkout_path" && pwd -P)"

cd "$tree"
devenv allow >/dev/null
cat > .envrc <<'EOF_ENVRC'
#!/usr/bin/env bash

eval "$(devenv direnvrc)"
use devenv
export TEST_TREE_MARKER=loaded
EOF_ENVRC
# Approve the fixture .envrc through the module-provided direnv binary.
devenv shell -- direnv allow >/dev/null

TREE="$tree" CHECKOUT="$checkout" devenv --shell bash shell <<'EOF'
set -euo pipefail

tree=$TREE
checkout=$CHECKOUT
state="$tree/.devenv/state"

assert_equal() {
  name=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

# The tree root is not a checkout, so it owns its state rather than deriving it
# from a Git common directory that does not exist.
assert_equal AGENTS_PROJECT_ROOT "$tree" "$AGENTS_PROJECT_ROOT"
assert_equal AGENTS_PROJECT_STATE "$state" "$AGENTS_PROJECT_STATE"
assert_equal AGENTS_SESSION "tree-session" "$AGENTS_SESSION"

# A tree root is not a worktree. Scoped services stay enabled there, because it
# is the single place the environment is entered from.
assert_equal TEST_SCOPED_SERVICE enabled "$TEST_SCOPED_SERVICE"

if [ "${AGENTS_WORKTREE+x}" = x ]; then
  printf 'AGENTS_WORKTREE must be unset at a tree root\n' >&2
  exit 1
fi

# The load-bearing behavior: a nested checkout with no devenv files of its own
# reaches the tree environment, because direnv walks up to the nearest .envrc.
assert_equal "nested marker" loaded "$(direnv exec "$checkout" printenv TEST_TREE_MARKER)"
assert_equal "nested AGENTS_PROJECT_ROOT" "$tree" \
  "$(direnv exec "$checkout" printenv AGENTS_PROJECT_ROOT)"
assert_equal "nested AGENTS_PROJECT_STATE" "$state" \
  "$(direnv exec "$checkout" printenv AGENTS_PROJECT_STATE)"

# Agent tooling resolves from inside the nested checkout, not only at the tree.
status_line_path="$(direnv exec "$checkout" bash -c 'command -v claude-status-line')"
assert_equal "nested status line path" "$DEVENV_DOTFILE/profile/bin/claude-status-line" "$status_line_path"

# The nested checkout is a repository in its own right; the shared environment
# must not make Git resolve it as part of the tree.
toplevel="$(direnv exec "$checkout" git -C "$checkout" rev-parse --show-toplevel)"
assert_equal "nested Git toplevel" "$checkout" "$toplevel"
EOF
