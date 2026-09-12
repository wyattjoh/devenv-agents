import { relative, resolve, sep } from "node:path";
import { type CommandRunner } from "./command-runner.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { assertProjectPluginEnabled } from "./worktree-plugin.ts";
import {
  getWorktreeStatusPaths,
  readWorktreeStatus,
  type WorktreeStatus,
} from "./worktree-status.ts";
import { getManagedWorktreeRoot, resolveMainCheckout, worktreeLabel } from "./workspace.ts";

/**
 * The ids returned by Herdr after creating a workspace and its root pane.
 */
export type WorktreeCreateIds = {
  readonly workspaceId: string;
  readonly rootPaneId: string;
};

/**
 * The completed result of a managed worktree creation.
 */
export type WorktreeCreateResult = WorktreeCreateIds & {
  readonly branch: string;
  readonly worktreePath: string;
};

/**
 * Dependencies and options for one managed worktree creation.
 */
export type WorktreeCreateOptions = {
  readonly cwd: string;
  readonly branch: string;
  readonly base: string | undefined;
  readonly focus: boolean;
  readonly noFocus: boolean;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  /**
   * Optional wait seam used by deterministic tests. Production callers omit it
   * and use the unbounded blocking wait.
   */
  readonly sleep: (() => void) | undefined;
};

const defaultSleep = (): void => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, 50);
};

const worktreePathForBranch = (mainCheckout: string, branch: string): string => {
  if (branch.length === 0) throw new Error("worktree branch is required");
  const root = getManagedWorktreeRoot(mainCheckout);
  const path = resolve(root, branch);
  const relativePath = relative(root, path);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("worktree branch must stay under .claude/worktrees");
  }
  return path;
};

/**
 * Waits until the shared status record reaches a terminal state.
 *
 * There is intentionally no timeout: a successful Herdr command is not
 * complete until the plugin has recorded either `done` or `failed`.
 *
 * @param statusPath Shared worktree status file to observe.
 * @param sleep Wait operation between reads, or the production blocking wait.
 * @returns The terminal status record.
 */
export const waitForWorktreeStatus = (
  statusPath: string,
  sleep: (() => void) | undefined = undefined,
): Exclude<WorktreeStatus, { state: "running" }> => {
  for (;;) {
    const status = readWorktreeStatus(statusPath);
    if (status?.state === "done" || status?.state === "failed") return status;
    (sleep ?? defaultSleep)();
  }
};

/**
 * Creates a Herdr worktree and waits for its plugin bootstrap to finish.
 *
 * @param options Creation arguments, project cwd, and injected Herdr client and runner.
 * @returns The workspace and root-pane ids after a successful bootstrap.
 */
export const runWorktreeCreate = (options: WorktreeCreateOptions): WorktreeCreateResult => {
  assertProjectPluginEnabled(options.herdrClient);
  const mainCheckout = resolveMainCheckout(options.cwd, options.runner);
  const worktreePath = worktreePathForBranch(mainCheckout, options.branch);
  const ids = options.herdrClient.createWorktree({
    cwd: mainCheckout,
    branch: options.branch,
    base: options.base,
    path: worktreePath,
    label: worktreeLabel(options.branch),
    focus: options.noFocus ? "no-focus" : options.focus ? "focus" : undefined,
  });
  const statusPath = getWorktreeStatusPaths(mainCheckout, worktreePath).statusPath;
  const status = waitForWorktreeStatus(statusPath, options.sleep);
  if (status.state === "failed") throw new Error(status.error);
  return { ...ids, branch: options.branch, worktreePath };
};
