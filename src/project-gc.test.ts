import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createRecordingRunner,
  type CommandInvocation,
  type CommandResult,
  type RecordingRunner,
} from "./command-runner.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import {
  formatAdoptWorktrees,
  formatProjectGc,
  runAdoptWorktrees,
  runProjectGc,
} from "./project-gc.ts";
import { claimWorktreeStatus } from "./worktree-status.ts";
import { spawnGit } from "./testing/git-env.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const runFixtureGit = (invocation: CommandInvocation): CommandResult =>
  spawnGit(invocation.args, { cwd: invocation.cwd, env: invocation.env });

const git = (repository: string, args: readonly string[]): CommandResult =>
  spawnGit(["-C", repository, ...args], { cwd: undefined, env: undefined });

const requireGit = (repository: string, args: readonly string[], operation: string): void => {
  const command = git(repository, args);
  if (command.exitCode !== 0) {
    throw new Error(`${operation}: ${command.stderr.trim() || command.stdout.trim()}`);
  }
};

const makeProject = (): {
  readonly root: string;
  readonly main: string;
  readonly worktreeRoot: string;
  readonly merged: string;
  readonly unmerged: string;
  readonly dirty: string;
  readonly open: string;
  readonly missing: string;
  readonly orphan: string;
  readonly stray: string;
} => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-gc-"));
  const main = join(root, "main");
  const worktreeRoot = join(main, ".claude", "worktrees");
  const merged = join(worktreeRoot, "merged");
  const unmerged = join(worktreeRoot, "unmerged");
  const dirty = join(worktreeRoot, "dirty");
  const open = join(worktreeRoot, "open");
  const missing = join(worktreeRoot, "missing");
  const orphan = join(worktreeRoot, "orphan");
  const stray = join(worktreeRoot, "stray");
  mkdirSync(main, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(join(main, ".agents"), { recursive: true });
  writeFileSync(join(main, "README.md"), "fixture\n");
  writeFileSync(join(main, ".gitignore"), "target/\nnode_modules/\n");
  writeFileSync(join(main, ".agents", "project.toml"), 'session = "fixture"\n');
  requireGit(main, ["init", "-q", "-b", "main"], "git init");
  requireGit(main, ["add", "README.md", ".gitignore", ".agents/project.toml"], "git add");
  requireGit(
    main,
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      "initial",
    ],
    "git commit",
  );

  for (const [branch, path] of [
    ["feature/merged", merged],
    ["feature/unmerged", unmerged],
    ["feature/dirty", dirty],
    ["feature/open", open],
    ["feature/missing", missing],
  ] as const) {
    requireGit(
      main,
      ["worktree", "add", "-q", "-b", branch, path, "main"],
      `git worktree add ${branch}`,
    );
  }

  writeFileSync(join(merged, "merged.txt"), "merged\n");
  requireGit(merged, ["add", "merged.txt"], "git add merged");
  requireGit(
    merged,
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      "merged",
    ],
    "git commit merged",
  );
  requireGit(main, ["merge", "--ff-only", "feature/merged"], "git merge");

  writeFileSync(join(unmerged, "unmerged.txt"), "unmerged\n");
  requireGit(unmerged, ["add", "unmerged.txt"], "git add unmerged");
  requireGit(
    unmerged,
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      "unmerged",
    ],
    "git commit unmerged",
  );
  writeFileSync(join(dirty, "README.md"), "dirty\n");
  mkdirSync(join(merged, "target"), { recursive: true });
  mkdirSync(join(merged, "node_modules"), { recursive: true });
  writeFileSync(join(merged, "target", "artifact.txt"), "target\n");
  writeFileSync(join(merged, "node_modules", "artifact.txt"), "node modules\n");
  const mergedStatus = claimWorktreeStatus(main, merged, () => "2026-09-08T01:00:00.000Z");
  if (mergedStatus === undefined) throw new Error("failed to claim merged status");
  mergedStatus.write("done", undefined, "2026-09-08T01:00:01.000Z");
  mergedStatus.release();
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "notes.txt"), "not a worktree\n");
  mkdirSync(orphan, { recursive: true });

  const orphanStatus = claimWorktreeStatus(main, orphan, () => "2026-09-08T01:00:00.000Z");
  if (orphanStatus === undefined) throw new Error("failed to claim orphan status");
  orphanStatus.write("done", undefined, "2026-09-08T01:00:01.000Z");
  orphanStatus.release();
  const missingStatus = claimWorktreeStatus(main, missing, () => "2026-09-08T01:00:00.000Z");
  if (missingStatus === undefined) throw new Error("failed to claim missing status");
  missingStatus.write("done", undefined, "2026-09-08T01:00:01.000Z");
  missingStatus.release();
  rmSync(orphan, { recursive: true, force: true });
  rmSync(missing, { recursive: true, force: true });

  created.push(root);
  return { root, main, worktreeRoot, merged, unmerged, dirty, open, missing, orphan, stray };
};

const herdrList = (project: ReturnType<typeof makeProject>): string =>
  JSON.stringify({
    result: {
      source: {
        repo_root: project.main,
        source_checkout_path: project.main,
        source_workspace_id: "root",
      },
      worktrees: [
        {
          branch: "main",
          is_linked_worktree: false,
          is_prunable: false,
          open_workspace_id: "root",
          path: project.main,
        },
        {
          branch: "feature/merged",
          is_linked_worktree: true,
          is_prunable: false,
          open_workspace_id: undefined,
          path: project.merged,
        },
        {
          branch: "feature/unmerged",
          is_linked_worktree: true,
          is_prunable: false,
          open_workspace_id: undefined,
          path: project.unmerged,
        },
        {
          branch: "feature/dirty",
          is_linked_worktree: true,
          is_prunable: false,
          open_workspace_id: undefined,
          path: project.dirty,
        },
        {
          branch: "feature/open",
          is_linked_worktree: true,
          is_prunable: true,
          open_workspace_id: "open-workspace",
          path: project.open,
        },
        {
          branch: "feature/missing",
          is_linked_worktree: true,
          is_prunable: true,
          open_workspace_id: "detached-workspace",
          path: project.missing,
        },
      ],
    },
  });

const gcRunner = (project: ReturnType<typeof makeProject>): RecordingRunner =>
  createRecordingRunner({
    git: runFixtureGit,
    "herdr worktree list": result(0, herdrList(project)),
  });

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

describe("project gc", () => {
  it("classifies worktrees, detached workspaces, stale statuses, and strays without mutating a dry run", () => {
    const project = makeProject();
    const runner = gcRunner(project);

    const report = runProjectGc({
      buildDirectories: undefined,
      dryRun: true,
      herdrPath: undefined,
      projectPath: project.main,
      runner,
    });

    expect(report.removable.map((worktree) => worktree.path)).toEqual([
      realpathSync(project.merged),
    ]);
    expect(report.busy.map((worktree) => [worktree.path, worktree.reason])).toEqual([
      [realpathSync(project.dirty), "worktree is dirty"],
      [realpathSync(project.open), "workspace is open"],
      [realpathSync(project.unmerged), "branch is not merged into the target"],
    ]);
    expect(report.detachedWorkspaces).toEqual([
      { path: resolveMissing(project.missing), workspaceId: "detached-workspace" },
    ]);
    expect(report.staleStatuses).toHaveLength(2);
    expect(report.staleStatuses.map((status) => status.path)).toEqual([
      resolveMissing(project.missing),
      resolveMissing(project.orphan),
    ]);
    expect(report.unregisteredDirectories).toEqual([{ path: realpathSync(project.stray) }]);
    expect(report.removable[0]?.buildDirectories).toEqual([
      join(realpathSync(project.merged), "target"),
      join(realpathSync(project.merged), "node_modules"),
    ]);
    expect(existsSync(join(project.merged, "target"))).toBe(true);
    expect(existsSync(project.stray)).toBe(true);
    expect(runner.calls.filter((call) => call.args[0] === "remove")).toHaveLength(0);
    expect(runner.calls.filter((call) => call.args[0] === "close")).toHaveLength(0);
    expect(formatProjectGc(report)).toContain("Dry run: no changes made.");
  });

  it("removes only the safe set, closes detached workspaces, and preserves branches", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const mergedPath = realpathSync(project.merged);

    const report = runProjectGc({
      buildDirectories: undefined,
      dryRun: false,
      herdrPath: undefined,
      projectPath: project.main,
      runner,
    });

    expect(report.exitCode).toBe(0);
    expect(report.removed).toEqual([mergedPath]);
    expect(report.closedWorkspaces).toEqual(["detached-workspace"]);
    expect(report.deletedStatuses).toHaveLength(3);
    expect(existsSync(project.merged)).toBe(false);
    expect(existsSync(join(project.merged, "target"))).toBe(false);
    expect(existsSync(join(project.merged, "node_modules"))).toBe(false);
    expect(existsSync(project.unmerged)).toBe(true);
    expect(existsSync(project.dirty)).toBe(true);
    expect(existsSync(project.open)).toBe(true);
    expect(existsSync(project.stray)).toBe(true);
    expect(git(project.main, ["show-ref", "--verify", "refs/heads/feature/merged"]).exitCode).toBe(
      0,
    );
    expect(runner.calls.filter((call) => call.args[0] === "branch")).toHaveLength(0);
    expect(formatProjectGc(report)).toContain("Removed worktrees: 1");
  });

  it("keeps build directories when worktree removal fails", () => {
    const project = makeProject();
    const runner = createRecordingRunner({
      git: (invocation) => {
        if (invocation.args.includes("worktree") && invocation.args.includes("remove")) {
          return result(1, "", "removal blocked");
        }
        return runFixtureGit(invocation);
      },
      "herdr worktree list": result(0, herdrList(project)),
    });

    const report = runProjectGc({
      buildDirectories: undefined,
      dryRun: false,
      herdrPath: undefined,
      projectPath: project.main,
      runner,
    });

    expect(report.exitCode).toBe(1);
    expect(report.removed).toEqual([]);
    expect(report.deletedBuildDirectories).toEqual([]);
    expect(existsSync(project.merged)).toBe(true);
    expect(existsSync(join(project.merged, "target"))).toBe(true);
    expect(existsSync(join(project.merged, "node_modules"))).toBe(true);
    expect(report.failures[0]?.action).toBe("remove worktree");
  });
});

describe("adopt-worktrees", () => {
  it("sets up linked worktrees and opens only missing Herdr workspaces", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-adopt-"));
    const main = join(root, "main");
    const worktreeRoot = join(main, ".claude", "worktrees");
    const first = join(worktreeRoot, "first");
    const second = join(worktreeRoot, "second");
    mkdirSync(join(main, ".agents"), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(join(main, "README.md"), "fixture\n");
    writeFileSync(join(main, ".gitignore"), "target/\nnode_modules/\n");
    writeFileSync(join(main, ".agents", "project.toml"), 'session = "fixture"\n');
    requireGit(main, ["init", "-q", "-b", "main"], "git init");
    requireGit(main, ["add", "."], "git add");
    requireGit(
      main,
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-q",
        "-m",
        "initial",
      ],
      "git commit",
    );
    writeFileSync(join(main, "devenv.local.nix"), "{ }: {}\n");
    requireGit(
      main,
      ["worktree", "add", "-q", "-b", "feature/first", first, "main"],
      "git worktree first",
    );
    requireGit(
      main,
      ["worktree", "add", "-q", "-b", "feature/second", second, "main"],
      "git worktree second",
    );
    created.push(root);

    const herdr = JSON.stringify({
      result: {
        worktrees: [
          { is_linked_worktree: false, open_workspace_id: "root", path: main },
          { is_linked_worktree: true, open_workspace_id: undefined, path: first },
          { is_linked_worktree: true, open_workspace_id: "w2", path: second },
        ],
      },
    });
    const runner = createRecordingRunner({
      git: runFixtureGit,
      "herdr worktree list": result(0, herdr),
      "herdr worktree open": result(0),
      devenv: result(0),
    });
    const syncPaths: string[] = [];
    const adopted = runAdoptWorktrees({
      herdrPath: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      projectPath: main,
      runner,
      syncReferences: (request) => syncPaths.push(request.worktreePath),
    });
    expect(adopted.exitCode).toBe(0);
    expect(adopted.items.map((item) => [item.path, item.opened, item.workspaceId])).toEqual([
      [realpathSync(first), true, undefined],
      [realpathSync(second), false, "w2"],
    ]);
    expect(syncPaths).toEqual([realpathSync(first), realpathSync(second)]);
    expect(
      runner.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "open"),
    ).toHaveLength(1);
    expect(formatAdoptWorktrees(adopted)).toContain("Summary: 2 worktrees, exit 0");
  });

  it("continues adoption when opening a workspace throws", () => {
    const project = makeProject();
    const runner = createRecordingRunner({
      git: runFixtureGit,
      herdr: (invocation) => {
        if (invocation.args[0] === "worktree" && invocation.args[1] === "open") {
          throw new Error("workspace service unavailable");
        }
        return result(0);
      },
      "herdr worktree list": result(0, herdrList(project)),
      devenv: result(0),
    });

    const adopted = runAdoptWorktrees({
      herdrPath: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      projectPath: project.main,
      runner,
      syncReferences: () => undefined,
    });
    const existing = adopted.items.filter((item) => item.path !== resolveMissing(project.missing));

    expect(adopted.exitCode).toBe(1);
    expect(existing).toHaveLength(4);
    expect(existing.every((item) => item.setup?.state === "done")).toBe(true);
    expect(existing.filter((item) => item.error === "workspace service unavailable")).toHaveLength(
      3,
    );
    expect(
      runner.calls.filter(
        (call) =>
          call.command === "herdr" && call.args[0] === "worktree" && call.args[1] === "open",
      ),
    ).toHaveLength(3);
  });

  it("wires gc dry-run through the CLI without changing existing dependencies", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const output = captureOutput();
    const dependencies: CliDependencies = {
      cwd: project.main,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
      environment: { PROJECT_PLATFORM: "linux" },
      pluginPath: undefined,
    };

    expect(runCli(["gc", "--dry-run"], output.io, dependencies)).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("Removable worktrees:");
    expect(output.stdout()).toContain("Unregistered directories:");
  });

  it("runs both --all commands for every registered Darwin project", () => {
    const projects = [makeProject(), makeProject()];
    const registryRoot = mkdtempSync(join("/tmp", "devenv-agents-gc-registry-"));
    const projectsFile = join(registryRoot, "projects.toml");
    writeFileSync(
      projectsFile,
      projects
        .map((project, index) =>
          [
            "[[projects]]",
            `repo = ${JSON.stringify(`forge/example/project-${index}`)}`,
            `path = ${JSON.stringify(project.main)}`,
            `session = ${JSON.stringify(`project-${index}`)}`,
            "",
          ].join("\n"),
        )
        .join("\n"),
    );
    created.push(registryRoot);

    let herdrListIndex = 0;
    const runner = createRecordingRunner({
      git: runFixtureGit,
      "herdr worktree list": () => {
        const project = projects[herdrListIndex % projects.length];
        herdrListIndex += 1;
        return result(0, herdrList(project));
      },
    });
    const dependencies: CliDependencies = {
      cwd: projects[0]?.main,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
      environment: { PROJECT_PLATFORM: "darwin", PROJECT_PROJECTS_FILE: projectsFile },
      pluginPath: undefined,
    };

    const gcOutput = captureOutput();
    expect(runCli(["gc", "--all"], gcOutput.io, dependencies)).toBe(0);
    expect(gcOutput.stdout()).toContain(`Project: ${realpathSync(projects[0]!.main)}`);
    expect(gcOutput.stdout()).toContain(`Project: ${realpathSync(projects[1]!.main)}`);
    expect(
      runner.calls
        .filter((call) => call.command === "herdr" && call.args[0] === "workspace")
        .map((call) => call.cwd),
    ).toEqual([realpathSync(projects[0]!.main), realpathSync(projects[1]!.main)]);

    const adoptOutput = captureOutput();
    expect(runCli(["adopt-worktrees", "--all"], adoptOutput.io, dependencies)).toBe(1);
    expect(adoptOutput.stdout()).toContain("[forge/example/project-0] Summary:");
    expect(adoptOutput.stdout()).toContain("[forge/example/project-1] Summary:");
    expect(herdrListIndex).toBe(4);
    expect(
      runner.calls
        .filter((call) => call.command === "herdr" && call.args.join(" ") === "worktree list")
        .map((call) => call.cwd),
    ).toEqual([
      realpathSync(projects[0]!.main),
      realpathSync(projects[1]!.main),
      realpathSync(projects[0]!.main),
      realpathSync(projects[1]!.main),
    ]);
    expect(
      runner.calls
        .filter(
          (call) =>
            call.command === "herdr" && call.args[0] === "worktree" && call.args[1] === "open",
        )
        .map((call) => call.cwd),
    ).toEqual([
      realpathSync(projects[0]!.main),
      realpathSync(projects[0]!.main),
      realpathSync(projects[1]!.main),
      realpathSync(projects[1]!.main),
    ]);
  });
});

const resolveMissing = (path: string): string => join(realpathSync(dirname(path)), basename(path));
