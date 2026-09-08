import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./command-runner.ts";
import { runCli, type CliDependencies, type CliIO } from "./cli.ts";
import {
  enumerateProjects,
  parseProjectRepository,
  runProjectAdd,
  writeProjectDropIn,
  writeProjectsFile,
  type ProjectAddOptions,
  type ProjectRegistration,
} from "./project-add.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";

const created: string[] = [];
const pluginRoot = fileURLToPath(new URL("../plugin", import.meta.url));
const templateRoot = fileURLToPath(new URL("../templates", import.meta.url));

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const fixtureText = (name: string): string =>
  readFileSync(new URL(`../fixtures/herdr-0.9.0/${name}`, import.meta.url), "utf8");

const pluginList = (): string => {
  const listed = JSON.parse(fixtureText("plugin-list.json")) as {
    result: { plugins: Record<string, unknown>[] };
  };
  listed.result.plugins[0] = {
    ...listed.result.plugins[0],
    enabled: true,
    plugin_id: PROJECT_PLUGIN_ID,
    plugin_root: pluginRoot,
    manifest_path: join(pluginRoot, "herdr-plugin.toml"),
  };
  return JSON.stringify(listed);
};

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly code: string;
  readonly projects: string;
  readonly systemd: string;
};

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-add-"));
  const fixture = {
    root,
    home: join(root, "home"),
    code: join(root, "home", "Code"),
    projects: join(root, "home", ".config", "project", "projects.toml"),
    systemd: join(root, "home", ".config", "systemd", "user"),
  };
  mkdirSync(fixture.code, { recursive: true });
  created.push(root);
  return fixture;
};

const captureOutput = (): {
  readonly io: CliIO;
  readonly stdout: () => string;
  readonly stderr: () => string;
} => {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const options = (
  fixture: Fixture,
  runner: RecordingRunner,
  overrides: Partial<ProjectAddOptions> = {},
): ProjectAddOptions => ({
  repository: "github.com/example/widget",
  from: undefined,
  local: false,
  platform: "linux",
  homeDirectory: fixture.home,
  codeRoot: fixture.code,
  projectsFile: fixture.projects,
  systemdUserDirectory: fixture.systemd,
  templateRoot,
  host: "strix",
  user: "fixture",
  herdrPath: undefined,
  runner,
  syncReferences: () => undefined,
  ...overrides,
});

describe("project add", () => {
  afterEach(() => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("guards the plugin before parsing or cloning", () => {
    const fixture = makeFixture();
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify({ result: { plugins: [] } })),
    });

    expect(() => runProjectAdd(options(fixture, runner, { repository: "not-a-repo" }))).toThrow(
      `Herdr plugin ${PROJECT_PLUGIN_ID} is not linked and enabled`,
    );
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
    ]);
  });

  it("clones, trusts, excludes local files, warms, syncs, and enables Linux", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(join(checkout, ".agents"), { recursive: true });
    writeFileSync(join(checkout, ".agents", "project.toml"), 'session = "atlas"\n');
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      git: result(0),
      devenv: result(0),
      systemctl: result(0),
    });
    const syncRequests: string[] = [];

    const added = runProjectAdd(
      options(fixture, runner, {
        syncReferences: (request) => syncRequests.push(request.projectRoot),
      }),
    );

    expect(added.checkoutCreated).toBe(false);
    expect(added.registration).toEqual({
      repo: "github.com/example/widget",
      path: checkout,
      session: "atlas",
    });
    expect(syncRequests).toEqual([checkout]);
    expect(readFileSync(join(checkout, ".git", "info", "exclude"), "utf8")).toContain(
      ".claude/settings.local.json",
    );
    expect(existsSync(join(checkout, "devenv.local.nix"))).toBe(true);
    expect(readFileSync(added.unitDropIn ?? "", "utf8")).toBe(
      `[Service]\nWorkingDirectory=${checkout}\n# ProjectRepository=github.com/example/widget\n`,
    );
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
      ["devenv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "herdr@atlas"],
    ]);
    expect(added.instructions).toContain("Host strix-atlas");
    expect(added.instructions).toContain(
      'herdr machine add strix --label "strix · atlas" --remote-session atlas',
    );
  });

  it("rejects an unsafe declared session before registration", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(join(checkout, ".agents"), { recursive: true });
    writeFileSync(join(checkout, ".agents", "project.toml"), 'session = "bad/session"\n');
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      devenv: result(0),
      systemctl: result(0),
    });

    expect(() => runProjectAdd(options(fixture, runner))).toThrow("not safe for Herdr");
    expect(runner.calls.map((call) => call.command)).not.toContain("systemctl");
  });

  it("binds a bundled template for a bare repository", () => {
    const fixture = makeFixture();
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      git: result(0),
      devenv: result(0),
      systemctl: result(0),
    });

    const added = runProjectAdd(options(fixture, runner, { from: "bun-ts" }));

    expect(added.checkoutCreated).toBe(true);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
      [
        "git",
        "clone",
        "https://github.com/example/widget.git",
        join(fixture.code, "github.com", "example", "widget"),
      ],
      ["devenv", "--from", `path:${join(templateRoot, "bun-ts")}`, "allow"],
      ["devenv", "shell", "--", "true"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "herdr@widget"],
    ]);
  });

  it("fails a bare repository with a supported-template hint", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
    });

    expect(() => runProjectAdd(options(fixture, runner))).toThrow(
      "Available templates: bare, bun-ts, deno, rust",
    );
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
    ]);
  });

  it("wires add through the CLI dependencies and local roots", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      devenv: result(0),
    });
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
      environment: {
        PROJECT_CODE_ROOT: fixture.code,
        PROJECT_PLATFORM: "darwin",
        PROJECT_PROJECTS_FILE: fixture.projects,
        PROJECT_TEMPLATE_ROOT: templateRoot,
        PROJECT_HOME: fixture.home,
        USER: "fixture",
      },
      pluginPath: undefined,
    };

    expect(runCli(["add", "github.com/example/widget", "--local"], output.io, dependencies)).toBe(
      0,
    );
    expect(output.stdout()).toContain("Host strix-widget");
    expect(output.stdout()).toContain(
      'herdr machine add strix --label "strix · widget" --remote-session widget',
    );
    expect(output.stderr()).toBe("");
    expect(readFileSync(fixture.projects, "utf8")).toContain('repo = "github.com/example/widget"');
  });

  it("honors an explicit Linux platform override on Darwin hosts", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      devenv: result(0),
      systemctl: result(0),
    });
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
      environment: {
        PROJECT_CODE_ROOT: fixture.code,
        PROJECT_PLATFORM: "linux",
        PROJECT_PROJECTS_FILE: fixture.projects,
        PROJECT_SYSTEMD_USER_DIRECTORY: fixture.systemd,
        PROJECT_TEMPLATE_ROOT: templateRoot,
        PROJECT_HOME: fixture.home,
        USER: "fixture",
      },
      pluginPath: undefined,
    };

    expect(runCli(["add", "github.com/example/widget"], output.io, dependencies)).toBe(0);
    expect(existsSync(join(fixture.systemd, "herdr@widget.service.d", "project.conf"))).toBe(true);
    expect(runner.calls.map((call) => call.command)).toContain("systemctl");
  });

  it("rejects an unsupported explicit project platform", () => {
    const fixture = makeFixture();
    const runner = createRecordingRunner();
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
      environment: { PROJECT_PLATFORM: "freebsd", PROJECT_HOME: fixture.home },
      pluginPath: undefined,
    };

    expect(runCli(["add", "github.com/example/widget"], output.io, dependencies)).toBe(1);
    expect(output.stderr()).toContain("PROJECT_PLATFORM must be either linux or darwin");
    expect(runner.calls).toEqual([]);
  });

  it("uses a deduplicated Darwin projects file for --local", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, pluginList()),
      devenv: result(0),
    });
    const addOptions = options(fixture, runner, { platform: "darwin", local: true });
    const preserved: ProjectRegistration = {
      repo: "github.com/example/other",
      path: join(fixture.code, "github.com", "example", "other"),
      session: "other",
    };
    writeProjectsFile({ project: preserved, projectsFile: fixture.projects });

    runProjectAdd(addOptions);
    const added = runProjectAdd(addOptions);

    expect(
      enumerateProjects({
        platform: "darwin",
        homeDirectory: fixture.home,
        projectsFile: fixture.projects,
        systemdUserDirectory: fixture.systemd,
      }),
    ).toEqual([preserved, added.registration]);
    expect(
      readdirSync(dirname(fixture.projects)).filter((entry) => entry.includes(".tmp-")),
    ).toEqual([]);
    expect(
      readFileSync(fixture.projects, "utf8").match(/repo = "github.com\/example\/widget"/gu),
    ).toHaveLength(1);
    expect(runner.calls.map((call) => call.command)).not.toContain("systemctl");
    expect(added.instructions).toContain("Host strix-widget");
  });
});

describe("project enumeration", () => {
  afterEach(() => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("enumerates Linux projects from project drop-ins", () => {
    const fixture = makeFixture();
    const first: ProjectRegistration = {
      repo: "github.com/example/widget",
      path: join(fixture.code, "widget"),
      session: "widget",
    };
    const second: ProjectRegistration = {
      repo: "alpha",
      path: join(fixture.code, "alpha"),
      session: "alpha",
    };
    writeProjectDropIn({ project: first, systemdUserDirectory: fixture.systemd });
    writeProjectDropIn({ project: second, systemdUserDirectory: fixture.systemd });

    expect(
      enumerateProjects({
        platform: "linux",
        homeDirectory: fixture.home,
        projectsFile: fixture.projects,
        systemdUserDirectory: fixture.systemd,
      }),
    ).toEqual([second, first]);
  });

  it("enumerates Darwin projects from the deduplicated projects file", () => {
    const fixture = makeFixture();
    const project: ProjectRegistration = {
      repo: "github.com/example/widget",
      path: join(fixture.code, "github.com", "example", "widget"),
      session: "widget",
    };
    writeProjectsFile({ project, projectsFile: fixture.projects });

    expect(
      enumerateProjects({
        platform: "darwin",
        homeDirectory: fixture.home,
        projectsFile: fixture.projects,
        systemdUserDirectory: fixture.systemd,
      }),
    ).toEqual([project]);
  });

  it("parses only safe forge/org/repo identifiers", () => {
    expect(parseProjectRepository("github.com/example/widget").cloneUrl).toBe(
      "https://github.com/example/widget.git",
    );
    expect(() => parseProjectRepository("github.com/example/../widget")).toThrow();
  });
});
