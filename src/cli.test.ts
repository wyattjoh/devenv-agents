import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMAND_HELP,
  defaultDependencies,
  HELP_TEXT,
  PROJECT_NAME,
  PROJECT_VERSION,
  runCli,
} from "./cli.ts";
import { createRecordingRunner, type CommandResult } from "./command-runner.ts";
import { captureOutput, createCliDependencies } from "./testing/cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { createFakeWorktreeBootstrap } from "./testing/worktree-bootstrap.ts";
import { createWorktreeBootstrap } from "./worktree-bootstrap.ts";
import { createSyncReferences } from "./project-sync.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const LEGACY_HELP_TEXT = `Usage: project [options]

Project lifecycle tooling for devenv and Herdr worktrees.

Commands:
  add <repo> [options]           Add and prepare a project checkout
      --from <template>          Bind a bundled devenv template
      --local                    Register without a systemd session
      --host <name>              Host used in printed attachment snippets
  worktree-setup [--interactive]  Bootstrap the current worktree
  wt create <branch> [options]  Create and bootstrap a worktree
      --base <ref>              Create from a base ref
      --no-focus                Leave the new workspace unfocused
      --json                    Print workspace and pane ids as JSON
  wt new                        Prompt for and create a focused worktree
  sync                           Materialize declared project references
  wt on-event                    Handle a Herdr worktree event
  plugin install                 Link the Herdr worktree plugin
  update [--all]                 Refresh and rebuild project environments
  gc [--all] [--dry-run]          Review or collect stale worktrees
  adopt-worktrees [--all]        Bootstrap registered worktrees

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

const defaultTableDependencies = () => createCliDependencies({ readLine: () => "" });

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project CLI", () => {
  it("prints its version from the source entrypoint", () => {
    const output = captureOutput();

    expect(runCli(["--version"], output.io)).toBe(0);
    expect(output.stdout()).toBe(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);
    expect(output.stderr()).toBe("");
  });

  it("prints help from the source entrypoint", () => {
    const output = captureOutput();

    expect(runCli(["--help"], output.io)).toBe(0);
    expect(output.stdout()).toBe(HELP_TEXT);
    expect(HELP_TEXT).toBe(LEGACY_HELP_TEXT);
    expect(output.stderr()).toBe("");
  });

  it("prints help for a bare invocation", () => {
    const output = captureOutput();

    expect(runCli([], output.io)).toBe(0);
    expect(output.stdout()).toBe(HELP_TEXT);
  });

  it("rejects unsupported arguments without terminating the test process", () => {
    const output = captureOutput();

    expect(runCli(["--not-a-command"], output.io)).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(
      "project: unknown argument '--not-a-command'\nRun 'project --help' for usage.\n",
    );
  });

  it("dispatches every command through the table and formats its result", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-table-"));
    const home = join(root, "home");
    const code = join(root, "code");
    const checkout = join(code, "github.com", "example", "widget");
    const projectsFile = join(root, "projects.toml");
    mkdirSync(join(checkout, ".agents"), { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ }: {}\n");
    writeFileSync(join(checkout, ".agents", "project.toml"), 'session = "widget"\n');
    created.push(root);

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [
        {
          pluginId: PROJECT_PLUGIN_ID,
          enabled: true,
          pluginRoot: undefined,
          manifestPath: undefined,
          version: "0.1.0",
        },
      ],
    });
    const addDependencies = () =>
      createCliDependencies({
        herdrClient,
        runner: createRecordingRunner({ devenv: result(0) }),
        environment: {
          PROJECT_PLATFORM: "darwin",
          PROJECT_HOME: home,
          PROJECT_CODE_ROOT: code,
          PROJECT_PROJECTS_FILE: projectsFile,
          USER: "fixture",
        },
        readLine: () => "",
      });
    const createDependencies = () =>
      createCliDependencies({
        cwd: checkout,
        herdrClient,
        runner: createRecordingRunner({
          [`git -C ${checkout} rev-parse --path-format=absolute --git-common-dir`]: result(
            0,
            `${checkout}/.git\n`,
          ),
        }),
        readLine: () => "",
      });
    const cases = [
      {
        args: ["add", "github.com/example/widget"],
        dependencies: addDependencies,
        exitCode: 0,
        stdout: undefined,
        stdoutContains: "Host strix-widget",
        stderr: "",
      },
      {
        args: ["worktree-setup"],
        dependencies: defaultTableDependencies,
        exitCode: 0,
        stdout: "",
        stdoutContains: undefined,
        stderr: "",
      },
      {
        args: ["wt", "create", "feature", "--json"],
        dependencies: createDependencies,
        exitCode: 0,
        stdout: '{"workspace_id":"fake-workspace","root_pane_id":"fake-root-pane"}\n',
        stdoutContains: undefined,
        stderr: "",
      },
      {
        args: ["wt", "new"],
        dependencies: defaultTableDependencies,
        exitCode: 1,
        stdout: "",
        stdoutContains: undefined,
        stderr: "project wt new: branch name is required\n",
      },
      {
        args: ["sync"],
        dependencies: defaultTableDependencies,
        exitCode: 1,
        stdout: "",
        stdoutContains: undefined,
        stderr: "project sync: ",
      },
      {
        args: ["wt", "on-event"],
        dependencies: defaultTableDependencies,
        exitCode: 0,
        stdout: "",
        stdoutContains: undefined,
        stderr: "",
      },
      {
        args: ["plugin", "install"],
        dependencies: defaultTableDependencies,
        exitCode: 0,
        stdout: `${PROJECT_PLUGIN_ID}: linked\n`,
        stdoutContains: undefined,
        stderr: "",
      },
      {
        args: ["update"],
        dependencies: defaultTableDependencies,
        exitCode: 1,
        stdout: "",
        stdoutContains: undefined,
        stderr: "project update: ",
      },
      {
        args: ["gc"],
        dependencies: defaultTableDependencies,
        exitCode: 1,
        stdout: "",
        stdoutContains: undefined,
        stderr: "project gc: ",
      },
      {
        args: ["adopt-worktrees"],
        dependencies: defaultTableDependencies,
        exitCode: 1,
        stdout: "",
        stdoutContains: undefined,
        stderr: "project adopt-worktrees: ",
      },
    ] as const;

    for (const testCase of cases) {
      const output = captureOutput();

      expect(runCli(testCase.args, output.io, testCase.dependencies())).toBe(testCase.exitCode);
      if (testCase.stdoutContains === undefined) {
        expect(output.stdout()).toBe(testCase.stdout);
      } else {
        expect(output.stdout()).toContain(testCase.stdoutContains);
      }
      expect(output.stderr()).toStartWith(testCase.stderr);
    }
  });

  it("fans out --all through one wrapper and continues after a project error", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-fanout-"));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    created.push(root);

    const projects = [
      { repo: "github.com/example/first", path: first, session: "first" },
      { repo: "github.com/example/second", path: second, session: "second" },
    ];
    const runner = createRecordingRunner({
      git: (invocation) => {
        if (invocation.args.includes("rev-parse") && invocation.args.includes(first)) {
          return result(1, "", "first\nsecond");
        }
        if (invocation.args.includes("rev-parse")) {
          return result(0, `${invocation.args[1]}/.git\n`);
        }
        if (invocation.args.includes("worktree") && invocation.args.includes("list")) {
          return result(0, `worktree ${second}\nHEAD fixture\nbranch refs/heads/main\n`);
        }
        return result(0);
      },
    });
    const output = captureOutput();
    const dependencies = createCliDependencies({
      enumerateProjects: () => projects,
      runner,
      environment: { PROJECT_PLATFORM: "darwin" },
    });

    expect(runCli(["update", "--all"], output.io, dependencies)).toBe(1);
    const secondPath = realpathSync(second);
    expect(output.stdout()).toBe(
      [
        `[github.com/example/second] Agents input (${secondPath}): succeeded`,
        `[github.com/example/second] Main checkout (${secondPath}): succeeded`,
        `[github.com/example/second] Summary: 2 succeeded, 0 failed`,
        "",
      ].join("\n"),
    );
    expect(output.stderr()).toBe(
      "[github.com/example/first] project update: git rev-parse --git-common-dir failed with exit code 1: first\nsecond\n",
    );
    expect(
      runner.calls.some(
        (invocation) => invocation.command === "git" && invocation.args.includes(second),
      ),
    ).toBe(true);
  });

  it("uses one parser error shape for unknown flags and missing values", () => {
    const cases = [
      { args: ["add", "--unknown"], label: "add", detail: "unknown flag '--unknown'" },
      { args: ["add", "--from"], label: "add", detail: "flag '--from' requires a value" },
      {
        args: ["worktree-setup", "--unknown"],
        label: "worktree-setup",
        detail: "unknown flag '--unknown'",
      },
      {
        args: ["wt", "create", "branch", "--unknown"],
        label: "wt create",
        detail: "unknown flag '--unknown'",
      },
      {
        args: ["wt", "create", "branch", "--base"],
        label: "wt create",
        detail: "flag '--base' requires a value",
      },
      { args: ["wt", "new", "--unknown"], label: "wt new", detail: "unknown flag '--unknown'" },
      { args: ["sync", "--unknown"], label: "sync", detail: "unknown flag '--unknown'" },
      {
        args: ["wt", "on-event", "--unknown"],
        label: "wt on-event",
        detail: "unknown flag '--unknown'",
      },
      {
        args: ["plugin", "install", "--unknown"],
        label: "plugin install",
        detail: "unknown flag '--unknown'",
      },
      { args: ["update", "--unknown"], label: "update", detail: "unknown flag '--unknown'" },
      { args: ["gc", "--unknown"], label: "gc", detail: "unknown flag '--unknown'" },
      {
        args: ["adopt-worktrees", "--unknown"],
        label: "adopt-worktrees",
        detail: "unknown flag '--unknown'",
      },
    ] as const;

    for (const testCase of cases) {
      const output = captureOutput();

      expect(runCli(testCase.args, output.io, createCliDependencies())).toBe(1);
      expect(output.stdout()).toBe("");
      expect(output.stderr()).toBe(
        `project ${testCase.label}: ${testCase.detail}\nRun 'project --help' for usage.\n`,
      );
    }
  });

  it("renders help from every command-table entry", () => {
    const output = captureOutput();

    expect(runCli(["--help"], output.io, createCliDependencies())).toBe(0);
    expect(output.stdout()).toBe(HELP_TEXT);
    for (const command of COMMAND_HELP) {
      expect(output.stdout()).toContain(command.usage);
      expect(output.stdout()).toContain(command.description);
      for (const flag of command.flags) expect(output.stdout()).toContain(flag);
    }
  });

  it("pins the default prompt fallback when prompt is unavailable", () => {
    const global = globalThis as unknown as {
      prompt: ((message?: string) => string | null) | undefined;
    };
    const originalPrompt = global.prompt;
    global.prompt = undefined;

    try {
      const dependencies = defaultDependencies({ PROJECT_PLATFORM: "darwin" });

      expect(dependencies.readLine("Branch name: ")).toBe("");
      expect(dependencies.readLine()).toBe("q");
    } finally {
      global.prompt = originalPrompt;
    }
  });

  it("rejects an invalid platform before dispatching any command", () => {
    const commands = [
      ["add", "github.com/example/widget"],
      ["update"],
      ["gc"],
      ["adopt-worktrees"],
      ["worktree-setup"],
      ["wt", "create", "feature"],
      ["wt", "new"],
      ["sync"],
      ["wt", "on-event"],
      ["plugin", "install"],
      ["--help"],
      ["--version"],
    ] as const;

    for (const command of commands) {
      const output = captureOutput();
      const runner = createRecordingRunner();
      const dependencies = createCliDependencies({
        runner,
        environment: { PROJECT_PLATFORM: "freebsd" },
      });

      expect(runCli(command, output.io, dependencies)).toBe(1);
      expect(output.stdout()).toBe("");
      expect(output.stderr()).toBe(
        "project: PROJECT_PLATFORM must be either linux or darwin, got 'freebsd'\n",
      );
      expect(runner.calls).toEqual([]);
    }
  });

  it("runs worktree setup through the injected runner", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-"));
    const mainCheckout = join(root, "main");
    const worktreePath = join(root, "worktree");
    mkdirSync(join(mainCheckout, ".agents"), { recursive: true });
    mkdirSync(worktreePath);
    writeFileSync(join(mainCheckout, ".agents", "project.toml"), 'session = "fixture"\n');
    writeFileSync(join(worktreePath, "devenv.nix"), "{ }: {}\n");
    created.push(root);

    const runner = createRecordingRunner({
      [`git -C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`]: result(
        0,
        `${mainCheckout}/.git\n`,
      ),
      devenv: result(0),
    });
    const dependencies = createCliDependencies({
      cwd: worktreePath,
      runner,
      bootstrap: createWorktreeBootstrap({
        herdrClient: createFakeHerdrClient(),
        now: () => "2026-09-08T01:00:00.000Z",
        runner,
        syncReferences: () => undefined,
      }),
    });
    const output = captureOutput();

    expect(runCli(["worktree-setup"], output.io, dependencies)).toBe(0);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["git", "-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["devenv", "allow"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
    ]);
  });

  it("runs interactive setup through the bootstrap interface", () => {
    const bootstrapCalls: string[] = [];
    const prompts: string[] = [];
    const bootstrap = createFakeWorktreeBootstrap({
      run: (options) => {
        bootstrapCalls.push(options.worktreePath);
        prompts.push(options.io?.readLine() ?? "missing");
        options.io?.onFailure?.({
          exitCode: 1,
          state: "failed",
          error: "warm exploded",
        });
        return { exitCode: 0, state: "done", error: undefined };
      },
    });
    const dependencies = createCliDependencies({
      cwd: "/tmp/fixture-worktree",
      bootstrap,
    });
    const output = captureOutput();

    expect(runCli(["worktree-setup", "--interactive"], output.io, dependencies)).toBe(0);
    expect(bootstrapCalls).toEqual(["/tmp/fixture-worktree"]);
    expect(prompts).toEqual(["q"]);
    expect(output.stderr()).toBe(
      "project worktree-setup: warm exploded\nPress Enter to retry or q to quit.\n",
    );
  });

  it("translates a setup failure without a message through the command entry", () => {
    const bootstrap = createFakeWorktreeBootstrap({
      run: () => ({ exitCode: 1, state: "failed", error: undefined }),
    });
    const dependencies = createCliDependencies({ bootstrap });
    const output = captureOutput();

    expect(runCli(["worktree-setup"], output.io, dependencies)).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("project worktree-setup: setup failed\n");
  });

  it("runs the worktree event through the bootstrap request via runCli", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-event-"));
    const mainCheckout = join(root, "main");
    const worktreePath = join(root, "worktree");
    mkdirSync(join(mainCheckout, ".agents"), { recursive: true });
    mkdirSync(worktreePath);
    writeFileSync(join(mainCheckout, ".agents", "project.toml"), 'session = "fixture"\n');
    created.push(root);

    const requested: string[] = [];
    const bootstrap = createFakeWorktreeBootstrap({
      request: ({ worktreePath: requestedPath }) => {
        requested.push(requestedPath);
        return { state: "running", claimed: true, opened: true, error: undefined };
      },
    });
    const runner = createRecordingRunner({
      [`git -C ${realpathSync(worktreePath)} rev-parse --path-format=absolute --git-common-dir`]:
        result(0, `${mainCheckout}/.git\n`),
    });
    const dependencies = createCliDependencies({
      cwd: worktreePath,
      runner,
      bootstrap,
      environment: {
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: worktreePath } }),
      },
    });
    const output = captureOutput();

    expect(runCli(["wt", "on-event"], output.io, dependencies)).toBe(0);
    expect(requested).toEqual([realpathSync(worktreePath)]);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
  });

  it("dispatches project sync through the injected materializing adapter", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-sync-"));
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const worktreePath = join(root, "worktree");
    const siblingPath = join(home, "code", "github.com", "acme", "docs");
    mkdirSync(join(projectRoot, ".agents"), { recursive: true });
    mkdirSync(worktreePath);
    mkdirSync(siblingPath, { recursive: true });
    const sibling = realpathSync(siblingPath);
    writeFileSync(
      join(projectRoot, ".agents", "project.toml"),
      ["[[references]]", 'repo = "github.com/acme/docs"', 'grant = ["tree"]', ""].join("\n"),
    );
    created.push(root);

    const runner = createRecordingRunner({
      [`git -C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`]: result(
        0,
        `${projectRoot}/.git\n`,
      ),
    });
    const output = captureOutput();
    const dependencies = createCliDependencies({
      cwd: worktreePath,
      runner,
      syncReferences: createSyncReferences({
        codeRoot: join(home, "code"),
        platform: "linux",
        runner,
      }),
    });

    expect(runCli(["sync"], output.io, dependencies)).toBe(0);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    expect(
      JSON.parse(readFileSync(join(worktreePath, ".claude", "settings.local.json"), "utf8")),
    ).toEqual({ permissions: { additionalDirectories: [sibling] } });
  });

  it("dispatches plugin install through the injected Herdr client", () => {
    const runner = createRecordingRunner();
    const herdrClient = createFakeHerdrClient({ listPlugins: () => [] });
    const dependencies = createCliDependencies({
      runner,
      herdrClient,
      environment: {
        DEVENV_AGENTS_PLUGIN_PATH: new URL("../plugin", import.meta.url).pathname,
      },
    });
    const output = captureOutput();

    expect(runCli(["plugin", "install"], output.io, dependencies)).toBe(0);
    expect(output.stdout()).toContain("wyattjoh.project-worktrees: linked\n");
    expect(output.stderr()).toBe("");
    expect(runner.calls).toEqual([]);
  });
});
