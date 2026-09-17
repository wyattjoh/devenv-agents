{ inputs, pkgs, lib, config, ... }:
let
  root = toString config.devenv.root;
  # A linked worktree has a `.git` file, while the main checkout has `.git/config`.
  isWorktree = !(builtins.pathExists "${root}/.git/config");
  declaration =
    if builtins.pathExists "${root}/.agents/project.toml" then
      builtins.fromTOML (builtins.readFile "${root}/.agents/project.toml")
    else
      { };
  scoped = declaration.services.scoped or [ ];
  homeDirectory = builtins.getEnv "HOME";
  project = inputs.agents.packages.${pkgs.stdenv.hostPlatform.system}.project;
in
{
  options.agents.session = lib.mkOption {
    type = lib.types.str;
    default = declaration.session or (baseNameOf root);
  };

  config = lib.mkMerge [
    {
      packages = [ project pkgs.git pkgs.just pkgs.gh pkgs.claude-code pkgs.direnv ];
      env.AGENTS_SESSION = config.agents.session;
      env.DISABLE_AUTOUPDATER = "1";
      env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";

      enterShell = ''
        # Install direnv's hook in the long-lived Bash process entered by devenv.
        eval "$(direnv hook bash)"
        common="$(git rev-parse --path-format=absolute --git-common-dir)"
        main="$(dirname "$common")"
        root="$(cd "$DEVENV_ROOT" && pwd -P)"
        export AGENTS_PROJECT_ROOT="$main"
        export AGENTS_PROJECT_STATE="$main/.devenv/state"
        if [ "$main" = "$root" ]; then
          unset AGENTS_WORKTREE
        else
          export AGENTS_WORKTREE="$(basename "$root")"
        fi
        export RUSTUP_HOME="$AGENTS_PROJECT_STATE/rustup"
        export CARGO_HOME="$AGENTS_PROJECT_STATE/cargo"
        export NPM_CONFIG_PREFIX="$AGENTS_PROJECT_STATE/npm"
        export NPM_CONFIG_CACHE="$AGENTS_PROJECT_STATE/npm-cache"
        export BUN_INSTALL="$AGENTS_PROJECT_STATE/bun"
        export DENO_DIR="$AGENTS_PROJECT_STATE/deno"
        mkdir -p "$RUSTUP_HOME" "$CARGO_HOME" "$NPM_CONFIG_PREFIX" "$NPM_CONFIG_CACHE" "$BUN_INSTALL" "$DENO_DIR"
        # Keep this stable path first so rebuilt profiles reach running processes.
        export PATH="$DEVENV_DOTFILE/profile/bin:$CARGO_HOME/bin:$NPM_CONFIG_PREFIX/bin:$BUN_INSTALL/bin:$PATH"
        [ -f "$AGENTS_PROJECT_STATE/references.env" ] && . "$AGENTS_PROJECT_STATE/references.env"
      '';


      # Invariants every consumer of this module gets for free through
      # `devenv test`. Only module-guaranteed behavior belongs here; fixture
      # specifics (scoped services, the direnv prompt cycle, caller-preserved
      # Darwin config paths) stay in tests/module-shell.test.sh.
      enterTest = ''
        assert_equal() {
          if [ "$3" != "$2" ]; then
            printf '%s: expected %s, got %s\n' "$1" "$2" "$3" >&2
            exit 1
          fi
        }

        common="$(git rev-parse --path-format=absolute --git-common-dir)"
        main="$(dirname "$common")"
        root="$(cd "$DEVENV_ROOT" && pwd -P)"
        state="$main/.devenv/state"

        assert_equal AGENTS_PROJECT_ROOT "$main" "$AGENTS_PROJECT_ROOT"
        assert_equal AGENTS_PROJECT_STATE "$state" "$AGENTS_PROJECT_STATE"
        assert_equal DISABLE_AUTOUPDATER 1 "$DISABLE_AUTOUPDATER"
        assert_equal CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD 1 \
          "$CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"

        if [ -z "''${AGENTS_SESSION:-}" ]; then
          printf 'AGENTS_SESSION must be set\n' >&2
          exit 1
        fi

        # A linked worktree names itself; the main checkout leaves it unset.
        if [ "$main" = "$root" ]; then
          if [ "''${AGENTS_WORKTREE+x}" = x ]; then
            printf 'AGENTS_WORKTREE must be unset in the main checkout\n' >&2
            exit 1
          fi
        else
          assert_equal AGENTS_WORKTREE "$(basename "$root")" "''${AGENTS_WORKTREE:-}"
        fi

        assert_equal RUSTUP_HOME "$state/rustup" "$RUSTUP_HOME"
        assert_equal CARGO_HOME "$state/cargo" "$CARGO_HOME"
        assert_equal NPM_CONFIG_PREFIX "$state/npm" "$NPM_CONFIG_PREFIX"
        assert_equal NPM_CONFIG_CACHE "$state/npm-cache" "$NPM_CONFIG_CACHE"
        assert_equal BUN_INSTALL "$state/bun" "$BUN_INSTALL"
        assert_equal DENO_DIR "$state/deno" "$DENO_DIR"
        for dir in "$RUSTUP_HOME" "$CARGO_HOME" "$NPM_CONFIG_PREFIX" \
          "$NPM_CONFIG_CACHE" "$BUN_INSTALL" "$DENO_DIR"; do
          if [ ! -d "$dir" ]; then
            printf 'state directory must exist: %s\n' "$dir" >&2
            exit 1
          fi
        done

        # The stable profile path stays first so rebuilt profiles reach running
        # processes; the per-language bin directories follow in a fixed order.
        IFS=: read -r path_profile path_cargo path_npm path_bun _rest <<< "$PATH"
        assert_equal PATH[0] "$DEVENV_DOTFILE/profile/bin" "$path_profile"
        assert_equal PATH[1] "$CARGO_HOME/bin" "$path_cargo"
        assert_equal PATH[2] "$NPM_CONFIG_PREFIX/bin" "$path_npm"
        assert_equal PATH[3] "$BUN_INSTALL/bin" "$path_bun"

        for tool in project git just gh claude direnv; do
          if ! command -v "$tool" >/dev/null; then
            printf 'module must provide %s on PATH\n' "$tool" >&2
            exit 1
          fi
        done

        # Linux routes agent configuration through the host layer. Darwin leaves
        # all three undefined, so there is nothing module-owned to assert there.
        if [ "$(uname -s)" = Linux ]; then
          assert_equal CLAUDE_CONFIG_DIR "$HOME/.local/share/agents/claude" "$CLAUDE_CONFIG_DIR"
          assert_equal GH_CONFIG_DIR "$HOME/.local/share/agents/gh" "$GH_CONFIG_DIR"
          assert_equal PI_CODING_AGENT_DIR "$HOME/.local/share/agents/pi" "$PI_CODING_AGENT_DIR"
        fi
      '';
      # Project-scoped services run only from the main checkout.
      services = lib.genAttrs scoped (_: {
        enable = lib.mkIf isWorktree (lib.mkForce false);
      });

      tasks."project:gc" = {
        exec = ''exec project gc'';
      };
      tasks."project:update" = {
        exec = ''exec project update'';
      };
    }
    # Linux uses the host layer for Claude, gh, and Pi configuration; Darwin
    # leaves all three undefined so each tool preserves its caller configuration.
    (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      env.CLAUDE_CONFIG_DIR = "${homeDirectory}/.local/share/agents/claude";
      env.GH_CONFIG_DIR = "${homeDirectory}/.local/share/agents/gh";
      env.PI_CODING_AGENT_DIR = "${homeDirectory}/.local/share/agents/pi";
    })
  ];
}
