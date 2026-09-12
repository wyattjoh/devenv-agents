import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPath, getWorktreeStatusRoot } from "./workspace.ts";

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
 * A status entry discovered beneath a project's shared status root.
 */
export type WorktreeStatusEntry = {
  readonly hash: string;
  readonly directory: string;
  readonly statusPath: string;
  readonly status: WorktreeStatus | undefined;
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
  /**
   * Transfers this claim to the setup process launched by the event hook.
   *
   * The claim remains held until setup adopts and releases it, preventing a
   * paired Herdr event from opening a second overlay in the handoff window.
   */
  readonly handoff: () => void;
  /**
   * Cancels an event-to-setup handoff, or releases an untransferred claim.
   */
  readonly cancelHandoff: () => boolean;
};

const defaultNow = (): string => new Date().toISOString();
const SETUP_HANDOFF = ".setup-handoff";
const SETUP_OWNER = ".setup-owner";
const SETUP_CANCELLED = ".setup-cancelled";

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
  const directory = join(getWorktreeStatusRoot(canonicalMainCheckout), hash);
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
 * Lists status entries recorded for a project, including malformed records.
 *
 * Malformed entries are returned with an undefined status so cleanup can report
 * and remove them rather than silently leaving an orphaned marker behind.
 *
 * @param mainCheckout Main checkout containing the shared status root.
 * @returns Status entries sorted by their hash directory.
 */
export const listWorktreeStatuses = (mainCheckout: string): readonly WorktreeStatusEntry[] => {
  const root = getWorktreeStatusRoot(mainCheckout);
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(root, entry.name);
      const statusPath = join(directory, "status.json");
      const claimPath = join(directory, ".claim");
      if (!existsSync(statusPath) && !existsSync(claimPath)) return [];
      return [{ hash: entry.name, directory, statusPath, status: readWorktreeStatus(statusPath) }];
    })
    .toSorted((left, right) => left.hash.localeCompare(right.hash));
};

/**
 * Removes a discovered status entry and any claim markers below it.
 *
 * @param entry Status entry returned by {@link listWorktreeStatuses}.
 * @returns Nothing; missing entries are ignored.
 */
export const removeWorktreeStatusEntry = (entry: WorktreeStatusEntry): void => {
  rmSync(entry.directory, { recursive: true, force: true });
};

/**
 * Removes the private bootstrap record for a worktree.
 *
 * @param mainCheckout Main checkout containing the shared status root.
 * @param worktreePath Worktree whose record should be removed.
 * @returns Nothing; missing records are ignored.
 */
export const forgetWorktreeStatus = (mainCheckout: string, worktreePath: string): void => {
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
      // Setup and cancellation race by renaming the marker. Whichever rename
      // wins owns the next action; cancellation cannot remove setup's claim.
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

/**
 * Atomically claims a worktree for setup.
 *
 * A completed record is terminal. Failed and running records may be retried when
 * no claim marker is present; the marker itself is created with one atomic mkdir,
 * so concurrent callers cannot both win. Event hooks can hand their claim to the
 * setup overlay; setup opts into adopting that handoff rather than reporting a
 * false busy result.
 *
 * @param mainCheckout Main checkout containing the shared state directory.
 * @param worktreePath Worktree to claim.
 * @param now Timestamp factory used for deterministic tests.
 * @param allowCompleted Whether an explicit setup may claim a completed record for repair.
 * @param adoptHandoff Whether setup may take ownership of an event handoff claim.
 * @returns A claim handle, or undefined when another setup owns it or it is done.
 */
export const claimWorktreeStatus = (
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

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const recoverStaleOwnerClaim = (paths: WorktreeStatusPaths): boolean => {
  if (existsSync(paths.statusPath) || !existsSync(join(paths.claimPath, SETUP_OWNER))) {
    return false;
  }
  rmSync(paths.claimPath, { recursive: true, force: true });
  return true;
};
