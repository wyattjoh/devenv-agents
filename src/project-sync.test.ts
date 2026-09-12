import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createRecordingRunner,
  errorMessage,
  realCommandRunner,
  type CommandResult,
} from "./command-runner.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";
import {
  createSyncReferences,
  MissingReferencedCheckoutsError,
  syncProjectReferences,
} from "./project-sync.ts";
import { withGitFixture } from "./testing/git-fixture.ts";
import type { SyncRequest } from "./worktree-setup.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const makeProject = (
  declaration: string,
): {
  readonly root: string;
  readonly projectRoot: string;
  readonly worktreePath: string;
} => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-sync-"));
  const projectRoot = join(root, "project");
  const worktreePath = join(root, "worktree");
  mkdirSync(join(projectRoot, ".agents"), { recursive: true });
  mkdirSync(worktreePath);
  writeFileSync(join(projectRoot, ".agents", "project.toml"), declaration);
  created.push(root);
  return { root, projectRoot, worktreePath };
};

const requestFor = (
  projectRoot: string,
  worktreePath: string,
): SyncRequest & { readonly declaration: ProjectDeclaration } => ({
  projectRoot,
  worktreePath,
  declaration: readProjectDeclaration(projectRoot),
});

const makeSibling = (home: string, repo: string, declaration: string): string => {
  const checkout = join(home, "code", ...repo.split("/"));
  mkdirSync(join(checkout, ".agents"), { recursive: true });
  writeFileSync(join(checkout, ".agents", "project.toml"), declaration);
  return realpathSync(checkout);
};

const readYaml = (path: string): Record<string, unknown> =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project reference synchronization", () => {
  it("requires references to use a forge/org/repo path", () => {
    const project = makeProject(
      ["[[references]]", 'repo = "acme/project"', 'grant = ["tree"]', ""].join("\n"),
    );

    expect(() =>
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: "/tmp/does-not-exist",
        platform: "linux",
      }),
    ).toThrow("Project reference repo must use forge/org/repo");
  });

  it("materializes tree, module, and service grants from a Linux code root", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        'session = "consumer"',
        "",
        "[[references]]",
        'repo = "github.com/acme/provider"',
        'grant = ["tree", "module", "services"]',
        "",
      ].join("\n"),
    );
    const sibling = makeSibling(
      home,
      "github.com/acme/provider",
      ["[services]", 'scoped = ["postgres", "redis"]', ""].join("\n"),
    );
    const runner = createRecordingRunner({
      "devenv eval processes": result(
        0,
        JSON.stringify({
          processes: {
            postgres: { host: "127.0.0.1", ports: { main: { value: 5440 } } },
            redis: { ports: { main: { value: 6380 } } },
          },
        }),
      ),
    });

    const sync = syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
      homeDirectory: home,
      platform: "linux",
      runner,
    });

    expect(sync.missingReferences).toEqual([]);
    expect(readFileSync(join(project.worktreePath, ".claude", "settings.local.json"), "utf8")).toBe(
      `{\n  "permissions": {\n    "additionalDirectories": [\n      "${sibling}"\n    ]\n  }\n}\n`,
    );
    expect(readFileSync(join(project.worktreePath, "devenv.local.yaml"), "utf8")).toBe(
      [
        "inputs:",
        "  ref-provider:",
        `    url: path:${sibling}`,
        "    flake: false",
        "imports:",
        "  - ref-provider",
        "",
      ].join("\n"),
    );
    expect(
      readFileSync(join(project.projectRoot, ".devenv", "state", "references.env"), "utf8"),
    ).toBe(
      [
        "export REF_PROVIDER_POSTGRES_HOST=127.0.0.1",
        "export REF_PROVIDER_POSTGRES_PORT=5440",
        "export REF_PROVIDER_REDIS_HOST=localhost",
        "export REF_PROVIDER_REDIS_PORT=6380",
        "",
      ].join("\n"),
    );
    expect(runner.calls).toEqual([
      { command: "devenv", args: ["eval", "processes"], cwd: sibling, env: undefined },
    ]);
  });

  it("preserves unrelated local Claude settings and existing directories", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      ["[[references]]", 'repo = "github.com/acme/docs"', 'grant = ["tree"]', ""].join("\n"),
    );
    const sibling = makeSibling(home, "github.com/acme/docs", "");
    mkdirSync(join(project.worktreePath, ".claude"));
    writeFileSync(
      join(project.worktreePath, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          model: "fixture-model",
          permissions: {
            allow: ["Bash(git status)"],
            additionalDirectories: ["/tmp/existing-reference", sibling],
          },
          hooks: { Stop: ["fixture-hook"] },
        },
        null,
        2,
      ),
    );

    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
      homeDirectory: home,
      platform: "linux",
    });

    expect(
      JSON.parse(
        readFileSync(join(project.worktreePath, ".claude", "settings.local.json"), "utf8"),
      ),
    ).toEqual({
      model: "fixture-model",
      permissions: {
        allow: ["Bash(git status)"],
        additionalDirectories: ["/tmp/existing-reference", sibling],
      },
      hooks: { Stop: ["fixture-hook"] },
    });
  });

  it("preserves unrelated devenv content and reconciles owned inputs and endpoints", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        "[[references]]",
        'repo = "github.com/acme/provider"',
        'grant = ["module", "services"]',
        "",
      ].join("\n"),
    );
    const sibling = makeSibling(
      home,
      "github.com/acme/provider",
      ["[services]", 'scoped = ["postgres"]', ""].join("\n"),
    );
    writeFileSync(
      join(project.worktreePath, "devenv.local.yaml"),
      [
        "allowUnfree: true",
        "inputs:",
        "  nixpkgs:",
        "    url: github:NixOS/nixpkgs",
        "  ref-stale:",
        "    url: path:/tmp/stale",
        "    flake: false",
        "imports:",
        "  - agents",
        "  - ref-stale",
        "",
      ].join("\n"),
    );
    mkdirSync(join(project.projectRoot, ".devenv", "state"), { recursive: true });
    writeFileSync(
      join(project.projectRoot, ".devenv", "state", "references.env"),
      [
        "export API_URL=https://example.test",
        "export REF_STALE_POSTGRES_HOST=stale",
        "export REF_STALE_POSTGRES_PORT=5432",
        "",
      ].join("\n"),
    );

    const options = {
      homeDirectory: home,
      platform: "linux" as const,
      resolveServiceEndpoint: () => ({ host: "127.0.0.1", port: 5440 }),
    };
    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), options);

    expect(readYaml(join(project.worktreePath, "devenv.local.yaml"))).toEqual({
      allowUnfree: true,
      inputs: {
        nixpkgs: { url: "github:NixOS/nixpkgs" },
        "ref-provider": { url: `path:${sibling}`, flake: false },
      },
      imports: ["agents", "ref-provider"],
    });
    expect(
      readFileSync(join(project.projectRoot, ".devenv", "state", "references.env"), "utf8"),
    ).toBe(
      [
        "export API_URL=https://example.test",
        "",
        "export REF_PROVIDER_POSTGRES_HOST=127.0.0.1",
        "export REF_PROVIDER_POSTGRES_PORT=5440",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(project.projectRoot, ".agents", "project.toml"),
      ["[[references]]", 'repo = "github.com/acme/provider"', 'grant = ["tree"]', ""].join("\n"),
    );
    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), options);
    expect(readYaml(join(project.worktreePath, "devenv.local.yaml"))).toEqual({
      allowUnfree: true,
      inputs: { nixpkgs: { url: "github:NixOS/nixpkgs" } },
      imports: ["agents"],
    });
    expect(
      readFileSync(join(project.projectRoot, ".devenv", "state", "references.env"), "utf8"),
    ).toBe("export API_URL=https://example.test\n");

    writeFileSync(join(project.projectRoot, ".agents", "project.toml"), 'session = "plain"\n');
    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), options);
    expect(readYaml(join(project.worktreePath, "devenv.local.yaml"))).toEqual({
      allowUnfree: true,
      inputs: { nixpkgs: { url: "github:NixOS/nixpkgs" } },
      imports: ["agents"],
    });
    expect(
      readFileSync(join(project.projectRoot, ".devenv", "state", "references.env"), "utf8"),
    ).toBe("export API_URL=https://example.test\n");
  });

  it("removes generated overlay and endpoint files when references disappear", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        "[[references]]",
        'repo = "github.com/acme/provider"',
        'grant = ["module", "services"]',
        "",
      ].join("\n"),
    );
    makeSibling(
      home,
      "github.com/acme/provider",
      ["[services]", 'scoped = ["postgres"]', ""].join("\n"),
    );
    const options = {
      homeDirectory: home,
      platform: "linux" as const,
      resolveServiceEndpoint: () => ({ host: "localhost", port: 5440 }),
    };
    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), options);
    expect(existsSync(join(project.worktreePath, "devenv.local.yaml"))).toBe(true);
    expect(existsSync(join(project.projectRoot, ".devenv", "state", "references.env"))).toBe(true);

    writeFileSync(join(project.projectRoot, ".agents", "project.toml"), 'session = "plain"\n');
    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), options);

    expect(existsSync(join(project.worktreePath, "devenv.local.yaml"))).toBe(false);
    expect(existsSync(join(project.projectRoot, ".devenv", "state", "references.env"))).toBe(false);
  });

  it("rejects module identity collisions instead of overwriting an input", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        "[[references]]",
        'repo = "github.com/acme-one/shared"',
        'grant = ["module"]',
        "",
        "[[references]]",
        'repo = "github.com/acme-two/shared"',
        'grant = ["module"]',
        "",
      ].join("\n"),
    );
    makeSibling(home, "github.com/acme-one/shared", "");
    makeSibling(home, "github.com/acme-two/shared", "");

    expect(() =>
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: home,
        platform: "linux",
      }),
    ).toThrow("Project reference module identity collision");
    expect(existsSync(join(project.worktreePath, "devenv.local.yaml"))).toBe(false);
  });

  it("rejects service identity collisions instead of overwriting endpoint variables", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        "[[references]]",
        'repo = "github.com/acme-one/shared"',
        'grant = ["services"]',
        "",
        "[[references]]",
        'repo = "github.com/acme-two/shared"',
        'grant = ["services"]',
        "",
      ].join("\n"),
    );
    makeSibling(home, "github.com/acme-one/shared", '[services]\nscoped = ["postgres"]\n');
    makeSibling(home, "github.com/acme-two/shared", '[services]\nscoped = ["postgres"]\n');

    expect(() =>
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: home,
        platform: "linux",
        resolveServiceEndpoint: () => ({ host: "localhost", port: 5440 }),
      }),
    ).toThrow("Project reference services identity collision");
    expect(existsSync(join(project.projectRoot, ".devenv"))).toBe(false);
  });

  it("rejects a reference checkout whose symlink escapes the code root", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    const outside = mkdtempSync(join("/tmp", "devenv-agents-sync-outside-"));
    created.push(home, outside);
    const project = makeProject(
      ["[[references]]", 'repo = "github.com/acme/escaped"', 'grant = ["tree"]', ""].join("\n"),
    );
    mkdirSync(join(home, "code", "github.com", "acme"), { recursive: true });
    symlinkSync(outside, join(home, "code", "github.com", "acme", "escaped"), "dir");

    expect(() =>
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: home,
        platform: "linux",
      }),
    ).toThrow("escapes the code root");
    expect(existsSync(join(project.worktreePath, ".claude"))).toBe(false);
  });

  it("resolves a real linked worktree through the CLI sync command", () => {
    withGitFixture(
      (fixture) => {
        const codeRoot = join(fixture.root, "code");
        const siblingPath = join(codeRoot, "github.com", "acme", "provider");
        mkdirSync(siblingPath, { recursive: true });
        const sibling = realpathSync(siblingPath);
        mkdirSync(join(fixture.repository, ".agents"), { recursive: true });
        writeFileSync(
          join(fixture.repository, ".agents", "project.toml"),
          ["[[references]]", 'repo = "github.com/acme/provider"', 'grant = ["tree"]', ""].join(
            "\n",
          ),
        );
        const output = { stdout: "", stderr: "" };
        const io = {
          stdout: (text: string) => (output.stdout += text),
          stderr: (text: string) => (output.stderr += text),
        };
        const dependencies: CliDependencies = {
          cwd: fixture.worktree,
          now: () => "2026-09-08T01:00:00.000Z",
          readLine: () => "q",
          runner: realCommandRunner,
          syncReferences: createSyncReferences({ codeRoot, runner: realCommandRunner }),
          environment: {},
          pluginPath: undefined,
        };

        expect(runCli(["sync"], io, dependencies)).toBe(0);
        expect(output.stdout).toBe("");
        expect(output.stderr).toBe("");
        expect(
          JSON.parse(
            readFileSync(join(fixture.worktree, ".claude", "settings.local.json"), "utf8"),
          ),
        ).toEqual({ permissions: { additionalDirectories: [sibling] } });
      },
      {
        prefix: "devenv-agents-sync-git-",
        branch: undefined,
        worktreeName: undefined,
        env: undefined,
      },
    );
  });

  it("uses the Darwin code root when resolving a reference", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      ["[[references]]", 'repo = "github.com/acme/mac-project"', 'grant = ["tree"]', ""].join("\n"),
    );
    const siblingPath = join(home, "Code", "github.com", "acme", "mac-project");
    mkdirSync(siblingPath, { recursive: true });
    const sibling = realpathSync(siblingPath);

    syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
      homeDirectory: home,
      platform: "darwin",
    });

    const settings = JSON.parse(
      readFileSync(join(project.worktreePath, ".claude", "settings.local.json"), "utf8"),
    ) as { permissions: { additionalDirectories: string[] } };
    expect(settings.permissions.additionalDirectories).toEqual([sibling]);
  });

  it("writes available references before reporting all missing checkouts", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      [
        "[[references]]",
        'repo = "github.com/acme/available"',
        'grant = ["tree"]',
        "",
        "[[references]]",
        'repo = "github.com/acme/missing-one"',
        'grant = ["tree", "module"]',
        "",
        "[[references]]",
        'repo = "github.com/acme/missing-two"',
        'grant = ["services"]',
        "",
      ].join("\n"),
    );
    const available = makeSibling(home, "github.com/acme/available", "");

    expect(() =>
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: home,
        platform: "linux",
      }),
    ).toThrow(MissingReferencedCheckoutsError);

    expect(
      JSON.parse(
        readFileSync(join(project.worktreePath, ".claude", "settings.local.json"), "utf8"),
      ),
    ).toEqual({ permissions: { additionalDirectories: [available] } });
    let error: unknown;
    try {
      syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
        homeDirectory: home,
        platform: "linux",
      });
    } catch (caught) {
      error = caught;
    }
    expect(errorMessage(error)).toContain("github.com/acme/missing-one");
    expect(errorMessage(error)).toContain("github.com/acme/missing-two");
  });

  it("does not touch the filesystem or runner when no references are declared", () => {
    const project = makeProject('session = "no-references"\n');
    const before = readdirSync(project.worktreePath);
    const runner = createRecordingRunner({
      "devenv eval processes": result(1, "", "must not run"),
    });

    const sync = syncProjectReferences(requestFor(project.projectRoot, project.worktreePath), {
      homeDirectory: "/tmp/does-not-exist",
      platform: "linux",
      runner,
    });

    expect(sync.missingReferences).toEqual([]);
    expect(readdirSync(project.worktreePath)).toEqual(before);
    expect(existsSync(join(project.projectRoot, ".devenv"))).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("can be installed as the setup seam with injected options", () => {
    const home = mkdtempSync(join("/tmp", "devenv-agents-sync-home-"));
    created.push(home);
    const project = makeProject(
      ["[[references]]", 'repo = "github.com/acme/provider"', 'grant = ["tree"]', ""].join("\n"),
    );
    const sibling = makeSibling(home, "github.com/acme/provider", "");
    const syncReferences = createSyncReferences({
      homeDirectory: home,
      platform: "linux",
    });

    syncReferences(requestFor(project.projectRoot, project.worktreePath));

    expect(
      JSON.parse(
        readFileSync(join(project.worktreePath, ".claude", "settings.local.json"), "utf8"),
      ),
    ).toEqual({ permissions: { additionalDirectories: [sibling] } });
  });
});
