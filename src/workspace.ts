import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CommandFailure, runRequiredGitCommand, type CommandRunner } from "./command-runner.ts";

const gitDirectoryFor = (path: string): string => {
  const absolute = resolve(path);
  try {
    if (statSync(absolute).isDirectory()) return absolute;
    return dirname(absolute);
  } catch {
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      existing = parent;
    }
    try {
      if (statSync(existing).isDirectory()) return existing;
    } catch {
      // Let Git provide the standard failure for an unusable path.
    }
    return dirname(existing);
  }
};

/**
 * Resolves the canonical main checkout for any path inside a Git project.
 *
 * @param path Path in the main checkout or a linked worktree.
 * @param runner Injected command runner used for Git.
 * @returns The canonical main checkout path.
 * @throws {@link CommandFailure} When Git cannot resolve the project or returns no path.
 */
export const resolveMainCheckout = (path: string, runner: CommandRunner): string => {
  const gitDirectory = gitDirectoryFor(path);
  const result = runRequiredGitCommand(
    runner,
    "git rev-parse --git-common-dir",
    ["-C", gitDirectory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    gitDirectory,
  );
  const commonDirectory = result.stdout.trim();
  if (commonDirectory.length === 0) {
    throw new CommandFailure("git rev-parse --git-common-dir", result);
  }
  const absoluteCommonDirectory = isAbsolute(commonDirectory)
    ? commonDirectory
    : resolve(gitDirectory, commonDirectory);
  return canonicalPath(dirname(absoluteCommonDirectory));
};

/**
 * A linked Git worktree and the state Git reports for it.
 */
export type WorkspaceWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly prunable: boolean;
};

/**
 * Canonicalizes an existing or missing path by resolving its nearest existing
 * ancestor and retaining any missing path segments.
 *
 * @param path Path to canonicalize.
 * @returns A canonical absolute path with the missing tail preserved.
 */
export const canonicalPath = (path: string): string => {
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

/**
 * Compares paths using the canonical nearest-existing-ancestor semantics.
 *
 * Missing path segments are retained after the nearest existing ancestor is
 * canonicalized, so the result remains stable for paths that Git marks as
 * prunable.
 *
 * @param left First path to compare.
 * @param right Second path to compare.
 * @returns Whether both paths identify the same filesystem location.
 */
export const samePath = (left: string, right: string): boolean =>
  canonicalPath(left) === canonicalPath(right);

const normalizeBranch = (branch: string | undefined): string | undefined => {
  if (branch === undefined) return undefined;
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
};

const parsePorcelainWorktrees = (stdout: string): readonly WorkspaceWorktree[] => {
  const records: WorkspaceWorktree[] = [];
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
      path: canonicalPath(worktreePath),
      branch: normalizeBranch(
        lines.find((line) => line.startsWith("branch "))?.slice("branch ".length),
      ),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }
  if (records.length === 0) throw new Error("git worktree list returned no worktrees");
  return records;
};

/**
 * Lists every linked Git worktree for a main checkout.
 *
 * The main checkout is excluded. Returned paths use the same canonical path
 * semantics as {@link samePath}; a missing worktree path is still returned so
 * callers can classify a prunable registration.
 *
 * @param mainCheckout Main checkout whose linked worktrees should be listed.
 * @param runner Injected command runner used for Git.
 * @returns Linked worktrees in Git's porcelain order.
 * @throws {@link CommandFailure} When Git cannot list the worktrees.
 */
export const listLinkedWorktrees = (
  mainCheckout: string,
  runner: CommandRunner,
): readonly WorkspaceWorktree[] => {
  const result = runRequiredGitCommand(
    runner,
    "git worktree list",
    ["-C", mainCheckout, "worktree", "list", "--porcelain"],
    mainCheckout,
  );
  const main = canonicalPath(mainCheckout);
  return parsePorcelainWorktrees(result.stdout).filter(
    (worktree) => !samePath(worktree.path, main),
  );
};

/**
 * Returns the root where managed linked worktrees are created.
 *
 * @param mainCheckout Main checkout containing the managed worktree directory.
 * @returns The `.claude/worktrees` path below the canonical main checkout.
 */
export const getManagedWorktreeRoot = (mainCheckout: string): string =>
  join(canonicalPath(mainCheckout), ".claude", "worktrees");

/**
 * Derives the managed worktree label from a branch name.
 *
 * @param branch Branch name, with slash-separated segments.
 * @returns The final segment of the branch name.
 * @throws {Error} When the branch ends with an empty segment.
 */
export const worktreeLabel = (branch: string): string => {
  const label = branch.slice(branch.lastIndexOf("/") + 1);
  if (label.length === 0) throw new Error("worktree branch must end with a name");
  return label;
};
