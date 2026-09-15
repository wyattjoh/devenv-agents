import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import type { HerdrPlugin } from "./herdr-client.ts";
import { captureOutput, createCliDependencies } from "./testing/cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { createFakeWorktreeBootstrap } from "./testing/worktree-bootstrap.ts";
import { createRecordingRunner, type CommandResult } from "./testing/command-runner.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const projectPlugin = (enabled: boolean): HerdrPlugin => ({
  pluginId: PROJECT_PLUGIN_ID,
  enabled,
  pluginRoot: undefined,
  manifestPath: undefined,
  version: "0.1.0",
});

const makeProject = (branch: string) => {
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

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktree creation", () => {
  it("fails before resolving the project when the plugin is not linked", () => {
    const { mainCheckout } = makeProject("feature");
    const runner = createRecordingRunner();
    const herdrClient = createFakeHerdrClient({ listPlugins: () => [] });
    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", "feature"],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, herdrClient }),
      ),
    ).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(
      "project wt create: Herdr plugin wyattjoh.project-worktrees is not linked and enabled; run 'project plugin install' first\n",
    );
    expect(runner.calls).toEqual([]);
  });

  it("creates at the nested path, awaits bootstrap, and emits one JSON object", () => {
    const branch = "feature/capture";
    const { mainCheckout, worktreePath } = makeProject(branch);
    const awaited: string[] = [];
    const deadlines: number[] = [];

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [projectPlugin(true)],
      createWorktree: () => {
        mkdirSync(worktreePath, { recursive: true });

        return { workspaceId: "w3", rootPaneId: "w3:p1" };
      },
    });

    const bootstrap = createFakeWorktreeBootstrap({
      await: ({ mainCheckout: awaitedMain, worktreePath: awaitedPath, deadline }) => {
        if (deadline !== Number(deadline)) throw new Error("expected a numeric deadline");
        awaited.push(`${awaitedMain}:${awaitedPath}`);
        deadlines.push(Number(deadline));

        return { state: "done", error: undefined };
      },
    });

    const runner = createRecordingRunner({
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
    });

    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", branch, "--base", "main", "--no-focus", "--json"],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, bootstrap, herdrClient }),
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout())).toEqual({
      workspace_id: "w3",
      root_pane_id: "w3:p1",
    });
    expect(output.stdout().endsWith("\n")).toBe(true);
    expect(output.stderr()).toBe("");
    expect(awaited).toEqual([`${mainCheckout}:${realpathSync(worktreePath)}`]);
    expect(deadlines).toEqual([Date.parse("2026-09-08T01:00:00.000Z") + 5 * 60 * 1000]);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["git", "-C", mainCheckout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]);
  });

  it("returns the recorded bootstrap error", () => {
    const branch = "feature/broken";
    const { mainCheckout, worktreePath } = makeProject(branch);

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [projectPlugin(true)],
      createWorktree: () => {
        mkdirSync(worktreePath, { recursive: true });

        return { workspaceId: "w3", rootPaneId: "w3:p1" };
      },
    });

    const bootstrap = createFakeWorktreeBootstrap({
      await: () => ({
        state: "failed",
        error: "devenv shell -- true failed with exit code 1: warm exploded",
      }),
    });

    const runner = createRecordingRunner({
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
    });

    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", branch],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, bootstrap, herdrClient }),
      ),
    ).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("project wt create: devenv shell -- true");
  });

  it("uses the command-level fallback for an unreported bootstrap failure", () => {
    const branch = "feature/unreported-failure";
    const { mainCheckout } = makeProject(branch);

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [projectPlugin(true)],
      createWorktree: () => ({ workspaceId: "w3", rootPaneId: "w3:p1" }),
    });

    const bootstrap = createFakeWorktreeBootstrap({
      await: () => ({ state: "failed", error: undefined }),
    });

    const runner = createRecordingRunner({
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
    });

    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", branch],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, bootstrap, herdrClient }),
      ),
    ).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("project wt create: worktree bootstrap failed\n");
  });

  it("reports a bootstrap timeout as a distinct non-zero outcome", () => {
    const branch = "feature/timeout";
    const { mainCheckout, worktreePath } = makeProject(branch);

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [projectPlugin(true)],
      createWorktree: () => {
        mkdirSync(worktreePath, { recursive: true });

        return { workspaceId: "w3", rootPaneId: "w3:p1" };
      },
    });

    const bootstrap = createFakeWorktreeBootstrap({
      await: () => ({ state: "timeout", error: undefined }),
    });

    const runner = createRecordingRunner({
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
    });

    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", branch],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, bootstrap, herdrClient }),
      ),
    ).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("project wt create: worktree bootstrap timed out\n");
  });

  it("prompts for a branch and creates a focused worktree", () => {
    const branch = "feature/from-prompt";
    const { mainCheckout, worktreePath } = makeProject(branch);
    const prompts: (string | undefined)[] = [];

    const herdrClient = createFakeHerdrClient({
      listPlugins: () => [projectPlugin(true)],
      createWorktree: () => {
        mkdirSync(worktreePath, { recursive: true });

        return { workspaceId: "w3", rootPaneId: "w3:p1" };
      },
    });

    const runner = createRecordingRunner({
      [gitKey(mainCheckout)]: result(0, `${mainCheckout}/.git\n`),
    });

    const output = captureOutput();

    expect(
      runCli(
        ["wt", "new"],
        output.io,
        createCliDependencies({
          cwd: mainCheckout,
          runner,
          herdrClient,
          readLine: (message) => {
            prompts.push(message);

            return branch;
          },
        }),
      ),
    ).toBe(0);
    expect(prompts).toEqual(["Branch name: "]);
    expect(output.stdout()).toBe("Workspace ID: w3\nRoot pane ID: w3:p1\n");
    expect(output.stderr()).toBe("");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["git", "-C", mainCheckout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]);
  });

  it("rejects a disabled plugin before creating a worktree", () => {
    const { mainCheckout } = makeProject("feature");
    const runner = createRecordingRunner();
    const herdrClient = createFakeHerdrClient({ listPlugins: () => [projectPlugin(false)] });
    const output = captureOutput();

    expect(
      runCli(
        ["wt", "create", "feature"],
        output.io,
        createCliDependencies({ cwd: mainCheckout, runner, herdrClient }),
      ),
    ).toBe(1);
    expect(runner.calls).toEqual([]);
  });
});
