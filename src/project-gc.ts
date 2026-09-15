import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  errorMessage,
  runRequiredGitCommand,
  runGitCommand,
  type CommandRunner,
} from "./command-runner.ts";
import type { HerdrClient, HerdrWorktree } from "./herdr-client.ts";
import type {
  WorktreeBootstrap,
  WorktreeBootstrapInspection,
  WorktreeBootstrapResult,
} from "./worktree-bootstrap.ts";
import {
  canonicalPath,
  getManagedWorktreeRoot,
  listLinkedWorktrees,
  resolveMainCheckout,
  samePath,
  worktreeLabel,
  type WorkspaceWorktree,
} from "./workspace.ts";

/**
 * Per-worktree build directories reclaimed by project garbage collection.
 */
const WORKTREE_BUILD_DIRECTORIES = ["target", "node_modules"] as const;

/**
 * One normalized Herdr worktree used by project garbage collection.
 */
type ProjectHerdrWorktree = HerdrWorktree;

/**
 * A worktree that garbage collection may remove after its preflight checks.
 */
type RemovableWorktree = {
  readonly path: string;
  readonly branch: string;
  readonly workspaceId: string | undefined;
  readonly buildDirectories: readonly string[];
  readonly bootstrap: WorktreeBootstrapInspection;
};

/**
 * A worktree retained because it is dirty, unmerged, open, or otherwise unsafe.
 */
type BusyWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly workspaceId: string | undefined;
  readonly reason: string;
  readonly bootstrap: WorktreeBootstrapInspection;
};

/**
 * A Herdr workspace whose checkout has disappeared and can be closed.
 */
type DetachedWorkspace = {
  readonly path: string;
  readonly workspaceId: string;
};

/**
 * A terminal bootstrap record for a missing worktree registration.
 */
type StaleWorktreeStatus = {
  readonly path: string;
  readonly bootstrap: WorktreeBootstrapInspection;
};

/**
 * A directory below `.claude/worktrees` that is not a Git worktree or namespace.
 */
type UnregisteredWorktreeDirectory = {
  readonly path: string;
};

/**
 * The read-only garbage-collection plan for one project.
 */
type ProjectGcPlan = {
  readonly mainCheckout: string;
  readonly targetBranch: string;
  readonly removable: readonly RemovableWorktree[];
  readonly busy: readonly BusyWorktree[];
  readonly detachedWorkspaces: readonly DetachedWorkspace[];
  readonly staleStatuses: readonly StaleWorktreeStatus[];
  readonly unregisteredDirectories: readonly UnregisteredWorktreeDirectory[];
};

/**
 * Inputs for planning and applying project garbage collection.
 */
type ProjectGcOptions = {
  readonly projectPath: string;
  readonly dryRun: boolean;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly bootstrap: WorktreeBootstrap;
  readonly buildDirectories: readonly string[] | undefined;
};

/**
 * A cleanup action that failed after a plan was successfully created.
 */
type ProjectGcFailure = {
  readonly action: string;
  readonly path: string;
  readonly error: string;
};

/**
 * The result of a project garbage-collection run.
 */
export type ProjectGcResult = ProjectGcPlan & {
  readonly dryRun: boolean;
  readonly removed: readonly string[];
  readonly deletedBuildDirectories: readonly string[];
  readonly closedWorkspaces: readonly string[];
  readonly deletedStatuses: readonly string[];
  readonly failures: readonly ProjectGcFailure[];
  readonly exitCode: number;
};

/**
 * Inputs for adopting registered worktrees into the current Herdr session.
 */
type AdoptWorktreesOptions = {
  readonly projectPath: string;
  readonly bootstrap: WorktreeBootstrap;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
};

/**
 * The result for one worktree during adoption.
 */
type AdoptWorktreeItem = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly bootstrap: WorktreeBootstrapResult | undefined;
  readonly opened: boolean;
  readonly workspaceId: string | undefined;
  readonly error: string | undefined;
};

/**
 * The complete result of adopting a project's registered worktrees.
 */
export type AdoptWorktreesResult = {
  readonly mainCheckout: string;
  readonly items: readonly AdoptWorktreeItem[];
  readonly exitCode: number;
};

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isSameOrDescendant = (parent: string, candidate: string): boolean => {
  const child = relative(canonicalPath(parent), canonicalPath(candidate));

  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
};

const currentBranch = (mainCheckout: string, runner: CommandRunner): string => {
  const result = runRequiredGitCommand(
    runner,
    "git symbolic-ref --short HEAD",
    ["-C", mainCheckout, "symbolic-ref", "--short", "HEAD"],
    mainCheckout,
  );

  const branch = result.stdout.trim();

  if (branch.length === 0) throw new Error("main checkout is in a detached HEAD state");

  return branch;
};

const listHerdrWorktrees = (
  herdrClient: HerdrClient,
  mainCheckout: string,
): readonly ProjectHerdrWorktree[] =>
  herdrClient
    .listWorktrees({ cwd: mainCheckout, workspaceId: undefined })
    .filter((worktree) => worktree.linked === true);

const validBuildDirectories = (
  worktreePath: string,
  names: readonly string[] | undefined,
): readonly string[] => {
  const configured = names ?? WORKTREE_BUILD_DIRECTORIES;

  return configured.map((name) => {
    const path = resolve(worktreePath, name);

    if (!isSameOrDescendant(worktreePath, path) || samePath(worktreePath, path)) {
      throw new Error(`Build directory must be below the worktree: ${name}`);
    }

    return path;
  });
};

const existingBuildDirectories = (
  worktreePath: string,
  names: readonly string[] | undefined,
): readonly string[] =>
  validBuildDirectories(worktreePath, names).filter((path) => existsSync(path));

const collectUnregisteredDirectories = (
  mainCheckout: string,
  gitWorktrees: readonly WorkspaceWorktree[],
): readonly UnregisteredWorktreeDirectory[] => {
  const root = getManagedWorktreeRoot(mainCheckout);

  if (!isDirectory(root)) return [];
  const livePaths = gitWorktrees.map((worktree) => worktree.path);
  const unregistered: UnregisteredWorktreeDirectory[] = [];

  const visit = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = canonicalPath(join(parent, entry.name));

      if (livePaths.some((path) => samePath(path, child))) continue;

      if (livePaths.some((path) => isSameOrDescendant(child, path))) {
        visit(child);
        continue;
      }

      unregistered.push({ path: child });
    }
  };

  visit(root);

  return unregistered.toSorted((left, right) => left.path.localeCompare(right.path));
};

const worktreeByPath = (
  worktrees: readonly ProjectHerdrWorktree[],
): ReadonlyMap<string, ProjectHerdrWorktree> =>
  new Map(worktrees.map((worktree) => [canonicalPath(worktree.path), worktree]));

/**
 * Builds a non-mutating cleanup plan for one project's worktrees.
 *
 * @param options Project path and injected Git runner, Herdr client, and bootstrap.
 * @returns Every removable, busy, detached, stale, and unregistered item.
 */
const planProjectGc = (options: Omit<ProjectGcOptions, "dryRun">): ProjectGcPlan => {
  const mainCheckout = resolveMainCheckout(options.projectPath, options.runner);
  const targetBranch = currentBranch(mainCheckout, options.runner);
  const gitWorktrees = listLinkedWorktrees(mainCheckout, options.runner);
  const herdrWorktrees = listHerdrWorktrees(options.herdrClient, mainCheckout);
  const herdrByPath = worktreeByPath(herdrWorktrees);
  const bootstrapByPath = new Map<string, WorktreeBootstrapInspection>();

  const inspectBootstrap = (worktreePath: string): WorktreeBootstrapInspection => {
    const canonical = canonicalPath(worktreePath);
    const existing = bootstrapByPath.get(canonical);

    if (existing !== undefined) return existing;
    const inspection = options.bootstrap.inspect({ mainCheckout, worktreePath });
    bootstrapByPath.set(canonical, inspection);

    return inspection;
  };

  const removable: RemovableWorktree[] = [];
  const busy: BusyWorktree[] = [];

  for (const worktree of gitWorktrees) {
    const herdr = herdrByPath.get(canonicalPath(worktree.path));
    const bootstrap = inspectBootstrap(worktree.path);
    const exists = isDirectory(worktree.path);

    if (bootstrap.state === "running") {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr?.openWorkspaceId,
        reason: "bootstrap is running",
        bootstrap,
      });
      continue;
    }

    if (herdr?.openWorkspaceId !== undefined && !exists) continue;

    if (!exists) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr?.openWorkspaceId,
        reason: "checkout is missing",
        bootstrap,
      });
      continue;
    }

    if (herdr?.openWorkspaceId !== undefined) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr.openWorkspaceId,
        reason: "workspace is open",
        bootstrap,
      });
      continue;
    }

    if (worktree.detached || worktree.branch === undefined) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: undefined,
        reason: "checkout is detached",
        bootstrap,
      });
      continue;
    }

    const statusResult = runRequiredGitCommand(
      options.runner,
      "git status --porcelain",
      ["-C", worktree.path, "status", "--porcelain"],
      worktree.path,
    );

    if (statusResult.stdout.trim().length > 0) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: undefined,
        reason: "worktree is dirty",
        bootstrap,
      });
      continue;
    }

    const merged = runGitCommand(
      options.runner,
      ["-C", mainCheckout, "merge-base", "--is-ancestor", worktree.branch, targetBranch],
      mainCheckout,
    );

    if (merged.exitCode !== 0) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: undefined,
        reason: "branch is not merged into the target",
        bootstrap,
      });
      continue;
    }

    removable.push({
      path: worktree.path,
      branch: worktree.branch,
      workspaceId: undefined,
      buildDirectories: existingBuildDirectories(worktree.path, options.buildDirectories),
      bootstrap,
    });
  }

  const detachedWorkspaces: DetachedWorkspace[] = herdrWorktrees
    .filter(
      (worktree) =>
        worktree.linked && worktree.openWorkspaceId !== undefined && !isDirectory(worktree.path),
    )
    .map((worktree) => ({
      path: canonicalPath(worktree.path),
      // SAFETY: The asserted value is constrained by the surrounding validation or fixture.
      workspaceId: worktree.openWorkspaceId as string,
    }))
    .filter(
      (worktree, index, all) =>
        all.findIndex((candidate) => candidate.workspaceId === worktree.workspaceId) === index,
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));

  const knownWorktreePaths = new Map<string, string>();

  for (const worktree of [...gitWorktrees, ...herdrWorktrees]) {
    const canonical = canonicalPath(worktree.path);
    knownWorktreePaths.set(canonical, worktree.path);
  }

  const staleStatuses: StaleWorktreeStatus[] = [...knownWorktreePaths.entries()]
    .flatMap(([canonical, path]) => {
      if (isDirectory(canonical)) return [];

      const status = {
        path: canonical,
        bootstrap: bootstrapByPath.get(canonical) ?? inspectBootstrap(path),
      };

      return status.bootstrap.state === "none" || status.bootstrap.state === "running"
        ? []
        : [status];
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));

  return {
    mainCheckout,
    targetBranch,
    removable: removable.toSorted((left, right) => left.path.localeCompare(right.path)),
    busy: busy.toSorted((left, right) => left.path.localeCompare(right.path)),
    detachedWorkspaces,
    staleStatuses,
    unregisteredDirectories: collectUnregisteredDirectories(mainCheckout, gitWorktrees),
  };
};

const cleanupFailure = (action: string, path: string, cause: unknown): ProjectGcFailure => ({
  action,
  path,
  error: errorMessage(cause),
});

const applyProjectGc = (
  plan: ProjectGcPlan,
  options: ProjectGcOptions,
): Omit<ProjectGcResult, keyof ProjectGcPlan | "dryRun" | "exitCode"> & {
  readonly failures: readonly ProjectGcFailure[];
} => {
  const removed: string[] = [];
  const deletedBuildDirectories: string[] = [];
  const closedWorkspaces: string[] = [];
  const deletedStatuses: string[] = [];
  const failures: ProjectGcFailure[] = [];

  for (const detached of plan.detachedWorkspaces) {
    try {
      options.herdrClient.closeWorkspace(detached.workspaceId, plan.mainCheckout);
      closedWorkspaces.push(detached.workspaceId);
    } catch (error) {
      failures.push(cleanupFailure("close workspace", detached.path, error));
    }
  }

  for (const worktree of plan.removable) {
    try {
      runRequiredGitCommand(
        options.runner,
        "git worktree remove",
        ["-C", plan.mainCheckout, "worktree", "remove", worktree.path],
        plan.mainCheckout,
      );
      removed.push(worktree.path);
    } catch (error) {
      failures.push(cleanupFailure("remove worktree", worktree.path, error));
      continue;
    }

    for (const buildDirectory of worktree.buildDirectories) {
      try {
        rmSync(buildDirectory, { recursive: true, force: true });
        deletedBuildDirectories.push(buildDirectory);
      } catch (error) {
        failures.push(cleanupFailure("delete build directory", buildDirectory, error));
      }
    }

    if (worktree.bootstrap.state !== "none") {
      try {
        options.bootstrap.forget({
          mainCheckout: plan.mainCheckout,
          worktreePath: worktree.path,
        });
        deletedStatuses.push(worktree.path);
      } catch (error) {
        failures.push(cleanupFailure("remove worktree bootstrap", worktree.path, error));
      }
    }
  }

  for (const stale of plan.staleStatuses) {
    try {
      options.bootstrap.forget({
        mainCheckout: plan.mainCheckout,
        worktreePath: stale.path,
      });
      deletedStatuses.push(stale.path);
    } catch (error) {
      failures.push(cleanupFailure("remove stale bootstrap", stale.path, error));
    }
  }

  return { removed, deletedBuildDirectories, closedWorkspaces, deletedStatuses, failures };
};

/**
 * Plans and optionally applies safe cleanup for one project.
 *
 * Dry runs perform only reads. Real runs remove clean merged worktrees, close
 * detached Herdr workspaces, and delete stale status entries; branches and
 * unregistered directories are never deleted.
 *
 * @param options Project path, mode, and injected command dependencies.
 * @returns The plan, applied actions, and exit code.
 */
export const runProjectGc = (options: ProjectGcOptions): ProjectGcResult => {
  const plan = planProjectGc(options);

  if (options.dryRun) {
    return {
      ...plan,
      dryRun: true,
      removed: [],
      deletedBuildDirectories: [],
      closedWorkspaces: [],
      deletedStatuses: [],
      failures: [],
      exitCode: 0,
    };
  }

  const applied = applyProjectGc(plan, options);

  return {
    ...plan,
    dryRun: false,
    ...applied,
    exitCode: applied.failures.length === 0 ? 0 : 1,
  };
};

const displayBranch = (branch: string | undefined): string => branch ?? "detached";

const formatSection = (title: string, lines: readonly string[]): string =>
  `${title}:\n${lines.length === 0 ? "  (none)" : lines.map((line) => `  ${line}`).join("\n")}`;

/**
 * Formats garbage-collection output as logical records without separators.
 *
 * @param result Garbage-collection plan and applied actions.
 * @returns Ordered report records, including each section's continuation lines.
 */
export const formatProjectGcRecords = (result: ProjectGcResult): readonly string[] => {
  const records: string[] = [`Project: ${result.mainCheckout}`, `Target: ${result.targetBranch}`];

  const section = (title: string, values: readonly string[]): void => {
    records.push(formatSection(title, values));
  };

  section(
    "Removable worktrees",
    result.removable.flatMap((worktree) => [
      `${worktree.path} (${worktree.branch})`,
      ...worktree.buildDirectories.map((directory) => `delete build directory ${directory}`),
    ]),
  );
  section(
    "Busy worktrees",
    result.busy.map(
      (worktree) => `${worktree.path} (${displayBranch(worktree.branch)}: ${worktree.reason})`,
    ),
  );
  section(
    "Detached workspaces",
    result.detachedWorkspaces.map(
      (workspace) => `${workspace.path} (workspace ${workspace.workspaceId})`,
    ),
  );
  section(
    "Stale status entries",
    result.staleStatuses.map((status) => `${status.path} (${status.bootstrap.state})`),
  );
  section(
    "Unregistered directories",
    result.unregisteredDirectories.map((directory) => directory.path),
  );

  if (result.dryRun) {
    records.push("Dry run: no changes made.");
  } else {
    records.push(`Removed worktrees: ${result.removed.length}`);
    records.push(`Closed workspaces: ${result.closedWorkspaces.length}`);
    records.push(`Deleted stale statuses: ${result.deletedStatuses.length}`);

    for (const failure of result.failures) {
      records.push(`Failed to ${failure.action} ${failure.path}: ${failure.error}`);
    }
  }

  return records;
};

/**
 * Formats a garbage-collection result for a human-readable CLI report.
 *
 * @param result Garbage-collection plan and applied actions.
 * @returns A newline-terminated report containing every classification.
 */
export const formatProjectGc = (result: ProjectGcResult): string =>
  `${formatProjectGcRecords(result).join("\n")}\n`;

const worktreeLabelFor = (worktree: WorkspaceWorktree): string =>
  worktree.branch === undefined ? basename(worktree.path) : worktreeLabel(worktree.branch);

const appendError = (current: string | undefined, next: string): string => {
  if (current === undefined) return next;

  return `${current}; ${next}`;
};

const errorSuffix = (error: string | undefined): string => {
  if (error === undefined) return "";

  return `: ${error}`;
};

const openWorktree = (
  options: AdoptWorktreesOptions,
  mainCheckout: string,
  worktree: WorkspaceWorktree,
) => {
  try {
    options.herdrClient.openWorktree({
      cwd: mainCheckout,
      path: worktree.path,
      label: worktreeLabelFor(worktree),
    });

    return { opened: true, error: undefined };
  } catch (error) {
    return { opened: false, error: errorMessage(error) };
  }
};

/**
 * Bootstraps every existing linked worktree and opens missing Herdr workspaces.
 *
 * The main checkout is skipped. Existing workspaces are left untouched; a
 * missing workspace is opened without focus after the bootstrap attempt so failed
 * adoption remains visible and retryable through the plugin overlay.
 *
 * @param options Project path, bootstrap seam, and injected Herdr client.
 * @returns Ordered per-worktree adoption results and an aggregate exit code.
 */
export const runAdoptWorktrees = (options: AdoptWorktreesOptions): AdoptWorktreesResult => {
  const mainCheckout = resolveMainCheckout(options.projectPath, options.runner);
  const gitWorktrees = listLinkedWorktrees(mainCheckout, options.runner);
  const herdrWorktrees = listHerdrWorktrees(options.herdrClient, mainCheckout);
  const herdrByPath = worktreeByPath(herdrWorktrees);
  const items: AdoptWorktreeItem[] = [];

  for (const worktree of gitWorktrees) {
    if (!isDirectory(worktree.path)) {
      items.push({
        path: worktree.path,
        branch: worktree.branch,
        bootstrap: undefined,
        opened: false,
        workspaceId: herdrByPath.get(canonicalPath(worktree.path))?.openWorkspaceId,
        error: "checkout is missing",
      });
      continue;
    }

    let bootstrap: WorktreeBootstrapResult | undefined;
    let error: string | undefined;

    try {
      bootstrap = options.bootstrap.run({
        allowCompleted: true,
        io: undefined,
        mainCheckout,
        worktreePath: worktree.path,
      });
      error = bootstrap.error;
    } catch (caught) {
      error = errorMessage(caught);
    }

    const herdr = herdrByPath.get(canonicalPath(worktree.path));
    let opened = false;

    if (herdr?.openWorkspaceId === undefined) {
      const open = openWorktree(options, mainCheckout, worktree);
      opened = open.opened;
      error = open.error === undefined ? error : appendError(error, open.error);
    }

    items.push({
      path: worktree.path,
      branch: worktree.branch,
      bootstrap,
      opened,
      workspaceId: herdr?.openWorkspaceId,
      error,
    });
  }

  return {
    mainCheckout,
    items,
    exitCode: items.some((item) => item.error !== undefined) ? 1 : 0,
  };
};

/**
 * Formats worktree adoption output as logical records without separators.
 *
 * @param result Adoption result to format.
 * @returns Ordered report records, preserving embedded continuation lines.
 */
export const formatAdoptWorktreesRecords = (result: AdoptWorktreesResult): readonly string[] => {
  const records = [`Project: ${result.mainCheckout}`];

  if (result.items.length === 0) {
    records.push("No linked worktrees found.");
  } else {
    for (const item of result.items) {
      const bootstrapState = item.bootstrap?.state ?? "not-run";

      const workspace = item.opened
        ? "opened"
        : item.workspaceId === undefined
          ? "already absent"
          : `open (${item.workspaceId})`;

      records.push(`${item.path} (${bootstrapState}, ${workspace})${errorSuffix(item.error)}`);
    }
  }

  records.push(`Summary: ${result.items.length} worktrees, exit ${result.exitCode}`);

  return records;
};

/**
 * Formats worktree adoption results for a human-readable CLI response.
 *
 * @param result Adoption result to format.
 * @returns A newline-terminated report.
 */
export const formatAdoptWorktrees = (result: AdoptWorktreesResult): string =>
  `${formatAdoptWorktreesRecords(result).join("\n")}\n`;
