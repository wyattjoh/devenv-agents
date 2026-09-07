import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type PackageManifest = {
  dependencies: Record<string, string> | undefined;
};

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("runtime dependency boundary", () => {
  it("keeps package dependencies empty", () => {
    expect(packageManifest.dependencies ?? {}).toEqual({});
  });
});
