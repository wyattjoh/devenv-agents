import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type PackageManifest = {
  dependencies: Record<string, string> | undefined;
};

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");

describe("runtime dependency boundary", () => {
  it("keeps package dependencies empty", () => {
    expect(packageManifest.dependencies ?? {}).toEqual({});
  });

  it("packages templates beside the installed executable", () => {
    expect(flake).toContain('mkdir -p "$out/share/devenv-agents/templates"');
    expect(flake).toContain('cp -R ${./templates}/. "$out/share/devenv-agents/templates/"');
    expect(flake).toContain('--set PROJECT_TEMPLATE_ROOT "$out/share/devenv-agents/templates"');
  });
});
