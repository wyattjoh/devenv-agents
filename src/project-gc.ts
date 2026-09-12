import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  errorMessage,
  runRequiredCommand,
  runRequiredGitCommand,
  runGitCommand,
  type CommandRunner,
} from "./command-runner.ts";
import {
  listWorktreeStatuses,
  removeWorktreeStatusEntry,
  worktreeStatusHash,
  type WorktreeStatus,
  type WorktreeStatusEntry,
} from "./worktree-status.ts";
import {
  resolveMainCheckout,
  runWorktreeSetup,
  type SyncReferences,
  type WorktreeSetupResult,
} from "./worktree-setup.ts";

/**
 * Per-worktree build directories reclaimed by project garbage collection.
 */
export const WORKTREE_BUILD_DIRECTORIES = ["target", "node_modules"] as const;

/**
 * One Git worktree as reported by `git worktree list --porcelain`.
 */
export type ProjectGitWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly linked: boolean;
  readonly detached: boolean;
  readonly prunable: boolean;
};

/**
 * One Herdr worktree as reported by `herdr worktree list`.
 */
export type ProjectHerdrWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly linked: boolean;
  readonly openWorkspaceId: string | undefined;
  readonly prunable: boolean;
};

/**
 * A worktree that garbage collection may remove after its preflight checks.
 */
export type RemovableWorktree = {
  readonly path: string;
  readonly branch: string;
  readonly workspaceId: string | undefined;
  readonly buildDirectories: readonly string[];
  readonly statusEntry: WorktreeStatusEntry | undefined;
};

/**
 * A worktree retained because it is dirty, unmerged, open, or otherwise unsafe.
 */
export type BusyWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly workspaceId: string | undefined;
  readonly reason: string;
  readonly status: WorktreeStatus | undefined;
};

/**
 * A Herdr workspace whose checkout has disappeared and can be closed.
 */
export type DetachedWorkspace = {
  readonly path: string;
  readonly workspaceId: string;
};

/**
 * A status entry with no corresponding Git worktree registration.
 */
export type StaleWorktreeStatus = {
  readonly path: string;
  readonly statusPath: string;
  readonly entry: WorktreeStatusEntry;
};

/**
 * A directory below `.claude/worktrees` that is not a Git worktree or namespace.
 */
export type UnregisteredWorktreeDirectory = {
  readonly path: string;
};

/**
 * The read-only garbage-collection plan for one project.
 */
export type ProjectGcPlan = {
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
export type ProjectGcOptions = {
  readonly projectPath: string;
  readonly dryRun: boolean;
  readonly herdrPath: string | undefined;
  readonly runner: CommandRunner;
  readonly buildDirectories: readonly string[] | undefined;
};

/**
 * A cleanup action that failed after a plan was successfully created.
 */
export type ProjectGcFailure = {
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
export type AdoptWorktreesOptions = {
  readonly projectPath: string;
  readonly herdrPath: string | undefined;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
};

/**
 * The result for one worktree during adoption.
 */
export type AdoptWorktreeItem = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly setup: WorktreeSetupResult | undefined;
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

type PorcelainRecord = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly prunable: boolean;
};

type JsonRecord = Record<string, unknown>;

const herdrCommand = (herdrPath: string | undefined): string => herdrPath ?? "herdr";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const readString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const readRecord = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const comparablePath = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const missingParts: string[] = [];
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missingParts.unshift(basename(existing));
      existing = parent;
    }
    return join(realpathSync(existing), ...missingParts);
  }
};

const samePath = (left: string, right: string): boolean =>
  comparablePath(left) === comparablePath(right);

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isSameOrDescendant = (parent: string, candidate: string): boolean => {
  const child = relative(comparablePath(parent), comparablePath(candidate));
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
};

const normalizeBranch = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
};

const parsePorcelainRecords = (stdout: string): readonly PorcelainRecord[] => {
  const records: PorcelainRecord[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const worktreePath = lines
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (worktreePath === undefined || worktreePath.length === 0) {
      throw new Error("git worktree list returned a record without a worktree path");
    }
    records.push({
      path: comparablePath(worktreePath),
      branch: normalizeBranch(
        lines.find((line) => line.startsWith("branch "))?.slice("branch ".length),
      ),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line.startsWith("prunable ")),
    });
  }
  if (records.length === 0) throw new Error("git worktree list returned no worktrees");
  return records;
};

/**
 * Parses Git's porcelain worktree listing into normalized worktree records.
 *
 * @param stdout Porcelain output from `git worktree list --porcelain`.
 * @param mainCheckout Main checkout used to mark the primary entry as unlinked.
 * @returns Normalized Git worktree records.
 */
export const parseProjectGitWorktrees = (
  stdout: string,
  mainCheckout: string,
): readonly ProjectGitWorktree[] => {
  const main = comparablePath(mainCheckout);
  return parsePorcelainRecords(stdout).map((record) => ({
    path: record.path,
    branch: record.branch,
    linked: !samePath(record.path, main),
    detached: record.detached,
    prunable: record.prunable,
  }));
};

const listGitWorktrees = (
  mainCheckout: string,
  runner: CommandRunner,
): readonly ProjectGitWorktree[] => {
  const result = runRequiredGitCommand(
    runner,
    "git worktree list",
    ["-C", mainCheckout, "worktree", "list", "--porcelain"],
    mainCheckout,
  );
  return parseProjectGitWorktrees(result.stdout, mainCheckout);
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

const parseHerdrWorktrees = (stdout: string): readonly ProjectHerdrWorktree[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error("herdr worktree list returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("herdr worktree list returned an invalid envelope");
  const result = readRecord(parsed, "result");
  const worktrees = result?.worktrees;
  if (!Array.isArray(worktrees)) throw new Error("herdr worktree list returned no worktrees");

  return worktrees.flatMap((value) => {
    if (!isRecord(value)) return [];
    const path = readString(value, "path");
    if (path === undefined || path.length === 0) return [];
    return [
      {
        path: comparablePath(path),
        branch: normalizeBranch(readString(value, "branch")),
        linked: value.is_linked_worktree !== false,
        openWorkspaceId: readString(value, "open_workspace_id"),
        prunable: value.is_prunable === true,
      },
    ];
  });
};

const listHerdrWorktrees = (
  options: Pick<ProjectGcOptions, "herdrPath" | "runner">,
  mainCheckout: string,
): readonly ProjectHerdrWorktree[] => {
  const result = runRequiredCommand(
    options.runner,
    "herdr worktree list",
    herdrCommand(options.herdrPath),
    ["worktree", "list"],
    { cwd: mainCheckout, env: undefined },
  );
  return parseHerdrWorktrees(result.stdout);
};

const statusForPath = (
  entries: readonly WorktreeStatusEntry[],
  path: string,
): WorktreeStatusEntry | undefined => {
  const canonical = comparablePath(path);
  const hash = worktreeStatusHash(canonical);
  return entries.find(
    (entry) =>
      entry.hash === hash ||
      (entry.status?.path !== undefined && samePath(entry.status.path, canonical)),
  );
};

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
  gitWorktrees: readonly ProjectGitWorktree[],
): readonly UnregisteredWorktreeDirectory[] => {
  const root = resolve(mainCheckout, ".claude", "worktrees");
  if (!isDirectory(root)) return [];
  const livePaths = gitWorktrees.map((worktree) => worktree.path);
  const unregistered: UnregisteredWorktreeDirectory[] = [];

  const visit = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = comparablePath(join(parent, entry.name));
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
  new Map(worktrees.map((worktree) => [comparablePath(worktree.path), worktree]));

/**
 * Builds a non-mutating cleanup plan for one project's worktrees.
 *
 * @param options Project path and injected Git/Herdr command runner.
 * @returns Every removable, busy, detached, stale, and unregistered item.
 */
export const planProjectGc = (options: Omit<ProjectGcOptions, "dryRun">): ProjectGcPlan => {
  const mainCheckout = resolveMainCheckout(options.projectPath, options.runner);
  const targetBranch = currentBranch(mainCheckout, options.runner);
  const gitWorktrees = listGitWorktrees(mainCheckout, options.runner);
  const herdrWorktrees = listHerdrWorktrees(options, mainCheckout);
  const herdrByPath = worktreeByPath(herdrWorktrees);
  const statusEntries = listWorktreeStatuses(mainCheckout);
  const existingGitWorktrees = gitWorktrees.filter((worktree) => isDirectory(worktree.path));
  const registeredPaths = new Set(
    existingGitWorktrees.map((worktree) => comparablePath(worktree.path)),
  );
  const registeredStatusHashes = new Set(
    existingGitWorktrees.map((worktree) => worktreeStatusHash(comparablePath(worktree.path))),
  );
  const removable: RemovableWorktree[] = [];
  const busy: BusyWorktree[] = [];

  for (const worktree of gitWorktrees.filter((candidate) => candidate.linked)) {
    const herdr = herdrByPath.get(comparablePath(worktree.path));
    const statusEntry = statusForPath(statusEntries, worktree.path);
    const status = statusEntry?.status;
    const statusClaimed =
      statusEntry !== undefined && existsSync(join(statusEntry.directory, ".claim"));
    const exists = isDirectory(worktree.path);

    if (herdr?.openWorkspaceId !== undefined && !exists) continue;
    if (!exists) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr?.openWorkspaceId,
        reason: "checkout is missing",
        status,
      });
      continue;
    }
    if (statusClaimed || status?.state === "running") {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr?.openWorkspaceId,
        reason: "bootstrap is running",
        status,
      });
      continue;
    }
    if (statusEntry !== undefined && status === undefined) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr?.openWorkspaceId,
        reason: "status is invalid",
        status,
      });
      continue;
    }
    if (herdr?.openWorkspaceId !== undefined) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: herdr.openWorkspaceId,
        reason: "workspace is open",
        status,
      });
      continue;
    }
    if (worktree.detached || worktree.branch === undefined) {
      busy.push({
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: undefined,
        reason: "checkout is detached",
        status,
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
        status,
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
        status,
      });
      continue;
    }

    removable.push({
      path: worktree.path,
      branch: worktree.branch,
      workspaceId: undefined,
      buildDirectories: existingBuildDirectories(worktree.path, options.buildDirectories),
      statusEntry,
    });
  }

  const detachedWorkspaces: DetachedWorkspace[] = herdrWorktrees
    .filter(
      (worktree) =>
        worktree.linked && worktree.openWorkspaceId !== undefined && !isDirectory(worktree.path),
    )
    .map((worktree) => ({
      path: worktree.path,
      workspaceId: worktree.openWorkspaceId as string,
    }))
    .filter(
      (worktree, index, all) =>
        all.findIndex((candidate) => candidate.workspaceId === worktree.workspaceId) === index,
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));

  const staleStatuses: StaleWorktreeStatus[] = statusEntries
    .filter((entry) => {
      if (entry.status?.path === undefined) return !registeredStatusHashes.has(entry.hash);
      return !registeredPaths.has(comparablePath(entry.status.path));
    })
    .map((entry) => ({
      path: entry.status?.path ?? entry.statusPath,
      statusPath: entry.statusPath,
      entry,
    }))
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

const cleanupFailure = (action: string, path: string, error: unknown): ProjectGcFailure => ({
  action,
  path,
  error: errorMessage(error),
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
      runRequiredCommand(
        options.runner,
        "herdr workspace close",
        herdrCommand(options.herdrPath),
        ["workspace", "close", detached.workspaceId],
        { cwd: plan.mainCheckout, env: undefined },
      );
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
    if (worktree.statusEntry !== undefined) {
      try {
        removeWorktreeStatusEntry(worktree.statusEntry);
        deletedStatuses.push(worktree.statusEntry.statusPath);
      } catch (error) {
        failures.push(
          cleanupFailure("remove worktree status", worktree.statusEntry.statusPath, error),
        );
      }
    }
  }

  for (const stale of plan.staleStatuses) {
    try {
      removeWorktreeStatusEntry(stale.entry);
      deletedStatuses.push(stale.statusPath);
    } catch (error) {
      failures.push(cleanupFailure("remove stale status", stale.statusPath, error));
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

const formatSection = (title: string, lines: readonly string[]): readonly string[] => [
  `${title}:`,
  ...(lines.length === 0 ? ["  (none)"] : lines.map((line) => `  ${line}`)),
];

/**
 * Formats a garbage-collection result for a human-readable CLI report.
 *
 * @param result Garbage-collection plan and applied actions.
 * @param projectName Optional project prefix used by `--all`.
 * @returns A newline-terminated report containing every classification.
 */
export const formatProjectGc = (
  result: ProjectGcResult,
  projectName: string | undefined = undefined,
): string => {
  const prefix = projectName === undefined ? "" : `[${projectName}] `;
  const lines: string[] = [
    `${prefix}Project: ${result.mainCheckout}`,
    `${prefix}Target: ${result.targetBranch}`,
  ];
  const section = (title: string, values: readonly string[]): void => {
    lines.push(...formatSection(`${prefix}${title}`, values));
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
    result.staleStatuses.map((status) => `${status.statusPath} (${status.path})`),
  );
  section(
    "Unregistered directories",
    result.unregisteredDirectories.map((directory) => directory.path),
  );

  if (result.dryRun) {
    lines.push(`${prefix}Dry run: no changes made.`);
  } else {
    lines.push(`${prefix}Removed worktrees: ${result.removed.length}`);
    lines.push(`${prefix}Closed workspaces: ${result.closedWorkspaces.length}`);
    lines.push(`${prefix}Deleted stale statuses: ${result.deletedStatuses.length}`);
    for (const failure of result.failures) {
      lines.push(`${prefix}Failed to ${failure.action} ${failure.path}: ${failure.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const worktreeLabel = (worktree: ProjectGitWorktree): string => {
  const branch = worktree.branch?.slice(worktree.branch.lastIndexOf("/") + 1);
  return branch === undefined || branch.length === 0 ? basename(worktree.path) : branch;
};

const appendError = (current: string | undefined, next: string): string =>
  current === undefined ? next : `${current}; ${next}`;

const openWorktree = (
  options: AdoptWorktreesOptions,
  mainCheckout: string,
  worktree: ProjectGitWorktree,
): { readonly opened: boolean; readonly error: string | undefined } => {
  try {
    runRequiredCommand(
      options.runner,
      "herdr worktree open",
      herdrCommand(options.herdrPath),
      [
        "worktree",
        "open",
        "--cwd",
        mainCheckout,
        "--path",
        worktree.path,
        "--label",
        worktreeLabel(worktree),
        "--no-focus",
      ],
      { cwd: mainCheckout, env: undefined },
    );
    return { opened: true, error: undefined };
  } catch (error) {
    return { opened: false, error: errorMessage(error) };
  }
};

/**
 * Bootstraps every existing linked worktree and opens missing Herdr workspaces.
 *
 * The main checkout is skipped. Existing workspaces are left untouched; a
 * missing workspace is opened without focus after the setup attempt so failed
 * adoption remains visible and retryable through the plugin overlay.
 *
 * @param options Project path, setup seam, and injected Herdr runner.
 * @returns Ordered per-worktree adoption results and an aggregate exit code.
 */
export const runAdoptWorktrees = (options: AdoptWorktreesOptions): AdoptWorktreesResult => {
  const mainCheckout = resolveMainCheckout(options.projectPath, options.runner);
  const gitWorktrees = listGitWorktrees(mainCheckout, options.runner);
  const herdrWorktrees = listHerdrWorktrees(options, mainCheckout);
  const herdrByPath = worktreeByPath(herdrWorktrees);
  const items: AdoptWorktreeItem[] = [];

  for (const worktree of gitWorktrees.filter((candidate) => candidate.linked)) {
    if (!isDirectory(worktree.path)) {
      items.push({
        path: worktree.path,
        branch: worktree.branch,
        setup: undefined,
        opened: false,
        workspaceId: herdrByPath.get(worktree.path)?.openWorkspaceId,
        error: "checkout is missing",
      });
      continue;
    }

    let setup: WorktreeSetupResult | undefined;
    let error: string | undefined;
    try {
      setup = runWorktreeSetup({
        allowCompleted: true,
        mainCheckout,
        now: options.now,
        runner: options.runner,
        syncReferences: options.syncReferences,
        worktreePath: worktree.path,
      });
      error = setup.error;
    } catch (caught) {
      error = errorMessage(caught);
    }

    const herdr = herdrByPath.get(comparablePath(worktree.path));
    let opened = false;
    if (herdr?.openWorkspaceId === undefined) {
      const open = openWorktree(options, mainCheckout, worktree);
      opened = open.opened;
      error = open.error === undefined ? error : appendError(error, open.error);
    }

    items.push({
      path: worktree.path,
      branch: worktree.branch,
      setup,
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
 * Formats worktree adoption results for a human-readable CLI response.
 *
 * @param result Adoption result to format.
 * @param projectName Optional project prefix used by `--all`.
 * @returns A newline-terminated report.
 */
export const formatAdoptWorktrees = (
  result: AdoptWorktreesResult,
  projectName: string | undefined = undefined,
): string => {
  const prefix = projectName === undefined ? "" : `[${projectName}] `;
  const lines = [`${prefix}Project: ${result.mainCheckout}`];
  if (result.items.length === 0) {
    lines.push(`${prefix}No linked worktrees found.`);
  } else {
    for (const item of result.items) {
      const setupState = item.setup?.state ?? "not-run";
      const workspace = item.opened
        ? "opened"
        : item.workspaceId === undefined
          ? "already absent"
          : `open (${item.workspaceId})`;
      const suffix = item.error === undefined ? "" : `: ${item.error}`;
      lines.push(`${prefix}${item.path} (${setupState}, ${workspace})${suffix}`);
    }
  }
  lines.push(`${prefix}Summary: ${result.items.length} worktrees, exit ${result.exitCode}`);
  return `${lines.join("\n")}\n`;
};
