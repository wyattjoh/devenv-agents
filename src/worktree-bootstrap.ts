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
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { errorMessage, runRequiredCommand, type CommandRunner } from "./command-runner.ts";
import type { HerdrClient, HerdrPane } from "./herdr-client.ts";
import { readProjectDeclaration } from "./project-declaration.ts";
import type { SyncReferences } from "./project-sync.ts";
import { canonicalPath, resolveMainCheckout, samePath } from "./workspace.ts";

/**
 * The Herdr plugin identifier used by the setup overlay.
 */
const WORKTREE_PLUGIN_ID = "wyattjoh.project-worktrees";

/**
 * The lifecycle states visible through the bootstrap interface.
 */
type WorktreeBootstrapState = "running" | "done" | "failed";

/**
 * The state returned when no bootstrap record exists.
 */
type WorktreeBootstrapObservedState = WorktreeBootstrapState | "none";

/**
 * A worktree and its owning main checkout.
 */
type WorktreeBootstrapTarget = {
  readonly mainCheckout: string;
  readonly worktreePath: string;
};

/**
 * The result of requesting a setup pane for a worktree.
 */
type WorktreeBootstrapRequestResult = {
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
type WorktreeBootstrapIO = {
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
type WorktreeBootstrapDependencies = {
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
};

/**
 * Options for requesting a setup pane.
 */
type WorktreeBootstrapRequestOptions = WorktreeBootstrapTarget & {
  readonly herdrClient: HerdrClient;
  readonly now: (() => string) | undefined;
};

/**
 * Options for running a bootstrap in the current process.
 */
type WorktreeBootstrapRunOptions = Omit<WorktreeBootstrapTarget, "mainCheckout"> & {
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
type WorktreeBootstrapAwaitOptions = WorktreeBootstrapTarget & {
  readonly deadline: WorktreeBootstrapDeadline;
  readonly now: (() => string) | undefined;
  readonly sleep: (() => void) | undefined;
};

/**
 * The result of awaiting a bootstrap.
 */
type WorktreeBootstrapAwaitResult = {
  readonly state: "done" | "failed" | "timeout";
  readonly error: string | undefined;
};

/**
 * Options for warming a checkout's devenv and direnv environment.
 */
type WorktreeBootstrapWarmOptions = WorktreeBootstrapTarget & {
  readonly runner: CommandRunner;
  readonly devenvTemplate: string | undefined;
  readonly missingDevenvError: string | undefined;
};

/**
 * Options for inspecting a bootstrap.
 */
type WorktreeBootstrapInspectOptions = WorktreeBootstrapTarget;

/**
 * Options for forgetting a bootstrap record.
 */
type WorktreeBootstrapForgetOptions = WorktreeBootstrapTarget;

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

type WorktreeStatusState = "running" | "done" | "failed";

type RunningWorktreeStatus = {
  readonly path: string;
  readonly state: "running";
  readonly started_at: string;
};

type DoneWorktreeStatus = {
  readonly path: string;
  readonly state: "done";
  readonly started_at: string;
  readonly finished_at: string;
};

type FailedWorktreeStatus = {
  readonly path: string;
  readonly state: "failed";
  readonly error: string;
  readonly started_at: string;
  readonly finished_at: string;
};

type WorktreeStatus = RunningWorktreeStatus | DoneWorktreeStatus | FailedWorktreeStatus;

type WorktreeStatusPaths = {
  readonly mainCheckout: string;
  readonly worktreePath: string;
  readonly hash: string;
  readonly directory: string;
  readonly statusPath: string;
  readonly claimPath: string;
};

type WorktreeStatusClaim = {
  readonly paths: WorktreeStatusPaths;
  readonly startedAt: string;
  readonly write: (
    state: WorktreeStatusState,
    error: string | undefined,
    finishedAt: string | undefined,
  ) => void;
  readonly release: () => void;
  readonly handoff: () => void;
  readonly cancelHandoff: () => boolean;
};

const defaultNow = (): string => new Date().toISOString();

const worktreeStatusRoot = (mainCheckout: string): string =>
  join(canonicalPath(mainCheckout), ".devenv", "state", "project", "worktrees");

const SETUP_HANDOFF = ".setup-handoff";

const SETUP_OWNER = ".setup-owner";

const SETUP_CANCELLED = ".setup-cancelled";

const worktreeStatusHash = (canonicalWorktreePath: string): string =>
  createHash("sha1").update(canonicalWorktreePath).digest("hex").slice(0, 16);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

type StatusValue = string | number | boolean | null | readonly StatusValue[] | StatusRecord;

type StatusRecord = { readonly [key: string]: StatusValue };

const isRecord = (value: StatusValue | undefined): value is StatusRecord =>
  value !== null && !Array.isArray(value) && value === Object(value);

const readStatusString = (record: StatusRecord, key: string): string | undefined => {
  const value = record[key];

  return value === String(value) ? value : undefined;
};

const parseStatus = (value: StatusValue | undefined): WorktreeStatus | undefined => {
  if (!isRecord(value)) return undefined;
  const path = readStatusString(value, "path");
  const state = readStatusString(value, "state");
  const startedAt = readStatusString(value, "started_at");

  if (path === undefined || startedAt === undefined) return undefined;

  if (state === "running") return { path, state, started_at: startedAt };

  const finishedAt = readStatusString(value, "finished_at");

  if (finishedAt === undefined) return undefined;

  if (state === "done") return { path, state, started_at: startedAt, finished_at: finishedAt };

  const error = readStatusString(value, "error");

  if (state === "failed" && error !== undefined) {
    return { path, state, error, started_at: startedAt, finished_at: finishedAt };
  }

  return undefined;
};

const writeJsonAtomically = (path: string, value: WorktreeStatus): void => {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporaryPath, path);
};

const getWorktreeStatusPaths = (
  mainCheckout: string,
  worktreePath: string,
): WorktreeStatusPaths => {
  const canonicalMainCheckout = canonicalPath(mainCheckout);
  const canonicalWorktreePath = canonicalPath(worktreePath);
  const hash = worktreeStatusHash(canonicalWorktreePath);
  const directory = join(worktreeStatusRoot(canonicalMainCheckout), hash);

  return {
    mainCheckout: canonicalMainCheckout,
    worktreePath: canonicalWorktreePath,
    hash,
    directory,
    statusPath: join(directory, "status.json"),
    claimPath: join(directory, ".claim"),
  };
};

const readWorktreeStatus = (statusPath: string): WorktreeStatus | undefined => {
  if (!existsSync(statusPath)) return undefined;

  try {
    // SAFETY: The parser result is decoded by parseStatus before use.
    return parseStatus(JSON.parse(readFileSync(statusPath, "utf8")) as StatusValue);
  } catch {
    return undefined;
  }
};

const forgetWorktreeStatus = (mainCheckout: string, worktreePath: string): void => {
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  rmSync(paths.directory, { recursive: true, force: true });
};

const createClaim = (paths: WorktreeStatusPaths, startedAt: string): WorktreeStatusClaim => {
  const handoffPath = join(paths.claimPath, SETUP_HANDOFF);
  let released = false;
  let handedOff = false;

  return {
    paths,
    startedAt,
    write: (state, error, finishedAt) => {
      const timestamp = finishedAt ?? (state === "running" ? undefined : defaultNow());

      if (state === "running") {
        writeJsonAtomically(paths.statusPath, {
          path: paths.worktreePath,
          state,
          started_at: startedAt,
        });

        return;
      }

      if (timestamp === undefined) {
        throw new Error(`Missing finished timestamp for ${state} worktree status`);
      }

      if (state === "done") {
        writeJsonAtomically(paths.statusPath, {
          path: paths.worktreePath,
          state,
          started_at: startedAt,
          finished_at: timestamp,
        });

        return;
      }

      if (error === undefined || error.length === 0) {
        throw new Error("Missing error for failed worktree status");
      }

      writeJsonAtomically(paths.statusPath, {
        path: paths.worktreePath,
        state,
        error,
        started_at: startedAt,
        finished_at: timestamp,
      });
    },
    release: () => {
      if (released) return;
      released = true;
      rmSync(paths.claimPath, { recursive: true, force: true });
    },
    handoff: () => {
      if (released) return;
      mkdirSync(handoffPath);
      handedOff = true;
      released = true;
    },
    cancelHandoff: () => {
      if (!handedOff) {
        if (released) return false;
        released = true;
        rmSync(paths.claimPath, { recursive: true, force: true });

        return true;
      }

      handedOff = false;

      try {
        renameSync(handoffPath, join(paths.claimPath, SETUP_CANCELLED));
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST"))
          return false;
        throw error;
      }

      rmSync(paths.claimPath, { recursive: true, force: true });

      return true;
    },
  };
};

const adoptSetupHandoff = (paths: WorktreeStatusPaths): WorktreeStatusClaim | undefined => {
  const handoffPath = join(paths.claimPath, SETUP_HANDOFF);
  const ownerPath = join(paths.claimPath, SETUP_OWNER);

  try {
    renameSync(handoffPath, ownerPath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST"))
      return undefined;
    throw error;
  }

  const status = readWorktreeStatus(paths.statusPath);

  if (status?.state !== "running") {
    rmSync(paths.claimPath, { recursive: true, force: true });

    return undefined;
  }

  return createClaim(paths, status.started_at);
};

const recoverStaleOwnerClaim = (paths: WorktreeStatusPaths): boolean => {
  if (existsSync(paths.statusPath) || !existsSync(join(paths.claimPath, SETUP_OWNER))) {
    return false;
  }

  rmSync(paths.claimPath, { recursive: true, force: true });

  return true;
};

const claimWorktreeStatus = (
  mainCheckout: string,
  worktreePath: string,
  now: (() => string) | undefined = undefined,
  allowCompleted: boolean | undefined = undefined,
  adoptHandoff: boolean | undefined = undefined,
): WorktreeStatusClaim | undefined => {
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  const current = readWorktreeStatus(paths.statusPath);

  if (current?.state === "done" && allowCompleted !== true) return undefined;

  mkdirSync(dirname(paths.statusPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(paths.claimPath);
      const afterClaim = readWorktreeStatus(paths.statusPath);

      if (afterClaim?.state === "done" && allowCompleted !== true) {
        rmSync(paths.claimPath, { recursive: true, force: true });

        return undefined;
      }

      return createClaim(paths, (now ?? defaultNow)());
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        if (adoptHandoff !== true) return undefined;
        const adopted = adoptSetupHandoff(paths);

        if (adopted !== undefined) return adopted;

        if (recoverStaleOwnerClaim(paths)) continue;

        return undefined;
      }

      rmSync(paths.claimPath, { recursive: true, force: true });
      throw error;
    }
  }

  return undefined;
};

const defaultSleep = (): void => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, 50);
};

const hasDevenvFile = (worktreePath: string): boolean =>
  ["devenv.nix", "devenv.yaml", "devenv.yml"].some((file) => existsSync(join(worktreePath, file)));

const linkLocalLayer = (mainCheckout: string, worktreePath: string): void => {
  if (samePath(mainCheckout, worktreePath)) return;

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
const requestWorktreeBootstrap = (
  options: WorktreeBootstrapRequestOptions,
): WorktreeBootstrapRequestResult => requestOnce(options);

/**
 * Warms one checkout through the shared devenv and direnv ritual.
 *
 * A checkout with devenv files receives a plain `devenv allow`; a checkout
 * without them can use a validated template source. The optional missing-file
 * error lets project add preserve its template hint while bootstrap and update
 * continue to support environments that do not have a devenv file.
 *
 * @param options Main checkout, target worktree, command runner, and template policy.
 * @returns Nothing; approval, linking, and noninteractive warming happen in order.
 * @throws When an external command fails or the caller supplies a missing-file error.
 */
export const warmWorktree = (options: WorktreeBootstrapWarmOptions): void => {
  if (hasDevenvFile(options.worktreePath)) {
    runRequiredCommand(options.runner, "devenv allow", "devenv", ["allow"], {
      cwd: options.worktreePath,
      env: undefined,
    });
  } else if (options.devenvTemplate !== undefined) {
    runRequiredCommand(
      options.runner,
      "devenv template allow",
      "devenv",
      ["--from", options.devenvTemplate, "allow"],
      { cwd: options.worktreePath, env: undefined },
    );
  } else if (options.missingDevenvError !== undefined) {
    throw new Error(options.missingDevenvError);
  }

  runRequiredCommand(options.runner, "direnv allow", "direnv", ["allow"], {
    cwd: options.worktreePath,
    env: undefined,
  });
  linkLocalLayer(options.mainCheckout, options.worktreePath);
  runRequiredCommand(options.runner, "devenv shell -- true", "devenv", ["shell", "--", "true"], {
    cwd: options.worktreePath,
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
    warmWorktree({
      mainCheckout: options.mainCheckout,
      worktreePath: options.worktreePath,
      runner: options.runner,
      devenvTemplate: undefined,
      missingDevenvError: undefined,
    });
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
const runWorktreeBootstrap = (options: WorktreeBootstrapRunOptions): WorktreeBootstrapResult => {
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

  if (deadline === Number(deadline)) return Number(deadline);
  const parsed = Date.parse(String(deadline));

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
const awaitWorktreeBootstrap = (
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
const inspectWorktreeBootstrap = (
  options: WorktreeBootstrapInspectOptions,
): WorktreeBootstrapInspection => currentInspection(options);

/**
 * Forgets all bootstrap state for a worktree.
 *
 * @param options Worktree target.
 * @returns Nothing; missing records are ignored.
 */
const forgetWorktreeBootstrap = (options: WorktreeBootstrapForgetOptions): void => {
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
