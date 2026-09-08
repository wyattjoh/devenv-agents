import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./command-runner.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";
import { getWorktreeStatusPaths, type WorktreeStatus } from "./worktree-status.ts";
import { waitForWorktreeStatus } from "./worktree-create.ts";

const created: string[] = [];
const pluginRoot = fileURLToPath(new URL("../plugin", import.meta.url));

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/herdr-0.9.0/${name}`, import.meta.url), "utf8");

const readyPluginList = (): string => {
  const listed = JSON.parse(fixture("plugin-list.json")) as {
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

const makeProject = (
  branch: string,
): {
  readonly mainCheckout: string;
  readonly worktreePath: string;
} => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-create-"));
  const mainCheckoutPath = join(root, "main");
  mkdirSync(mainCheckoutPath, { recursive: true });
  const mainCheckout = realpathSync(mainCheckoutPath);
  const worktreePath = join(mainCheckout, ".claude", "worktrees", branch);
  created.push(root);
  return { mainCheckout, worktreePath };
};

const gitKey = (cwd: string): string =>
  `git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`;

const createKey = (
  mainCheckout: string,
  branch: string,
  worktreePath: string,
  base: string | undefined,
  focus: boolean,
  noFocus: boolean,
): string =>
  [
    "herdr",
    "worktree",
    "create",
    "--cwd",
    mainCheckout,
    "--branch",
    branch,
    ...(base === undefined ? [] : ["--base", base]),
    "--path",
    worktreePath,
    "--label",
    branch.slice(branch.lastIndexOf("/") + 1),
    ...(noFocus ? ["--no-focus"] : focus ? ["--focus"] : []),
  ].join(" ");

const writeStatus = (mainCheckout: string, worktreePath: string, status: WorktreeStatus): void => {
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.statusPath, `${JSON.stringify(status)}\n`, "utf8");
};

const dependencies = (
  cwd: string,
  runner: RecordingRunner,
  readLine: (message?: string) => string = () => "q",
): CliDependencies => ({
  cwd,
  now: () => "2026-09-08T01:00:00.000Z",
  readLine,
  runner,
  syncReferences: () => undefined,
  environment: {},
  pluginPath: undefined,
});

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktree creation", () => {
  it("fails before resolving the project when the plugin is not linked", () => {
    const { mainCheckout } = makeProject("feature");
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify({ result: { plugins: [] } })),
    });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: (text: string) => (output.stdout += text),
      stderr: (text: string) => (output.stderr += text),
    };

    expect(runCli(["wt", "create", "feature"], io, dependencies(mainCheckout, runner))).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe(
      "project wt create: Herdr plugin wyattjoh.project-worktrees is not linked and enabled; run 'project plugin install' first\n",
    );
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
    ]);
  });

  it("creates at the nested path, waits for done, and emits one JSON object", () => {
    const branch = "feature/capture";
    const { mainCheckout, worktreePath } = makeProject(branch);
    const createInvocation = createKey(mainCheckout, branch, worktreePath, "main", false, true);
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, readyPluginList()),
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
      [createInvocation]: () => {
        mkdirSync(worktreePath, { recursive: true });
        writeStatus(mainCheckout, worktreePath, {
          path: worktreePath,
          state: "done",
          started_at: "2026-09-08T01:00:00.000Z",
          finished_at: "2026-09-08T01:00:01.000Z",
        });
        return result(0, fixture("worktree-create.json"));
      },
    });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: (text: string) => (output.stdout += text),
      stderr: (text: string) => (output.stderr += text),
    };

    expect(
      runCli(
        ["wt", "create", branch, "--base", "main", "--no-focus", "--json"],
        io,
        dependencies(mainCheckout, runner),
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      workspace_id: "w3",
      root_pane_id: "w3:p1",
    });
    expect(output.stdout.endsWith("\n")).toBe(true);
    expect(output.stderr).toBe("");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
      ["git", "-C", mainCheckout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      [
        "herdr",
        "worktree",
        "create",
        "--cwd",
        mainCheckout,
        "--branch",
        branch,
        "--base",
        "main",
        "--path",
        worktreePath,
        "--label",
        "capture",
        "--no-focus",
      ],
    ]);
    expect(runner.calls[2]?.cwd).toBe(mainCheckout);
  });

  it("returns the recorded bootstrap error", () => {
    const branch = "feature/broken";
    const { mainCheckout, worktreePath } = makeProject(branch);
    const createInvocation = createKey(mainCheckout, branch, worktreePath, undefined, false, false);
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, readyPluginList()),
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
      [createInvocation]: () => {
        mkdirSync(worktreePath, { recursive: true });
        writeStatus(mainCheckout, worktreePath, {
          path: worktreePath,
          state: "failed",
          error: "devenv shell -- true failed with exit code 1: warm exploded",
          started_at: "2026-09-08T01:00:00.000Z",
          finished_at: "2026-09-08T01:00:02.000Z",
        });
        return result(0, fixture("worktree-create.json"));
      },
    });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: (text: string) => (output.stdout += text),
      stderr: (text: string) => (output.stderr += text),
    };

    expect(runCli(["wt", "create", branch], io, dependencies(mainCheckout, runner))).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe(
      "project wt create: devenv shell -- true failed with exit code 1: warm exploded\n",
    );
  });

  it("prompts for a branch and creates a focused worktree", () => {
    const branch = "feature/from-prompt";
    const { mainCheckout, worktreePath } = makeProject(branch);
    const createInvocation = createKey(mainCheckout, branch, worktreePath, undefined, true, false);
    const prompts: (string | undefined)[] = [];
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, readyPluginList()),
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
      [createInvocation]: () => {
        mkdirSync(worktreePath, { recursive: true });
        writeStatus(mainCheckout, worktreePath, {
          path: worktreePath,
          state: "done",
          started_at: "2026-09-08T01:00:00.000Z",
          finished_at: "2026-09-08T01:00:01.000Z",
        });
        return result(0, fixture("worktree-create.json"));
      },
    });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: (text: string) => (output.stdout += text),
      stderr: (text: string) => (output.stderr += text),
    };

    expect(
      runCli(
        ["wt", "new"],
        io,
        dependencies(mainCheckout, runner, (message) => {
          prompts.push(message);
          return branch;
        }),
      ),
    ).toBe(0);
    expect(prompts).toEqual(["Branch name: "]);
    expect(output.stdout).toBe("Workspace ID: w3\nRoot pane ID: w3:p1\n");
    expect(output.stderr).toBe("");
    expect(runner.calls[2]?.args).toEqual([
      "worktree",
      "create",
      "--cwd",
      mainCheckout,
      "--branch",
      branch,
      "--path",
      worktreePath,
      "--label",
      "from-prompt",
      "--focus",
    ]);
  });

  it("keeps waiting when the status starts running", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-wait-"));
    const statusPath = join(root, "status.json");
    created.push(root);
    writeFileSync(
      statusPath,
      JSON.stringify({
        path: "/tmp/worktree",
        state: "running",
        started_at: "2026-09-08T01:00:00.000Z",
      }),
      "utf8",
    );
    let sleeps = 0;

    expect(
      waitForWorktreeStatus(statusPath, () => {
        sleeps += 1;
        writeFileSync(
          statusPath,
          JSON.stringify({
            path: "/tmp/worktree",
            state: "done",
            started_at: "2026-09-08T01:00:00.000Z",
            finished_at: "2026-09-08T01:00:01.000Z",
          }),
          "utf8",
        );
      }),
    ).toEqual({
      path: "/tmp/worktree",
      state: "done",
      started_at: "2026-09-08T01:00:00.000Z",
      finished_at: "2026-09-08T01:00:01.000Z",
    });
    expect(sleeps).toBe(1);
  });

  it("rejects a disabled plugin before creating a worktree", () => {
    const { mainCheckout } = makeProject("feature");
    const listed = JSON.parse(readyPluginList()) as {
      result: { plugins: Record<string, unknown>[] };
    };
    listed.result.plugins[0].enabled = false;
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify(listed)),
    });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: (text: string) => (output.stdout += text),
      stderr: (text: string) => (output.stderr += text),
    };

    expect(runCli(["wt", "create", "feature"], io, dependencies(mainCheckout, runner))).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });
});
