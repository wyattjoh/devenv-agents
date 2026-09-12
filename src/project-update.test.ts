import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createRecordingRunner,
  realCommandRunner,
  type CommandInvocation,
  type CommandResult,
} from "./command-runner.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { createFakeWorktreeBootstrap } from "./testing/worktree-bootstrap.ts";
import { writeProjectsFile, type ProjectRegistration } from "./project-add.ts";
import { formatProjectUpdate, runProjectUpdate } from "./project-update.ts";
import { createGitFixture } from "./testing/git-fixture.ts";
import { spawnGit } from "./testing/git-env.ts";
import { listLinkedWorktrees } from "./workspace.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const gitResponse = (invocation: CommandInvocation): CommandResult =>
  spawnGit(invocation.args, { cwd: invocation.cwd, env: invocation.env });

const gitRunner = (responses: Record<string, CommandResult | readonly CommandResult[]> = {}) =>
  createRecordingRunner({
    git: gitResponse,
    ...responses,
  });

const createFixture = (prefix: string) =>
  createGitFixture({ prefix, branch: undefined, worktreeName: undefined, env: undefined });

const listedWorktreePaths = (repository: string): readonly string[] =>
  listLinkedWorktrees(repository, realCommandRunner).map((worktree) => worktree.path);

const captureOutput = (): {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
} => {
  let stdout = "";
  let stderr = "";
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  };
};

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project update", () => {
  it("updates the agents input, rebuilds main before worktrees, and continues after a failure", () => {
    const fixture = createFixture("devenv-agents-update-");
    created.push(fixture.root);
    const secondWorktree = join(fixture.root, "second-worktree");
    expect(
      spawnGit(
        [
          "-C",
          fixture.repository,
          "worktree",
          "add",
          "-q",
          "-b",
          "fixture/second",
          secondWorktree,
          "main",
        ],
        { cwd: undefined, env: undefined },
      ).exitCode,
    ).toBe(0);

    const mainCheckout = realpathSync(fixture.repository);
    const worktrees = listedWorktreePaths(fixture.repository);
    expect(worktrees).toHaveLength(2);
    const runner = gitRunner({
      "devenv update agents": result(0),
      "devenv shell -- true": [result(0), result(1, "", "branch lock drift"), result(0)],
    });

    const update = runProjectUpdate({ projectPath: fixture.worktree, runner });

    expect(update.exitCode).toBe(1);
    expect(update.items).toEqual([
      {
        kind: "agents-input",
        path: mainCheckout,
        success: true,
        error: undefined,
      },
      {
        kind: "main",
        path: mainCheckout,
        success: true,
        error: undefined,
      },
      {
        kind: "worktree",
        path: worktrees[0],
        success: false,
        error: expect.stringContaining("devenv shell -- true"),
      },
      {
        kind: "worktree",
        path: worktrees[1],
        success: true,
        error: undefined,
      },
    ]);
    expect(formatProjectUpdate(update)).toContain(
      `Worktree (${worktrees[0]}): failed: devenv shell -- true`,
    );
    expect(
      runner.calls
        .filter((call) => call.command === "devenv" || call.command === "direnv")
        .map((call) => [call.command, ...call.args]),
    ).toEqual([
      ["devenv", "update", "agents"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["direnv", "allow"],
      ["devenv", "shell", "--", "true"],
    ]);
  });

  it("updates a deleted linked worktree from a symlinked project path", () => {
    const fixture = createFixture("devenv-agents-update-deleted-");
    created.push(fixture.root);
    const symlinkedRoot = `${fixture.repository}-alias`;
    symlinkSync(fixture.repository, symlinkedRoot);
    created.push(symlinkedRoot);
    rmSync(fixture.worktree, { recursive: true, force: true });

    const mainCheckout = realpathSync(fixture.repository);
    const missingWorktree = join(realpathSync(fixture.root), "worktree");
    const runner = gitRunner({
      "devenv update agents": result(0),
      "devenv shell -- true": result(0),
    });

    const update = runProjectUpdate({ projectPath: symlinkedRoot, runner });

    expect(update.mainCheckout).toBe(mainCheckout);
    expect(update.items).toEqual([
      { kind: "agents-input", path: mainCheckout, success: true, error: undefined },
      { kind: "main", path: mainCheckout, success: true, error: undefined },
      { kind: "worktree", path: missingWorktree, success: true, error: undefined },
    ]);
  });

  it("captures an agents-input failure while still attempting every rebuild", () => {
    const fixture = createFixture("devenv-agents-update-input-");
    created.push(fixture.root);
    const runner = gitRunner({
      "devenv update agents": result(1, "", "network unavailable"),
      "devenv shell -- true": result(0),
    });

    const update = runProjectUpdate({ projectPath: fixture.repository, runner });

    expect(update.exitCode).toBe(1);
    expect(update.items[0]).toEqual({
      kind: "agents-input",
      path: realpathSync(fixture.repository),
      success: false,
      error: expect.stringContaining("devenv update agents"),
    });
    expect(update.items.slice(1).every((item) => item.success)).toBe(true);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toContainEqual([
      "devenv",
      "shell",
      "--",
      "true",
    ]);
  });

  it("captures a worktree-list failure and still reports the completed steps", () => {
    const fixture = createFixture("devenv-agents-update-list-");
    created.push(fixture.root);
    const runner = createRecordingRunner({
      git: (invocation) =>
        invocation.args.includes("worktree")
          ? result(1, "", "worktree list unavailable")
          : gitResponse(invocation),
      "devenv update agents": result(0),
      "devenv shell -- true": result(0),
    });

    const update = runProjectUpdate({ projectPath: fixture.repository, runner });

    expect(update.exitCode).toBe(1);
    expect(update.items.at(-1)).toEqual({
      kind: "worktree-list",
      path: realpathSync(fixture.repository),
      success: false,
      error: expect.stringContaining("git worktree list"),
    });
    expect(formatProjectUpdate(update)).toContain(
      `Worktree list (${realpathSync(fixture.repository)}): failed: git worktree list`,
    );
  });

  it("prints captured worktree failures and returns non-zero through the CLI", () => {
    const fixture = createFixture("devenv-agents-update-cli-");
    created.push(fixture.root);
    const runner = gitRunner({
      "devenv update agents": result(0),
      "devenv shell -- true": [result(0), result(1, "", "worktree build failed")],
    });
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: fixture.repository,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      bootstrap: createFakeWorktreeBootstrap(),
      herdrClient: createFakeHerdrClient(),
      syncReferences: () => undefined,
      environment: {},
      pluginPath: undefined,
    };

    expect(runCli(["update"], output.io, dependencies)).toBe(1);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain(
      `Worktree (${realpathSync(fixture.worktree)}): failed: devenv shell -- true`,
    );
  });

  it("updates every enumerated Darwin project and prefixes each report", () => {
    const registryRoot = mkdtempSync(join("/tmp", "devenv-agents-update-all-"));
    created.push(registryRoot);
    const projectsFile = join(registryRoot, "projects.toml");
    const firstFixture = createFixture("devenv-agents-update-first-");
    const secondFixture = createFixture("devenv-agents-update-second-");
    created.push(firstFixture.root, secondFixture.root);
    const first: ProjectRegistration = {
      repo: "github.com/example/first",
      path: firstFixture.repository,
      session: "first",
    };
    const second: ProjectRegistration = {
      repo: "github.com/example/second",
      path: secondFixture.repository,
      session: "second",
    };
    writeProjectsFile({ project: first, projectsFile });
    writeProjectsFile({ project: second, projectsFile });
    const runner = gitRunner({
      "devenv update agents": result(0),
      "devenv shell -- true": result(0),
    });
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      bootstrap: createFakeWorktreeBootstrap(),
      herdrClient: createFakeHerdrClient(),
      syncReferences: () => undefined,
      environment: {
        PROJECT_PLATFORM: "darwin",
        PROJECT_HOME: registryRoot,
        PROJECT_PROJECTS_FILE: projectsFile,
      },
      pluginPath: undefined,
    };

    expect(runCli(["update", "--all"], output.io, dependencies)).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain(`[github.com/example/first] Agents input`);
    expect(output.stdout()).toContain(`[github.com/example/second] Agents input`);
    expect(output.stdout()).toContain(`[github.com/example/first] Summary: 3 succeeded, 0 failed`);
    expect(output.stdout()).toContain(`[github.com/example/second] Summary: 3 succeeded, 0 failed`);
  });
});
