import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type PackageManifest = {
  dependencies: Record<string, string> | undefined;
};

// SAFETY: The asserted value is constrained by the surrounding validation or fixture.
const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");

const templates = ["bare", "bun-ts", "deno", "rust"] as const;

describe("runtime dependency boundary", () => {
  it("keeps package dependencies empty", () => {
    expect(packageManifest.dependencies ?? {}).toEqual({});
  });

  it("packages templates from the filtered source beside the installed executable", () => {
    expect(flake).toContain("projectSource = nixpkgs.lib.cleanSourceWith");
    expect(flake).toContain('".devenv"');
    expect(flake).toContain("src = projectSource;");
    expect(flake).toContain('mkdir -p "$out/share/devenv-agents/templates"');
    expect(flake).toContain('cp -R ./templates/. "$out/share/devenv-agents/templates/"');
    expect(flake).toContain('--set PROJECT_TEMPLATE_ROOT "$out/share/devenv-agents/templates"');
  });

  it("makes direnv resolvable before the packaged CLI enters devenv", () => {
    expect(flake).toContain('--prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.direnv ]}"');
  });

  it("ships in-place devenv activation with every bundled template", () => {
    const envrc = '#!/usr/bin/env bash\n\neval "$(devenv direnvrc)"\n\nuse devenv\n';

    for (const template of templates) {
      expect(
        readFileSync(new URL(`../templates/${template}/.envrc`, import.meta.url), "utf8"),
      ).toBe(envrc);
      expect(
        readFileSync(new URL(`../templates/${template}/.gitignore`, import.meta.url), "utf8"),
      ).toContain(".direnv/");
    }
  });
});
