import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project declaration", () => {
  it("treats an absent declaration as an empty project", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-declaration-"));
    created.push(root);

    expect(readProjectDeclaration(root)).toEqual({
      session: undefined,
      scopedServices: [],
      references: [],
    });
  });

  it("rejects an unknown reference grant with the allowed grant names", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-declaration-"));
    created.push(root);
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents", "project.toml"),
      ["[[references]]", 'repo = "github.com/acme/project"', 'grant = ["binary"]', ""].join("\n"),
    );

    expect(() => readProjectDeclaration(root)).toThrow(
      "Project declaration reference grant must be tree, module, or services",
    );
  });

  it("reads session, scoped services, and reference grants", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-declaration-"));
    created.push(root);
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents", "project.toml"),
      [
        'session = "atlas"',
        "",
        "[services]",
        'scoped = ["postgres", "redis"]',
        "",
        "[[references]]",
        'repo = "wyattjoh/skills"',
        'grant = ["tree", "module"]',
        "",
        "[[references]]",
        'repo = "wyattjoh/infra"',
        'grant = ["services"]',
        "",
      ].join("\n"),
    );

    const expected: ProjectDeclaration = {
      session: "atlas",
      scopedServices: ["postgres", "redis"],
      references: [
        { repo: "wyattjoh/skills", grant: ["tree", "module"] },
        { repo: "wyattjoh/infra", grant: ["services"] },
      ],
    };
    expect(readProjectDeclaration(root)).toEqual(expected);
  });
});
