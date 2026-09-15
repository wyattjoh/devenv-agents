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
import { runCli } from "./cli.ts";
import type { HerdrPlugin } from "./herdr-client.ts";
import { captureOutput, createCliDependencies } from "./testing/cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import {
  enumerateProjects,
  runProjectAdd,
  writeProjectDropIn,
  writeProjectsFile,
} from "./project-add.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./testing/command-runner.ts";

type ProjectAddOptions = Parameters<typeof runProjectAdd>[0];

type ProjectRegistration = ReturnType<typeof enumerateProjects>[number];

const created: string[] = [];

const pluginRoot = fileURLToPath(new URL("../plugin", import.meta.url));

const templateRoot = fileURLToPath(new URL("../templates", import.meta.url));

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const enabledProjectPlugin = (): HerdrPlugin => ({
  pluginId: PROJECT_PLUGIN_ID,
  enabled: true,
  pluginRoot,
  manifestPath: join(pluginRoot, "herdr-plugin.toml"),
  version: "0.1.0",
});

const enabledHerdrClient = () =>
  createFakeHerdrClient({ listPlugins: () => [enabledProjectPlugin()] });

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
  herdrClient: enabledHerdrClient(),
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
    const runner = createRecordingRunner();

    expect(() =>
      runProjectAdd(
        options(fixture, runner, {
          repository: "not-a-repo",
          herdrClient: createFakeHerdrClient({ listPlugins: () => [] }),
        }),
      ),
    ).toThrow(`Herdr plugin ${PROJECT_PLUGIN_ID} is not linked and enabled`);
    expect(runner.calls).toEqual([]);
  });

  it("clones, trusts, allows direnv, warms non-interactively, syncs, and enables Linux", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(join(checkout, ".agents"), { recursive: true });
    writeFileSync(join(checkout, ".agents", "project.toml"), 'session = "atlas"\n');
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");

    const runner = createRecordingRunner({
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
      ["devenv", "allow"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "herdr@atlas"],
    ]);
    expect(runner.calls.slice(0, 3)).toEqual([
      { command: "devenv", args: ["allow"], cwd: checkout, env: undefined },
      { command: "direnv", args: ["allow"], cwd: checkout, env: undefined },
      {
        command: "devenv",
        args: ["shell", "--", "true"],
        cwd: checkout,
        env: undefined,
      },
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
      devenv: result(0),
      systemctl: result(0),
    });

    expect(() => runProjectAdd(options(fixture, runner))).toThrow("not safe for Herdr");
    expect(runner.calls.map((call) => call.command)).not.toContain("systemctl");
  });

  it("binds a bundled template for a bare repository", () => {
    const fixture = makeFixture();

    const runner = createRecordingRunner({
      git: result(0),
      devenv: result(0),
      systemctl: result(0),
    });

    const added = runProjectAdd(options(fixture, runner, { from: "bun-ts" }));

    expect(added.checkoutCreated).toBe(true);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      [
        "git",
        "clone",
        "https://github.com/example/widget.git",
        join(fixture.code, "github.com", "example", "widget"),
      ],
      ["devenv", "--from", `path:${join(templateRoot, "bun-ts")}`, "allow"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "herdr@widget"],
    ]);
  });

  it("fails a bare repository with a supported-template hint", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    const runner = createRecordingRunner();

    expect(() => runProjectAdd(options(fixture, runner))).toThrow(
      "Available templates: bare, bun-ts, deno, rust",
    );
    expect(runner.calls).toEqual([]);
  });

  it("wires add through the CLI dependencies and local roots", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({ devenv: result(0) });
    const output = captureOutput();

    const dependencies = createCliDependencies({
      runner,
      herdrClient: enabledHerdrClient(),
      environment: {
        PROJECT_CODE_ROOT: fixture.code,
        PROJECT_PLATFORM: "darwin",
        PROJECT_PROJECTS_FILE: fixture.projects,
        PROJECT_TEMPLATE_ROOT: templateRoot,
        PROJECT_HOME: fixture.home,
        USER: "fixture",
      },
    });

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
      devenv: result(0),
      systemctl: result(0),
    });

    const output = captureOutput();

    const dependencies = createCliDependencies({
      runner,
      herdrClient: enabledHerdrClient(),
      environment: {
        PROJECT_CODE_ROOT: fixture.code,
        PROJECT_PLATFORM: "linux",
        PROJECT_PROJECTS_FILE: fixture.projects,
        PROJECT_SYSTEMD_USER_DIRECTORY: fixture.systemd,
        PROJECT_TEMPLATE_ROOT: templateRoot,
        PROJECT_HOME: fixture.home,
        USER: "fixture",
      },
    });

    expect(runCli(["add", "github.com/example/widget"], output.io, dependencies)).toBe(0);
    expect(existsSync(join(fixture.systemd, "herdr@widget.service.d", "project.conf"))).toBe(true);
    expect(runner.calls.map((call) => call.command)).toContain("systemctl");
  });

  it("rejects an unsupported explicit project platform", () => {
    const fixture = makeFixture();
    const runner = createRecordingRunner();
    const output = captureOutput();

    const dependencies = createCliDependencies({
      runner,
      environment: { PROJECT_PLATFORM: "freebsd", PROJECT_HOME: fixture.home },
    });

    expect(runCli(["add", "github.com/example/widget"], output.io, dependencies)).toBe(1);
    expect(output.stderr()).toContain("PROJECT_PLATFORM must be either linux or darwin");
    expect(runner.calls).toEqual([]);
  });

  it("uses a deduplicated Darwin projects file for --local", () => {
    const fixture = makeFixture();
    const checkout = join(fixture.code, "github.com", "example", "widget");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ ... }: {}\n");
    const runner = createRecordingRunner({ devenv: result(0) });
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

  it("rejects unsafe repository identifiers through project add", () => {
    const fixture = makeFixture();
    const runner = createRecordingRunner();

    expect(() =>
      runProjectAdd(options(fixture, runner, { repository: "github.com/example/../widget" })),
    ).toThrow("Repository must be <forge>/<org>/<repo>");
    expect(runner.calls).toEqual([]);
  });
});
