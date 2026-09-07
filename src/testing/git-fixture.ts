import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit, type SpawnGitOptions } from "./git-env.ts";

/**
 * Configuration for a temporary Git fixture.
 */
export type GitFixtureOptions = {
  readonly prefix: string | undefined;
  readonly branch: string | undefined;
  readonly worktreeName: string | undefined;
  readonly env: SpawnGitOptions["env"];
};

/**
 * A temporary repository and one linked worktree created for a test.
 */
export type GitFixture = {
  readonly root: string;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly cleanup: () => void;
};

const IDENTITY = ["-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com"];

const runGitOrThrow = (
  args: readonly string[],
  options: SpawnGitOptions,
  operation: string,
): void => {
  const result = spawnGit(args, options);
  if (result.exitCode === 0) return;
  throw new Error(
    `${operation} failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
};

/**
 * Creates a temporary repository with an initial commit and a linked worktree.
 *
 * Every Git operation uses {@link spawnGit}, so inherited repository-location
 * variables such as `GIT_DIR` cannot redirect setup into another repository.
 *
 * @param options Fixture naming and environment overrides.
 * @returns The repository paths and an idempotent cleanup function.
 */
export const createGitFixture = (
  options: GitFixtureOptions | undefined = undefined,
): GitFixture => {
  const prefix = options?.prefix ?? "devenv-agents-git-";
  const branch = options?.branch ?? "fixture/feature";
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repository = join(root, "repo");
  const worktree = join(root, options?.worktreeName ?? "worktree");
  const spawnOptions: SpawnGitOptions = { cwd: undefined, env: options?.env };

  try {
    mkdirSync(repository);
    runGitOrThrow(["init", "-q", "-b", "main", repository], spawnOptions, "git init");
    writeFileSync(join(repository, "README.md"), "fixture\n");
    runGitOrThrow(["-C", repository, "add", "README.md"], spawnOptions, "git add");
    runGitOrThrow(
      ["-C", repository, ...IDENTITY, "commit", "-q", "-m", "initial fixture"],
      spawnOptions,
      "git commit",
    );
    runGitOrThrow(
      ["-C", repository, "worktree", "add", "-q", "-b", branch, worktree, "main"],
      spawnOptions,
      "git worktree add",
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    root,
    repository,
    worktree,
    branch,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/**
 * Runs a callback with a temporary Git fixture and always cleans it up.
 *
 * @param callback Function that exercises the fixture.
 * @param options Fixture naming and environment overrides.
 * @returns The callback's return value.
 */
export const withGitFixture = <T>(
  callback: (fixture: GitFixture) => T,
  options: GitFixtureOptions | undefined = undefined,
): T => {
  const fixture = createGitFixture(options);
  try {
    return callback(fixture);
  } finally {
    fixture.cleanup();
  }
};
