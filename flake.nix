{
  description = "devenv-agents project CLI and Herdr plugin";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
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
          pkgs = import nixpkgs { inherit system; };
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
          inherit herdrPlugin project;
          "herdr-plugin" = herdrPlugin;
          default = project;
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
