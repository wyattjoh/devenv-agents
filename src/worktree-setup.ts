import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { errorMessage, runRequiredCommand, type CommandRunner } from "./command-runner.ts";
import type { HerdrClient, HerdrPane } from "./herdr-client.ts";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";
import { resolveMainCheckout, samePath } from "./workspace.ts";
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
  readonly herdrClient: HerdrClient;
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

const hasDevenvFile = (worktreePath: string): boolean =>
  ["devenv.nix", "devenv.yaml", "devenv.yml"].some((file) => existsSync(join(worktreePath, file)));

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

const wakePaneForWorktree = (herdrClient: HerdrClient, worktreePath: string): void => {
  let panes: readonly HerdrPane[];
  try {
    panes = herdrClient.listPanes();
  } catch {
    return;
  }

  const pane = panes.find(
    (candidate) => candidate.cwd !== undefined && samePath(candidate.cwd, worktreePath),
  );
  if (pane === undefined) return;

  try {
    herdrClient.sendKeys(pane.paneId, "Enter");
  } catch {
    // A setup that succeeded outside Herdr stays successful if the optional wake fails.
  }
};

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
      runRequiredCommand(options.runner, "devenv allow", "devenv", ["allow"], {
        cwd: options.worktreePath,
        env: undefined,
      });
    }
    runRequiredCommand(options.runner, "direnv allow", "direnv", ["allow"], {
      cwd: options.worktreePath,
      env: undefined,
    });
    linkLocalLayer(mainCheckout, options.worktreePath);
    // Warm the profile without opening an interactive nested shell.
    runRequiredCommand(options.runner, "devenv shell -- true", "devenv", ["shell", "--", "true"], {
      cwd: options.worktreePath,
      env: undefined,
    });
    options.syncReferences({
      projectRoot: mainCheckout,
      worktreePath: options.worktreePath,
      declaration,
    });
    claim.write("done", undefined, (options.now ?? (() => new Date().toISOString()))());
    claim.release();
    wakePaneForWorktree(options.herdrClient, options.worktreePath);
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
