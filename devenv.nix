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
  project = inputs.agents.packages.${pkgs.stdenv.hostPlatform.system}.project;
in
{
  options.agents.session = lib.mkOption {
    type = lib.types.str;
    default = declaration.session or (baseNameOf root);
  };

  config = lib.mkMerge [
    {
      packages = [ project pkgs.git pkgs.just pkgs.gh pkgs.direnv ];
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
    # leaves all three unset so each tool keeps its local configuration.
    (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      env.CLAUDE_CONFIG_DIR = "$HOME/.local/share/agents/claude";
      env.GH_CONFIG_DIR = "$HOME/.local/share/agents/gh";
      env.PI_CODING_AGENT_DIR = "$HOME/.local/share/agents/pi";
    })
  ];
}
