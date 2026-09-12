import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HerdrClient, HerdrWorktree } from "./herdr-client.ts";
import type { WorktreeBootstrap, WorktreeBootstrapInspection } from "./worktree-bootstrap.ts";
import { runCli } from "./cli.ts";
import { captureOutput, createCliDependencies } from "./testing/cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { createFakeWorktreeBootstrap } from "./testing/worktree-bootstrap.ts";
import {
  formatAdoptWorktrees,
  formatProjectGc,
  runAdoptWorktrees,
  runProjectGc,
} from "./project-gc.ts";
import { formatProjectUpdate, runProjectUpdate } from "./project-update.ts";
import { createGitFixture } from "./testing/git-fixture.ts";
import {
  createRecordingRunner,
  type CommandInvocation,
  type CommandResult,
  type RecordingRunner,
} from "./testing/command-runner.ts";
import { spawnGit } from "./testing/git-env.ts";
import { samePath } from "./workspace.ts";

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
  readonly merged: string;
  readonly unmerged: string;
  readonly dirty: string;
  readonly open: string;
  readonly missing: string;
  readonly stray: string;
} => {
  const fixture = createGitFixture({
    prefix: "devenv-agents-gc-",
    branch: "feature/merged",
    worktreeName: "merged",
    env: undefined,
  });
  const { root, repository: main, worktree: merged } = fixture;
  const worktreeRoot = join(main, ".claude", "worktrees");
  const unmerged = join(worktreeRoot, "unmerged");
  const dirty = join(worktreeRoot, "dirty");
  const open = join(worktreeRoot, "open");
  const missing = join(worktreeRoot, "missing");
  const stray = join(worktreeRoot, "stray");
  mkdirSync(worktreeRoot, { recursive: true });

  writeFileSync(join(merged, ".gitignore"), "target/\nnode_modules/\n");
  writeFileSync(join(merged, "merged.txt"), "merged\n");
  requireGit(merged, ["add", ".gitignore", "merged.txt"], "git add merged");
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

  for (const [branch, path] of [
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
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "notes.txt"), "not a worktree\n");
  rmSync(missing, { recursive: true, force: true });

  created.push(root);
  return { root, main, merged, unmerged, dirty, open, missing, stray };
};

const herdrWorktrees = (project: ReturnType<typeof makeProject>): readonly HerdrWorktree[] => [
  {
    branch: "main",
    linked: false,
    openWorkspaceId: "root",
    path: project.main,
    prunable: false,
  },
  {
    branch: "feature/merged",
    linked: true,
    openWorkspaceId: undefined,
    path: project.merged,
    prunable: false,
  },
  {
    branch: "feature/unmerged",
    linked: true,
    openWorkspaceId: undefined,
    path: project.unmerged,
    prunable: false,
  },
  {
    branch: "feature/dirty",
    linked: true,
    openWorkspaceId: undefined,
    path: project.dirty,
    prunable: false,
  },
  {
    branch: "feature/open",
    linked: true,
    openWorkspaceId: "open-workspace",
    path: project.open,
    prunable: true,
  },
  {
    branch: "feature/missing",
    linked: true,
    openWorkspaceId: "detached-workspace",
    path: project.missing,
    prunable: true,
  },
];

const gcRunner = (_project: ReturnType<typeof makeProject>): RecordingRunner =>
  createRecordingRunner({ git: runFixtureGit });

const gcClient = (
  project: ReturnType<typeof makeProject>,
  overrides: Partial<HerdrClient> = {},
): HerdrClient =>
  createFakeHerdrClient({ listWorktrees: () => herdrWorktrees(project), ...overrides });

const bootstrapInspection = (
  state: WorktreeBootstrapInspection["state"],
): WorktreeBootstrapInspection => ({
  state,
  error: undefined,
  startedAt: undefined,
  finishedAt: undefined,
});

const gcBootstrap = (
  project: ReturnType<typeof makeProject>,
  forgotten: string[] = [],
  running: readonly string[] = [],
): WorktreeBootstrap =>
  createFakeWorktreeBootstrap({
    inspect: ({ worktreePath }) => {
      if (running.some((path) => samePath(path, worktreePath))) {
        return bootstrapInspection("running");
      }
      if (samePath(worktreePath, project.merged)) return bootstrapInspection("done");
      if (samePath(worktreePath, project.missing)) return bootstrapInspection("done");
      return bootstrapInspection("none");
    },
    forget: ({ worktreePath }) => forgotten.push(worktreePath),
  });

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project gc", () => {
  it("classifies worktrees, detached workspaces, stale statuses, and strays without mutating a dry run", () => {
    const project = makeProject();
    const runner = gcRunner(project);

    const report = runProjectGc({
      bootstrap: gcBootstrap(project),
      buildDirectories: undefined,
      dryRun: true,
      herdrClient: gcClient(project),
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
    expect(report.staleStatuses).toHaveLength(1);
    expect(report.staleStatuses.map((status) => status.path)).toEqual([
      resolveMissing(project.missing),
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

  it("classifies a live bootstrap as busy through inspect", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const report = runProjectGc({
      bootstrap: gcBootstrap(project, [], [project.merged]),
      buildDirectories: undefined,
      dryRun: true,
      herdrClient: gcClient(project),
      projectPath: project.main,
      runner,
    });

    expect(report.busy).toContainEqual(
      expect.objectContaining({
        path: realpathSync(project.merged),
        reason: "bootstrap is running",
      }),
    );
    expect(report.removable).not.toContainEqual(expect.objectContaining({ path: project.merged }));
  });

  it("ignores a false-linked Herdr workspace when classifying a Git worktree", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const mergedPath = realpathSync(project.merged);
    const report = runProjectGc({
      bootstrap: gcBootstrap(project),
      buildDirectories: undefined,
      dryRun: true,
      herdrClient: createFakeHerdrClient({
        listWorktrees: () => [
          {
            branch: "main",
            linked: false,
            openWorkspaceId: "root",
            path: project.merged,
            prunable: false,
          },
        ],
      }),
      projectPath: project.main,
      runner,
    });

    expect(report.removable).toContainEqual(
      expect.objectContaining({
        branch: "feature/merged",
        path: mergedPath,
        workspaceId: undefined,
      }),
    );
    expect(report.busy).not.toContainEqual(expect.objectContaining({ path: mergedPath }));
  });

  it("shares main-checkout identity between gc and update for a symlinked root", () => {
    const project = makeProject();
    const symlinkedMain = `${project.main}-alias`;
    symlinkSync(project.main, symlinkedMain);
    created.push(symlinkedMain);
    const runner = createRecordingRunner({
      git: runFixtureGit,
      "devenv update agents": result(0),
      "devenv shell -- true": result(0),
    });

    const gc = runProjectGc({
      bootstrap: gcBootstrap(project),
      buildDirectories: undefined,
      dryRun: true,
      herdrClient: gcClient(project),
      projectPath: symlinkedMain,
      runner,
    });
    const update = runProjectUpdate({ projectPath: symlinkedMain, runner });
    const missingPath = resolveMissing(project.missing);

    expect(gc.mainCheckout).toBe(realpathSync(project.main));
    expect(update.mainCheckout).toBe(gc.mainCheckout);
    expect(gc.detachedWorkspaces).toEqual([
      { path: missingPath, workspaceId: "detached-workspace" },
    ]);
    expect(update.items).toContainEqual({
      kind: "worktree",
      path: missingPath,
      success: true,
      error: undefined,
    });
    expect(formatProjectUpdate(update)).toContain(`Worktree (${missingPath}): succeeded`);
  });

  it("removes only the safe set, closes detached workspaces, and preserves branches", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const mergedPath = realpathSync(project.merged);
    const forgotten: string[] = [];

    const report = runProjectGc({
      bootstrap: gcBootstrap(project, forgotten),
      buildDirectories: undefined,
      dryRun: false,
      herdrClient: gcClient(project),
      projectPath: project.main,
      runner,
    });

    expect(report.exitCode).toBe(0);
    expect(report.removed).toEqual([mergedPath]);
    expect(report.closedWorkspaces).toEqual(["detached-workspace"]);
    expect(report.deletedStatuses).toHaveLength(2);
    expect(forgotten).toEqual([mergedPath, resolveMissing(project.missing)]);
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
    });

    const report = runProjectGc({
      bootstrap: gcBootstrap(project),
      buildDirectories: undefined,
      dryRun: false,
      herdrClient: gcClient(project),
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

    const openedPaths: string[] = [];
    const bootstrapRuns: string[] = [];
    const bootstrap = createFakeWorktreeBootstrap({
      run: ({ worktreePath }) => {
        bootstrapRuns.push(worktreePath);
        return { exitCode: 0, state: "done", error: undefined };
      },
    });
    const herdrClient = createFakeHerdrClient({
      listWorktrees: () => [
        {
          branch: undefined,
          linked: false,
          openWorkspaceId: "root",
          path: main,
          prunable: false,
        },
        {
          branch: "feature/first",
          linked: true,
          openWorkspaceId: undefined,
          path: first,
          prunable: false,
        },
        {
          branch: "feature/second",
          linked: true,
          openWorkspaceId: "w2",
          path: second,
          prunable: false,
        },
      ],
      openWorktree: ({ path }) => openedPaths.push(path),
    });
    const runner = createRecordingRunner({
      git: runFixtureGit,
      devenv: result(0),
    });
    const adopted = runAdoptWorktrees({
      bootstrap,
      herdrClient,
      projectPath: main,
      runner,
    });
    expect(adopted.exitCode).toBe(0);
    expect(adopted.items.map((item) => [item.path, item.opened, item.workspaceId])).toEqual([
      [realpathSync(first), true, undefined],
      [realpathSync(second), false, "w2"],
    ]);
    expect(bootstrapRuns).toEqual([realpathSync(first), realpathSync(second)]);
    expect(openedPaths).toEqual([realpathSync(first)]);
    expect(formatAdoptWorktrees(adopted)).toContain("Summary: 2 worktrees, exit 0");
  });

  it("continues adoption when opening a workspace throws", () => {
    const project = makeProject();
    const openedPaths: string[] = [];
    const herdrClient = gcClient(project, {
      openWorktree: ({ path }) => {
        openedPaths.push(path);
        throw new Error("workspace service unavailable");
      },
    });
    const runner = createRecordingRunner({
      git: runFixtureGit,
      devenv: result(0),
    });

    const adopted = runAdoptWorktrees({
      bootstrap: createFakeWorktreeBootstrap(),
      herdrClient,
      projectPath: project.main,
      runner,
    });
    const existing = adopted.items.filter((item) => item.path !== resolveMissing(project.missing));

    expect(adopted.exitCode).toBe(1);
    expect(existing).toHaveLength(4);
    expect(existing.every((item) => item.bootstrap?.state === "done")).toBe(true);
    expect(existing.filter((item) => item.error === "workspace service unavailable")).toHaveLength(
      3,
    );
    expect(openedPaths).toHaveLength(3);
  });

  it("wires gc dry-run through the CLI without changing existing dependencies", () => {
    const project = makeProject();
    const runner = gcRunner(project);
    const output = captureOutput();
    const dependencies = createCliDependencies({
      cwd: project.main,
      runner,
      herdrClient: gcClient(project),
      environment: { PROJECT_PLATFORM: "linux" },
    });

    expect(runCli(["gc", "--dry-run"], output.io, dependencies)).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("Removable worktrees:");
    expect(output.stdout()).toContain("Unregistered directories:");
  });

  it("runs both --all commands for every registered Darwin project", () => {
    const projects = [makeProject(), makeProject()];
    const registrations = projects.map((project, index) => ({
      repo: `forge/example/project-${index}`,
      path: project.main,
      session: `project-${index}`,
    }));

    let herdrListIndex = 0;
    const listedCwds: string[] = [];
    const closedWorkspaces: string[] = [];
    const openedCwds: string[] = [];
    const herdrClient = createFakeHerdrClient({
      listWorktrees: (options) => {
        listedCwds.push(options?.cwd ?? "");
        const project = projects[herdrListIndex % projects.length]!;
        herdrListIndex += 1;
        return herdrWorktrees(project);
      },
      closeWorkspace: (workspaceId, cwd) => closedWorkspaces.push(`${cwd ?? ""}:${workspaceId}`),
      openWorktree: ({ cwd }) => openedCwds.push(cwd),
    });
    const projectPaths = projects.map((project) => ({
      main: realpathSync(project.main),
      merged: realpathSync(project.merged),
      dirty: realpathSync(project.dirty),
      open: realpathSync(project.open),
      unmerged: realpathSync(project.unmerged),
      missing: resolveMissing(project.missing),
      stray: realpathSync(project.stray),
    }));
    const firstMain = projectPaths[0]!.main;
    const runner = createRecordingRunner({
      git: (invocation) => {
        if (invocation.args.includes("merge-base") && invocation.args.includes(firstMain)) {
          return result(1);
        }
        return runFixtureGit(invocation);
      },
    });
    const dependencies = createCliDependencies({
      cwd: projects[0]?.main,
      enumerateProjects: () => registrations,
      runner,
      herdrClient,
      environment: { PROJECT_PLATFORM: "darwin" },
    });

    const gcOutput = captureOutput();
    expect(runCli(["gc", "--all"], gcOutput.io, dependencies)).toBe(0);
    expect(gcOutput.stdout()).toBe(
      [
        `[${registrations[0]!.repo}] Project: ${projectPaths[0]!.main}`,
        `[${registrations[0]!.repo}] Target: main`,
        `[${registrations[0]!.repo}] Removable worktrees:`,
        "  (none)",
        `[${registrations[0]!.repo}] Busy worktrees:`,
        `  ${projectPaths[0]!.merged} (feature/merged: branch is not merged into the target)`,
        `  ${projectPaths[0]!.dirty} (feature/dirty: worktree is dirty)`,
        `  ${projectPaths[0]!.open} (feature/open: workspace is open)`,
        `  ${projectPaths[0]!.unmerged} (feature/unmerged: branch is not merged into the target)`,
        `[${registrations[0]!.repo}] Detached workspaces:`,
        `  ${projectPaths[0]!.missing} (workspace detached-workspace)`,
        `[${registrations[0]!.repo}] Stale status entries:`,
        "  (none)",
        `[${registrations[0]!.repo}] Unregistered directories:`,
        `  ${projectPaths[0]!.stray}`,
        `[${registrations[0]!.repo}] Removed worktrees: 0`,
        `[${registrations[0]!.repo}] Closed workspaces: 1`,
        `[${registrations[0]!.repo}] Deleted stale statuses: 0`,
        `[${registrations[1]!.repo}] Project: ${projectPaths[1]!.main}`,
        `[${registrations[1]!.repo}] Target: main`,
        `[${registrations[1]!.repo}] Removable worktrees:`,
        `  ${projectPaths[1]!.merged} (feature/merged)`,
        `  delete build directory ${projectPaths[1]!.merged}/target`,
        `  delete build directory ${projectPaths[1]!.merged}/node_modules`,
        `[${registrations[1]!.repo}] Busy worktrees:`,
        `  ${projectPaths[1]!.dirty} (feature/dirty: worktree is dirty)`,
        `  ${projectPaths[1]!.open} (feature/open: workspace is open)`,
        `  ${projectPaths[1]!.unmerged} (feature/unmerged: branch is not merged into the target)`,
        `[${registrations[1]!.repo}] Detached workspaces:`,
        `  ${projectPaths[1]!.missing} (workspace detached-workspace)`,
        `[${registrations[1]!.repo}] Stale status entries:`,
        "  (none)",
        `[${registrations[1]!.repo}] Unregistered directories:`,
        `  ${projectPaths[1]!.stray}`,
        `[${registrations[1]!.repo}] Removed worktrees: 1`,
        `[${registrations[1]!.repo}] Closed workspaces: 1`,
        `[${registrations[1]!.repo}] Deleted stale statuses: 0`,
        "",
      ].join("\n"),
    );
    expect(closedWorkspaces).toEqual([
      `${projectPaths[0]!.main}:detached-workspace`,
      `${projectPaths[1]!.main}:detached-workspace`,
    ]);

    const adoptOutput = captureOutput();
    expect(runCli(["adopt-worktrees", "--all"], adoptOutput.io, dependencies)).toBe(1);
    expect(adoptOutput.stdout()).toContain("[forge/example/project-0] Summary:");
    expect(adoptOutput.stdout()).toContain("[forge/example/project-1] Summary:");
    expect(herdrListIndex).toBe(4);
    expect(listedCwds).toEqual([
      projectPaths[0]!.main,
      projectPaths[1]!.main,
      projectPaths[0]!.main,
      projectPaths[1]!.main,
    ]);
    expect(openedCwds).toEqual([
      projectPaths[0]!.main,
      projectPaths[0]!.main,
      projectPaths[0]!.main,
      projectPaths[1]!.main,
      projectPaths[1]!.main,
    ]);
  });
});

const resolveMissing = (path: string): string => join(realpathSync(dirname(path)), basename(path));
