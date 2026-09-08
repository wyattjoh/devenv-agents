import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The states persisted for one managed worktree bootstrap.
 */
export type WorktreeStatusState = "running" | "done" | "failed";

/**
 * A running worktree status record.
 */
export type RunningWorktreeStatus = {
  readonly path: string;
  readonly state: "running";
  readonly started_at: string;
};

/**
 * A completed worktree status record.
 */
export type DoneWorktreeStatus = {
  readonly path: string;
  readonly state: "done";
  readonly started_at: string;
  readonly finished_at: string;
};

/**
 * A failed worktree status record.
 */
export type FailedWorktreeStatus = {
  readonly path: string;
  readonly state: "failed";
  readonly error: string;
  readonly started_at: string;
  readonly finished_at: string;
};

/**
 * Any status record persisted for a managed worktree.
 */
export type WorktreeStatus = RunningWorktreeStatus | DoneWorktreeStatus | FailedWorktreeStatus;

/**
 * The paths used for one worktree's status record and atomic claim.
 */
export type WorktreeStatusPaths = {
  readonly mainCheckout: string;
  readonly worktreePath: string;
  readonly hash: string;
  readonly directory: string;
  readonly statusPath: string;
  readonly claimPath: string;
};

/**
 * The filesystem claim held while a worktree setup attempt is running.
 */
export type WorktreeStatusClaim = {
  readonly paths: WorktreeStatusPaths;
  readonly startedAt: string;
  /**
   * Writes a lifecycle state while retaining this claim's start time.
   *
   * @param state State to persist.
   * @param error Error text for a failed state, or undefined otherwise.
   * @param finishedAt Completion timestamp for done or failed, or undefined for running.
   */
  readonly write: (
    state: WorktreeStatusState,
    error: string | undefined,
    finishedAt: string | undefined,
  ) => void;
  /**
   * Releases this claim without removing the persisted status record.
   */
  readonly release: () => void;
};

const defaultNow = (): string => new Date().toISOString();

const canonicalPath = (path: string): string => realpathSync(resolve(path));

/**
 * Returns the status-directory hash for an already canonical worktree path.
 *
 * @param canonicalWorktreePath Canonical absolute worktree path.
 * @returns The first sixteen hexadecimal SHA-1 characters.
 */
export const worktreeStatusHash = (canonicalWorktreePath: string): string =>
  createHash("sha1").update(canonicalWorktreePath).digest("hex").slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const parseStatus = (value: unknown): WorktreeStatus | undefined => {
  if (!isRecord(value)) return undefined;
  const path = readString(value, "path");
  const state = readString(value, "state");
  const startedAt = readString(value, "started_at");
  if (path === undefined || startedAt === undefined) return undefined;

  if (state === "running") return { path, state, started_at: startedAt };

  const finishedAt = readString(value, "finished_at");
  if (finishedAt === undefined) return undefined;
  if (state === "done") return { path, state, started_at: startedAt, finished_at: finishedAt };

  const error = readString(value, "error");
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

/**
 * Resolves the canonical status and claim paths for a worktree.
 *
 * @param mainCheckout Canonical main checkout containing `.devenv/state`.
 * @param worktreePath Worktree whose setup is being recorded.
 * @returns The status path and its atomic claim path.
 */
export const getWorktreeStatusPaths = (
  mainCheckout: string,
  worktreePath: string,
): WorktreeStatusPaths => {
  const canonicalMainCheckout = canonicalPath(mainCheckout);
  const canonicalWorktreePath = canonicalPath(worktreePath);
  const hash = worktreeStatusHash(canonicalWorktreePath);
  const directory = join(canonicalMainCheckout, ".devenv", "state", "project", "worktrees", hash);
  return {
    mainCheckout: canonicalMainCheckout,
    worktreePath: canonicalWorktreePath,
    hash,
    directory,
    statusPath: join(directory, "status.json"),
    claimPath: join(directory, ".claim"),
  };
};

/**
 * Reads a worktree status record when the status file exists and is valid.
 *
 * @param statusPath Path to a worktree status JSON file.
 * @returns The parsed status or undefined when no valid record exists.
 */
export const readWorktreeStatus = (statusPath: string): WorktreeStatus | undefined => {
  if (!existsSync(statusPath)) return undefined;
  try {
    return parseStatus(JSON.parse(readFileSync(statusPath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
};

/**
 * Atomically claims a worktree for setup.
 *
 * A completed record is terminal. Failed and running records may be retried when
 * no claim marker is present; the marker itself is created with one atomic mkdir,
 * so concurrent callers cannot both win.
 *
 * @param mainCheckout Main checkout containing the shared state directory.
 * @param worktreePath Worktree to claim.
 * @param now Timestamp factory used for deterministic tests.
 * @param allowCompleted Whether an explicit setup may claim a completed record for repair.
 * @returns A claim handle, or undefined when another setup owns it or it is done.
 */
export const claimWorktreeStatus = (
  mainCheckout: string,
  worktreePath: string,
  now: (() => string) | undefined = undefined,
  allowCompleted: boolean | undefined = undefined,
): WorktreeStatusClaim | undefined => {
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  const current = readWorktreeStatus(paths.statusPath);
  if (current?.state === "done" && allowCompleted !== true) return undefined;

  mkdirSync(dirname(paths.statusPath), { recursive: true });
  try {
    mkdirSync(paths.claimPath);
    const afterClaim = readWorktreeStatus(paths.statusPath);
    if (afterClaim?.state === "done" && allowCompleted !== true) {
      rmSync(paths.claimPath, { recursive: true, force: true });
      return undefined;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return undefined;
    rmSync(paths.claimPath, { recursive: true, force: true });
    throw error;
  }

  const startedAt = (now ?? defaultNow)();
  let released = false;
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
  };
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;
