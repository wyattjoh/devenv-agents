import { relative, resolve, sep } from "node:path";
import { type CommandRunner } from "./command-runner.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { WorktreeBootstrap, WorktreeBootstrapDeadline } from "./worktree-bootstrap.ts";
import { assertProjectPluginEnabled } from "./worktree-plugin.ts";
import { getManagedWorktreeRoot, resolveMainCheckout, worktreeLabel } from "./workspace.ts";

/**
 * The ids returned by Herdr after creating a workspace and its root pane.
 */
type WorktreeCreateIds = {
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
type WorktreeCreateOptions = {
  readonly cwd: string;
  readonly branch: string;
  readonly base: string | undefined;
  readonly focus: boolean;
  readonly noFocus: boolean;
  readonly bootstrap: WorktreeBootstrap;
  readonly deadline: WorktreeBootstrapDeadline;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  /**
   * Optional wait seam used by deterministic tests.
   */
  readonly sleep: (() => void) | undefined;
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
  const bootstrap = options.bootstrap.await({
    mainCheckout,
    worktreePath,
    deadline: options.deadline,
    sleep: options.sleep,
  });
  if (bootstrap.state === "timeout") throw new Error("worktree bootstrap timed out");
  if (bootstrap.state === "failed") throw bootstrap.error;
  return { ...ids, branch: options.branch, worktreePath };
};
