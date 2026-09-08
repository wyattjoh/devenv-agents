import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  runCommand,
  runGitCommand,
  type CommandRunner,
  type CommandResult,
} from "./command-runner.ts";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";
import {
  claimWorktreeStatus,
  getWorktreeStatusPaths,
  readWorktreeStatus,
  type WorktreeStatusState,
} from "./worktree-status.ts";

/**
 * The input supplied to the reference synchronization seam.
 */
export type SyncRequest = {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly declaration: ProjectDeclaration;
};

/**
 * Synchronizes one worktree's declared references.
 *
 * The project-sync module supplies the materializing adapter. This seam stays
 * explicit and is invoked even when the declaration contains no references.
 */
export type SyncReferences = {
  /**
   * Materializes the declared references for one worktree.
   *
   * @param request Setup context and normalized project declaration.
   * @returns Nothing; implementations persist any materialized files as their side effect.
   */
  (request: SyncRequest): void;
};

/**
 * Dependencies and paths needed for one worktree setup attempt.
 */
export type WorktreeSetupOptions = {
  readonly worktreePath: string;
  readonly mainCheckout: string | undefined;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
  readonly allowCompleted: boolean | undefined;
};

/**
 * Result of a worktree setup attempt.
 */
export type WorktreeSetupResult = {
  readonly exitCode: number;
  readonly statusPath: string;
  readonly claimPath: string;
  readonly state: WorktreeStatusState | undefined;
  readonly error: string | undefined;
};

/**
 * Resolves the main checkout from Git's shared common directory.
 *
 * @param worktreePath Worktree from which Git should resolve the common directory.
 * @param runner Injected command runner.
 * @returns The canonical main checkout path.
 */
export const resolveMainCheckout = (worktreePath: string, runner: CommandRunner): string => {
  const result = runGitCommand(
    runner,
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktreePath,
  );
  if (result.exitCode !== 0) {
    throw commandFailure("git rev-parse --git-common-dir", result);
  }
  const commonDirectory = result.stdout.trim();
  if (commonDirectory.length === 0) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteCommonDirectory = isAbsolute(commonDirectory)
    ? commonDirectory
    : resolve(worktreePath, commonDirectory);
  return realpathSync(dirname(absoluteCommonDirectory));
};

const commandFailure = (label: string, result: CommandResult): Error => {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return new Error(`${label} failed with exit code ${result.exitCode}: ${detail}`);
};

const runRequiredCommand = (
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  label: string,
  cwd: string,
): void => {
  const result = runCommand(runner, command, args, { cwd, env: undefined });
  if (result.exitCode !== 0) throw commandFailure(label, result);
};

const hasDevenvFile = (worktreePath: string): boolean =>
  ["devenv.nix", "devenv.yaml", "devenv.yml"].some((file) => existsSync(join(worktreePath, file)));

const canonicalComparablePath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const samePath = (left: string, right: string): boolean =>
  canonicalComparablePath(left) === canonicalComparablePath(right);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const linkLocalLayer = (mainCheckout: string, worktreePath: string): void => {
  const source = join(mainCheckout, "devenv.local.nix");
  // A template-bound project may not have a main local layer yet.
  if (!existsSync(source)) return;

  const destination = join(worktreePath, "devenv.local.nix");
  let destinationStats: ReturnType<typeof lstatSync> | undefined;
  try {
    destinationStats = lstatSync(destination);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (destinationStats !== undefined) {
    if (!destinationStats.isSymbolicLink()) {
      throw new Error(`Cannot link ${destination}: a regular file already exists`);
    }
    const target = resolve(dirname(destination), readlinkSync(destination));
    if (samePath(target, source)) return;
    unlinkSync(destination);
  }
  symlinkSync(source, destination);
};

const paneList = (runner: CommandRunner): readonly Record<string, unknown>[] => {
  let result: CommandResult;
  try {
    result = runCommand(runner, "herdr", ["pane", "list"]);
  } catch {
    return [];
  }
  if (result.exitCode !== 0) return [];

  try {
    const envelope = JSON.parse(result.stdout) as unknown;
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("result" in envelope) ||
      typeof envelope.result !== "object" ||
      envelope.result === null ||
      !("panes" in envelope.result) ||
      !Array.isArray(envelope.result.panes)
    ) {
      return [];
    }
    return envelope.result.panes.filter(
      (pane): pane is Record<string, unknown> => typeof pane === "object" && pane !== null,
    );
  } catch {
    return [];
  }
};

const wakeRootPane = (runner: CommandRunner, worktreePath: string): void => {
  const pane = paneList(runner).find(
    (candidate) =>
      typeof candidate.cwd === "string" &&
      typeof candidate.pane_id === "string" &&
      samePath(candidate.cwd, worktreePath),
  );
  if (pane === undefined || typeof pane.pane_id !== "string") return;

  try {
    runCommand(runner, "herdr", ["pane", "send-keys", pane.pane_id, "Enter"]);
  } catch {
    // A setup that succeeded outside Herdr stays successful if the optional wake fails.
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resultFromStatus = (
  statusPath: string,
  claimPath: string,
  state: WorktreeStatusState | undefined,
  error: string | undefined,
): WorktreeSetupResult => ({
  exitCode: error === undefined ? 0 : 1,
  statusPath,
  claimPath,
  state,
  error,
});

/**
 * Runs one complete worktree bootstrap attempt.
 *
 * @param options Setup paths and injected dependencies.
 * @returns The exit code and persisted status locations.
 */
export const runWorktreeSetup = (options: WorktreeSetupOptions): WorktreeSetupResult => {
  const mainCheckout =
    options.mainCheckout ?? resolveMainCheckout(options.worktreePath, options.runner);
  const paths = getWorktreeStatusPaths(mainCheckout, options.worktreePath);
  const claim = claimWorktreeStatus(
    mainCheckout,
    options.worktreePath,
    options.now,
    options.allowCompleted,
    true,
  );
  if (claim === undefined) {
    const status = readWorktreeStatus(paths.statusPath);
    if (status?.state === "done" && options.allowCompleted !== true) {
      return resultFromStatus(paths.statusPath, paths.claimPath, status.state, undefined);
    }
    return resultFromStatus(
      paths.statusPath,
      paths.claimPath,
      status?.state,
      status?.state === "failed" ? status.error : "worktree setup is already claimed",
    );
  }

  try {
    claim.write("running", undefined, undefined);
    const declaration = readProjectDeclaration(mainCheckout);
    if (hasDevenvFile(options.worktreePath)) {
      runRequiredCommand(options.runner, "devenv", ["allow"], "devenv allow", options.worktreePath);
    }
    linkLocalLayer(mainCheckout, options.worktreePath);
    runRequiredCommand(
      options.runner,
      "devenv",
      ["shell", "--", "true"],
      "devenv shell -- true",
      options.worktreePath,
    );
    options.syncReferences({
      projectRoot: mainCheckout,
      worktreePath: options.worktreePath,
      declaration,
    });
    claim.write("done", undefined, (options.now ?? (() => new Date().toISOString()))());
    claim.release();
    wakeRootPane(options.runner, options.worktreePath);
    return resultFromStatus(paths.statusPath, paths.claimPath, "done", undefined);
  } catch (error) {
    const message = errorMessage(error);
    try {
      claim.write("failed", message, (options.now ?? (() => new Date().toISOString()))());
    } finally {
      claim.release();
    }
    return resultFromStatus(paths.statusPath, paths.claimPath, "failed", message);
  }
};

/**
 * Runs setup repeatedly in interactive mode until it succeeds or the user quits.
 *
 * @param options Setup paths and injected dependencies.
 * @param readLine Reads one retry decision; an empty line retries, q/quit exits.
 * @param onFailure Optional callback used to keep the failure and retry prompt visible.
 * @returns The final setup result.
 */
export const runInteractiveWorktreeSetup = (
  options: WorktreeSetupOptions,
  readLine: () => string,
  onFailure: ((result: WorktreeSetupResult) => void) | undefined = undefined,
): WorktreeSetupResult => {
  let result = runWorktreeSetup(options);
  while (result.exitCode !== 0) {
    onFailure?.(result);
    const answer = readLine().trim().toLowerCase();
    if (answer === "q" || answer === "quit" || answer === "exit") return result;
    result = runWorktreeSetup(options);
  }
  return result;
};

/**
 * A no-op synchronization adapter for callers that explicitly do not need
 * reference materialization, such as isolated setup tests.
 *
 * @param request Setup context, including the normalized declaration.
 * @returns Nothing; this adapter intentionally performs no materialization.
 */
export const noOpSyncReferences: SyncReferences = (_request) => undefined;
