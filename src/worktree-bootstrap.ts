/**
 * Bootstrap race protocol:
 *
 * 1. `request` atomically creates the claim directory, persists `running`, and
 *    creates the handoff marker before asking Herdr to open the setup pane.
 * 2. `run` atomically renames the handoff marker to the owner marker. A second
 *    request therefore sees the live claim and cannot open another pane.
 * 3. If pane launch fails, request renames the handoff marker to the cancelled
 *    marker before releasing the claim. Whichever rename wins owns the next
 *    action, so a setup pane that already adopted the claim is never cancelled.
 * 4. The owner writes `done` or `failed` before releasing the claim. A later
 *    run removes an owner marker left without a status and retries the work.
 */
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { errorMessage, runRequiredCommand, type CommandRunner } from "./command-runner.ts";
import type { HerdrClient, HerdrPane } from "./herdr-client.ts";
import { readProjectDeclaration } from "./project-declaration.ts";
import type { SyncReferences } from "./project-sync.ts";
import {
  claimWorktreeStatus,
  forgetWorktreeStatus,
  getWorktreeStatusPaths,
  readWorktreeStatus,
  type WorktreeStatus,
} from "./worktree-bootstrap-state.ts";
import { resolveMainCheckout, samePath } from "./workspace.ts";

/**
 * The Herdr plugin identifier used by the setup overlay.
 */
export const WORKTREE_PLUGIN_ID = "wyattjoh.project-worktrees";

/**
 * The lifecycle states visible through the bootstrap interface.
 */
export type WorktreeBootstrapState = "running" | "done" | "failed";

/**
 * The state returned when no bootstrap record exists.
 */
export type WorktreeBootstrapObservedState = WorktreeBootstrapState | "none";

/**
 * A worktree and its owning main checkout.
 */
export type WorktreeBootstrapTarget = {
  readonly mainCheckout: string;
  readonly worktreePath: string;
};

/**
 * The result of requesting a setup pane for a worktree.
 */
export type WorktreeBootstrapRequestResult = {
  readonly state: WorktreeBootstrapObservedState;
  readonly claimed: boolean;
  readonly opened: boolean;
  readonly error: string | undefined;
};

/**
 * A public view of one persisted bootstrap record.
 */
export type WorktreeBootstrapInspection = {
  readonly state: WorktreeBootstrapObservedState;
  readonly error: string | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
};

/**
 * The result of one bootstrap run.
 */
export type WorktreeBootstrapResult = {
  readonly exitCode: number;
  readonly state: WorktreeBootstrapState | undefined;
  readonly error: string | undefined;
};

/**
 * Interactive input used when a setup pane retries a failed bootstrap.
 */
export type WorktreeBootstrapIO = {
  /**
   * Reads the retry decision. Empty input retries; q, quit, and exit stop.
   */
  readonly readLine: () => string;
  /**
   * Reports a failed attempt before the retry prompt is shown.
   */
  readonly onFailure: ((result: WorktreeBootstrapResult) => void) | undefined;
};

/**
 * Dependencies required to run a bootstrap.
 */
export type WorktreeBootstrapDependencies = {
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
};

/**
 * Options for requesting a setup pane.
 */
export type WorktreeBootstrapRequestOptions = WorktreeBootstrapTarget & {
  readonly herdrClient: HerdrClient;
  readonly now: (() => string) | undefined;
};

/**
 * Options for running a bootstrap in the current process.
 */
export type WorktreeBootstrapRunOptions = Omit<WorktreeBootstrapTarget, "mainCheckout"> & {
  readonly mainCheckout: string | undefined;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
  readonly allowCompleted: boolean | undefined;
  readonly io: WorktreeBootstrapIO | undefined;
};

/**
 * A supported absolute deadline representation for an await operation.
 */
export type WorktreeBootstrapDeadline = string | number | Date;

/**
 * Options for awaiting a terminal bootstrap state.
 */
export type WorktreeBootstrapAwaitOptions = WorktreeBootstrapTarget & {
  readonly deadline: WorktreeBootstrapDeadline;
  readonly now: (() => string) | undefined;
  readonly sleep: (() => void) | undefined;
};

/**
 * The result of awaiting a bootstrap.
 */
export type WorktreeBootstrapAwaitResult = {
  readonly state: "done" | "failed" | "timeout";
  readonly error: string | undefined;
};

/**
 * Options for inspecting a bootstrap.
 */
export type WorktreeBootstrapInspectOptions = WorktreeBootstrapTarget;

/**
 * Options for forgetting a bootstrap record.
 */
export type WorktreeBootstrapForgetOptions = WorktreeBootstrapTarget;

/**
 * The five-verb bootstrap interface used by lifecycle callers.
 */
export interface WorktreeBootstrap {
  /**
   * Claims a worktree, hands the claim to a setup pane, and opens that pane.
   *
   * @param options Worktree target.
   * @returns The request outcome and observed state.
   */
  request(options: WorktreeBootstrapTarget): WorktreeBootstrapRequestResult;
  /**
   * Adopts a handoff or claims and runs a worktree bootstrap.
   *
   * @param options Worktree target and run-specific input.
   * @returns The run outcome.
   */
  run(
    options: Omit<WorktreeBootstrapRunOptions, keyof WorktreeBootstrapDependencies>,
  ): WorktreeBootstrapResult;
  /**
   * Waits for a worktree bootstrap until a caller-supplied deadline.
   *
   * @param options Worktree target, deadline, and wait seams.
   * @returns A terminal or timeout outcome.
   */
  await(options: Omit<WorktreeBootstrapAwaitOptions, "now">): WorktreeBootstrapAwaitResult;
  /**
   * Reads the public bootstrap state for a worktree.
   *
   * @param options Worktree target.
   * @returns The observed lifecycle state and available error/timestamps.
   */
  inspect(options: WorktreeBootstrapInspectOptions): WorktreeBootstrapInspection;
  /**
   * Removes a worktree bootstrap record.
   *
   * @param options Worktree target.
   * @returns Nothing; missing records are ignored.
   */
  forget(options: WorktreeBootstrapForgetOptions): void;
}

const defaultNow = (): string => new Date().toISOString();

const defaultSleep = (): void => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, 50);
};

const hasDevenvFile = (worktreePath: string): boolean =>
  ["devenv.nix", "devenv.yaml", "devenv.yml"].some((file) => existsSync(join(worktreePath, file)));

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const linkLocalLayer = (mainCheckout: string, worktreePath: string): void => {
  const source = join(mainCheckout, "devenv.local.nix");
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
    const target = resolvePath(dirname(destination), readlinkSync(destination));
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
    // A successful bootstrap remains successful when the optional wake fails.
  }
};

const inspectionFromStatus = (status: WorktreeStatus | undefined): WorktreeBootstrapInspection => {
  if (status === undefined) {
    return { state: "none", error: undefined, startedAt: undefined, finishedAt: undefined };
  }
  if (status.state === "running") {
    return {
      state: "running",
      error: undefined,
      startedAt: status.started_at,
      finishedAt: undefined,
    };
  }
  return {
    state: status.state,
    error: status.state === "failed" ? status.error : undefined,
    startedAt: status.started_at,
    finishedAt: status.finished_at,
  };
};

const currentInspection = (options: WorktreeBootstrapTarget): WorktreeBootstrapInspection => {
  const paths = getWorktreeStatusPaths(options.mainCheckout, options.worktreePath);
  const status = readWorktreeStatus(paths.statusPath);
  if (existsSync(paths.claimPath)) {
    return {
      state: "running",
      error: undefined,
      startedAt: status?.started_at,
      finishedAt: undefined,
    };
  }
  return inspectionFromStatus(status);
};

const requestOnce = (options: WorktreeBootstrapRequestOptions): WorktreeBootstrapRequestResult => {
  const paths = getWorktreeStatusPaths(options.mainCheckout, options.worktreePath);
  const claim = claimWorktreeStatus(options.mainCheckout, options.worktreePath, options.now);
  if (claim === undefined) {
    const inspection = currentInspection(options);
    return {
      state: inspection.state,
      claimed: false,
      opened: false,
      error: inspection.state === "failed" ? inspection.error : undefined,
    };
  }

  try {
    claim.write("running", undefined, undefined);
    claim.handoff();
    options.herdrClient.openPluginPane({
      pluginId: WORKTREE_PLUGIN_ID,
      entrypoint: "setup",
      placement: "overlay",
      cwd: options.worktreePath,
    });
    return { state: "running", claimed: true, opened: true, error: undefined };
  } catch (error) {
    const message = errorMessage(error);
    let ownsClaim = false;
    try {
      ownsClaim = claim.cancelHandoff();
    } catch {
      // Request remains fail-open when claim cleanup itself fails.
    }
    if (ownsClaim) {
      try {
        claim.write("failed", message, (options.now ?? defaultNow)());
      } catch {
        // Request remains fail-open when status persistence itself fails.
      }
    }
    const inspection = currentInspection({
      mainCheckout: paths.mainCheckout,
      worktreePath: paths.worktreePath,
    });
    return {
      state: inspection.state,
      claimed: true,
      opened: false,
      error: message,
    };
  }
};

/**
 * Requests a setup pane for a worktree exactly once.
 *
 * The claim is acquired before any Herdr call. Duplicate requests observe the
 * live claim and do not open another pane. Herdr pane launch is fail-open: a
 * launch error is recorded for retry, but is returned as an ordinary result.
 *
 * @param options Worktree target, Herdr client, and timestamp factory.
 * @returns The request outcome and observed state.
 */
export const requestWorktreeBootstrap = (
  options: WorktreeBootstrapRequestOptions,
): WorktreeBootstrapRequestResult => requestOnce(options);

const warmWorktree = (mainCheckout: string, worktreePath: string, runner: CommandRunner): void => {
  if (hasDevenvFile(worktreePath)) {
    runRequiredCommand(runner, "devenv allow", "devenv", ["allow"], {
      cwd: worktreePath,
      env: undefined,
    });
  }
  runRequiredCommand(runner, "direnv allow", "direnv", ["allow"], {
    cwd: worktreePath,
    env: undefined,
  });
  linkLocalLayer(mainCheckout, worktreePath);
  runRequiredCommand(runner, "devenv shell -- true", "devenv", ["shell", "--", "true"], {
    cwd: worktreePath,
    env: undefined,
  });
};

type ResolvedWorktreeBootstrapRunOptions = Omit<WorktreeBootstrapRunOptions, "mainCheckout"> & {
  readonly mainCheckout: string;
};

const resolveRunOptions = (
  options: WorktreeBootstrapRunOptions,
): ResolvedWorktreeBootstrapRunOptions => ({
  ...options,
  mainCheckout: options.mainCheckout ?? resolveMainCheckout(options.worktreePath, options.runner),
});

const resultForClaimFailure = (
  options: ResolvedWorktreeBootstrapRunOptions,
): WorktreeBootstrapResult => {
  const inspection = currentInspection(options);
  if (inspection.state === "done" && options.allowCompleted !== true) {
    return { exitCode: 0, state: "done", error: undefined };
  }
  return {
    exitCode: 1,
    state: inspection.state === "none" ? undefined : inspection.state,
    error:
      inspection.state === "failed" ? inspection.error : "worktree bootstrap is already claimed",
  };
};

const runOnce = (options: ResolvedWorktreeBootstrapRunOptions): WorktreeBootstrapResult => {
  const claim = claimWorktreeStatus(
    options.mainCheckout,
    options.worktreePath,
    options.now,
    options.allowCompleted,
    true,
  );
  if (claim === undefined) return resultForClaimFailure(options);

  try {
    claim.write("running", undefined, undefined);
    const declaration = readProjectDeclaration(options.mainCheckout);
    warmWorktree(options.mainCheckout, options.worktreePath, options.runner);
    options.syncReferences({
      projectRoot: options.mainCheckout,
      worktreePath: options.worktreePath,
      declaration,
    });
    claim.write("done", undefined, (options.now ?? defaultNow)());
    claim.release();
    wakePaneForWorktree(options.herdrClient, options.worktreePath);
    return { exitCode: 0, state: "done", error: undefined };
  } catch (error) {
    const message = errorMessage(error);
    try {
      claim.write("failed", message, (options.now ?? defaultNow)());
    } finally {
      claim.release();
    }
    return { exitCode: 1, state: "failed", error: message };
  }
};

/**
 * Runs a complete bootstrap in the current process.
 *
 * A run adopts an existing setup handoff when present. Otherwise it takes a
 * fresh claim. The ordered work is devenv approval, direnv approval, local
 * layer linking, noninteractive warm-up, and reference synchronization. An
 * optional IO object turns the one-attempt operation into the interactive retry
 * loop used by the setup pane.
 *
 * @param options Worktree target, command seams, sync seam, and retry input.
 * @returns The run outcome and any captured error.
 */
export const runWorktreeBootstrap = (
  options: WorktreeBootstrapRunOptions,
): WorktreeBootstrapResult => {
  const resolved = resolveRunOptions(options);
  let result = runOnce(resolved);
  while (result.exitCode !== 0 && options.io !== undefined) {
    options.io.onFailure?.(result);
    const answer = options.io.readLine().trim().toLowerCase();
    if (answer === "q" || answer === "quit" || answer === "exit") return result;
    result = runOnce(resolved);
  }
  return result;
};

const deadlineMilliseconds = (deadline: WorktreeBootstrapDeadline): number => {
  if (deadline instanceof Date) return deadline.getTime();
  if (typeof deadline === "number") return deadline;
  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) throw new Error(`Invalid bootstrap deadline: ${deadline}`);
  return parsed;
};

const clockMilliseconds = (now: (() => string) | undefined): number => {
  const parsed = Date.parse((now ?? defaultNow)());
  if (Number.isNaN(parsed)) throw new Error("Invalid bootstrap clock value");
  return parsed;
};

/**
 * Awaits a bootstrap until it reaches done or failed, or a deadline elapses.
 *
 * @param options Worktree target, absolute deadline, clock, and sleep seam.
 * @returns The terminal state or a distinct timeout outcome.
 */
export const awaitWorktreeBootstrap = (
  options: WorktreeBootstrapAwaitOptions,
): WorktreeBootstrapAwaitResult => {
  const deadline = deadlineMilliseconds(options.deadline);
  for (;;) {
    const inspection = currentInspection(options);
    if (inspection.state === "done" || inspection.state === "failed") {
      return { state: inspection.state, error: inspection.error };
    }
    if (clockMilliseconds(options.now) >= deadline) {
      return { state: "timeout", error: undefined };
    }
    (options.sleep ?? defaultSleep)();
  }
};

/**
 * Inspects a worktree's bootstrap state without exposing its storage layout.
 *
 * A live claim wins over a terminal record while the owner is finishing its
 * atomic write-and-release sequence.
 *
 * @param options Worktree target.
 * @returns The observed state and public lifecycle metadata.
 */
export const inspectWorktreeBootstrap = (
  options: WorktreeBootstrapInspectOptions,
): WorktreeBootstrapInspection => currentInspection(options);

/**
 * Forgets all bootstrap state for a worktree.
 *
 * @param options Worktree target.
 * @returns Nothing; missing records are ignored.
 */
export const forgetWorktreeBootstrap = (options: WorktreeBootstrapForgetOptions): void => {
  forgetWorktreeStatus(options.mainCheckout, options.worktreePath);
};

/**
 * Creates a bootstrap object with shared command, Herdr, sync, and clock seams.
 *
 * @param dependencies Dependencies reused by the five verbs.
 * @returns A worktree bootstrap interface.
 */
export const createWorktreeBootstrap = (
  dependencies: WorktreeBootstrapDependencies,
): WorktreeBootstrap => ({
  request: (options) =>
    requestWorktreeBootstrap({
      ...options,
      herdrClient: dependencies.herdrClient,
      now: dependencies.now,
    }),
  run: (options) =>
    runWorktreeBootstrap({
      ...options,
      herdrClient: dependencies.herdrClient,
      runner: dependencies.runner,
      syncReferences: dependencies.syncReferences,
      now: dependencies.now,
    }),
  await: (options) => awaitWorktreeBootstrap({ ...options, now: dependencies.now }),
  inspect: inspectWorktreeBootstrap,
  forget: forgetWorktreeBootstrap,
});
