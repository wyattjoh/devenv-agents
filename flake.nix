{
  description = "devenv-agents project CLI and Herdr plugin";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  # The status line is a Deno program with no flake of its own. Take the source
  # here and wrap it below so every consumer of this flake resolves the same
  # pinned revision instead of packaging it again.
  inputs.claude-status-line = {
    url = "github:wyattjoh/claude-status-line/370f4ccbcdbe3ebe6dd9ce6ed2a8941f95f9c362";
    flake = false;
  };

  outputs =
    { self, nixpkgs, claude-status-line }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
      projectSource = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter =
          path: type:
          nixpkgs.lib.cleanSourceFilter path type
          && !(builtins.elem (baseNameOf path) [
            ".devenv"
            ".direnv"
            ".scratch"
            "dist"
            "node_modules"
          ]);
      };
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            # Claude Code is unfree. A consumer's allowUnfree never reaches this
            # import, so admit that one package here rather than all of them.
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          # nixpkgs builds Pi for Linux and aarch64-darwin but not x86_64-darwin.
          # Leave the attribute out where it was never packaged so the module can
          # test for it and `nix flake show` never evaluates a broken derivation.
          piAvailable = pkgs.lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.pi-coding-agent;
          claudeStatusLine = pkgs.writeShellApplication {
            name = "claude-status-line";
            runtimeInputs = [ pkgs.deno ];
            text = ''
              exec deno run \
                --allow-net \
                --allow-env \
                --allow-read \
                --allow-write \
                --allow-run \
                --allow-sys \
                --unstable-kv \
                ${claude-status-line}/src/main.ts "$@"
            '';
          };
          herdrPlugin = pkgs.runCommand "devenv-agents-herdr-plugin" { } ''
            mkdir -p "$out"
            cp -R ${./plugin}/. "$out/"
          '';
          project = pkgs.stdenvNoCC.mkDerivation {
            pname = "project";
            version = "0.1.0";
            src = projectSource;
            nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];
            dontConfigure = true;
            dontStrip = true;
            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR/home"
              export BUN_NO_CODESIGN_MACHO_BINARY=1
              mkdir -p "$HOME"
              bun build --compile ./src/cli.ts --outfile ./project
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm755 ./project "$out/bin/project-real"
              mkdir -p "$out/share/devenv-agents/templates"
              cp -R ./templates/. "$out/share/devenv-agents/templates/"
              makeWrapper "$out/bin/project-real" "$out/bin/project" \
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.direnv ]}" \
                --set DEVENV_AGENTS_PLUGIN_PATH "${herdrPlugin}" \
                --set PROJECT_TEMPLATE_ROOT "$out/share/devenv-agents/templates"
              runHook postInstall
            '';
            postFixup = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
              # Bun's embedded Mach-O signature can be invalid after packaging. Sign the
              # final binary after all Nix fixups and verify it before publishing the store path.
              /usr/bin/codesign --force --sign - "$out/bin/project-real"
              /usr/bin/codesign --verify --strict --verbose=2 "$out/bin/project-real"
            '';
          };
        in
        {
          inherit claudeStatusLine herdrPlugin project;
          # Agent tooling resolves from this flake's nixpkgs, not the consumer's,
          # so the weekly flake.lock bump is what moves every project's versions.
          "claude-code" = pkgs.claude-code;
          "claude-status-line" = claudeStatusLine;
          "herdr-plugin" = herdrPlugin;
          default = project;
        }
        // pkgs.lib.optionalAttrs piAvailable {
          "pi-coding-agent" = pkgs.pi-coding-agent;
        }
      );

      apps = forEachSystem (
        system:
        let
          project = self.packages.${system}.project;
          projectApp = {
            type = "app";
            program = "${project}/bin/project";
          };
        in
        {
          project = projectApp;
          default = projectApp;
        }
      );
    };
}
