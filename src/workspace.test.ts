import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CommandFailure, createRecordingRunner, realCommandRunner } from "./command-runner.ts";
import {
  getManagedWorktreeRoot,
  getWorktreeStatusRoot,
  listLinkedWorktrees,
  resolveMainCheckout,
  samePath,
  worktreeLabel,
} from "./workspace.ts";
import { spawnGit } from "./testing/git-env.ts";
import { withGitFixture } from "./testing/git-fixture.ts";

const requireGit = (repository: string, args: readonly string[], operation: string): void => {
  const result = spawnGit(["-C", repository, ...args]);
  if (result.exitCode === 0) return;
  throw new Error(
    `${operation} failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
};

describe("project workspace", () => {
  it("resolves the same canonical main checkout from the main and linked paths", () => {
    withGitFixture((fixture) => {
      const expected = realpathSync(fixture.repository);

      expect(resolveMainCheckout(fixture.repository, realCommandRunner)).toBe(expected);
      expect(resolveMainCheckout(fixture.worktree, realCommandRunner)).toBe(expected);
    });
  });

  it("resolves the main checkout from files inside the main and linked worktrees", () => {
    withGitFixture((fixture) => {
      const expected = realpathSync(fixture.repository);

      expect(resolveMainCheckout(join(fixture.repository, "README.md"), realCommandRunner)).toBe(
        expected,
      );
      expect(resolveMainCheckout(join(fixture.worktree, "README.md"), realCommandRunner)).toBe(
        expected,
      );
    });
  });

  it("resolves the main checkout from relative directory paths", () => {
    withGitFixture((fixture) => {
      const expected = realpathSync(fixture.repository);
      const relativeRepository = relative(process.cwd(), fixture.repository);
      const relativeWorktree = relative(process.cwd(), fixture.worktree);

      expect(resolveMainCheckout(relativeRepository, realCommandRunner)).toBe(expected);
      expect(resolveMainCheckout(relativeWorktree, realCommandRunner)).toBe(expected);
    });
  });

  it("lists linked, detached, and prunable worktrees with normalized state", () => {
    withGitFixture((fixture) => {
      const detachedPath = join(fixture.root, "detached");
      const prunablePath = join(fixture.root, "prunable");
      requireGit(
        fixture.repository,
        ["worktree", "add", "-q", "--detach", detachedPath, "main"],
        "git worktree add detached",
      );
      requireGit(
        fixture.repository,
        ["worktree", "add", "-q", "-b", "fixture/prunable", prunablePath, "main"],
        "git worktree add prunable",
      );
      rmSync(prunablePath, { recursive: true, force: true });

      const worktrees = listLinkedWorktrees(fixture.repository, realCommandRunner);
      const feature = worktrees.find((worktree) => worktree.branch === fixture.branch);
      const detached = worktrees.find((worktree) => worktree.detached);
      const prunable = worktrees.find((worktree) => worktree.branch === "fixture/prunable");

      expect(worktrees).toHaveLength(3);
      expect(feature).toEqual({
        path: realpathSync(fixture.worktree),
        branch: fixture.branch,
        detached: false,
        prunable: false,
      });
      expect(detached).toEqual({
        path: realpathSync(detachedPath),
        branch: undefined,
        detached: true,
        prunable: false,
      });
      expect(prunable).toMatchObject({
        branch: "fixture/prunable",
        detached: false,
        prunable: true,
      });
      expect(prunable === undefined ? false : samePath(prunable.path, prunablePath)).toBe(true);
      expect(prunable?.path).toBe(join(realpathSync(fixture.root), "prunable"));
    });
  });

  it("compares symlinked roots and paths with missing segments by identity", () => {
    const root = mkdtempSync("/tmp/devenv-agents-workspace-path-");
    const symlinkedRoot = `${root}-alias`;
    try {
      const existingParent = join(root, "existing");
      const missingDirectory = join(existingParent, "missing");
      const missingTail = join(missingDirectory, "tail");
      mkdirSync(existingParent);
      writeFileSync(join(existingParent, "present.txt"), "present\n");
      symlinkSync(root, symlinkedRoot);

      const canonicalRoot = realpathSync(root);
      expect(samePath(root, symlinkedRoot)).toBe(true);
      expect(samePath(root, canonicalRoot)).toBe(true);
      expect(samePath(missingDirectory, join(symlinkedRoot, "existing", "missing"))).toBe(true);
      expect(samePath(missingDirectory, join(canonicalRoot, "existing", "missing"))).toBe(true);
      expect(samePath(missingTail, join(symlinkedRoot, "existing", "missing", "tail"))).toBe(true);
      expect(samePath(missingTail, join(canonicalRoot, "existing", "missing", "tail"))).toBe(true);
    } finally {
      rmSync(symlinkedRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes the managed worktree and bootstrap status roots", () => {
    withGitFixture((fixture) => {
      const mainCheckout = realpathSync(fixture.repository);

      expect(getManagedWorktreeRoot(mainCheckout)).toBe(join(mainCheckout, ".claude", "worktrees"));
      expect(getWorktreeStatusRoot(mainCheckout)).toBe(
        join(mainCheckout, ".devenv", "state", "project", "worktrees"),
      );
    });
  });

  it("derives a worktree label from the final branch segment", () => {
    expect(worktreeLabel("feature/checkout")).toBe("checkout");
    expect(worktreeLabel("main")).toBe("main");
    expect(() => worktreeLabel("feature/")).toThrow("worktree branch must end with a name");
  });

  it("surfaces Git's standard command failure outside a repository", () => {
    const directory = mkdtempSync("/tmp/devenv-agents-workspace-outside-");
    try {
      let failure: unknown;
      try {
        resolveMainCheckout(directory, realCommandRunner);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(CommandFailure);
      expect(failure).toMatchObject({ label: "git rev-parse --git-common-dir" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats empty Git resolution output as a standard command failure", () => {
    const directory = mkdtempSync("/tmp/devenv-agents-workspace-empty-");
    try {
      const runner = createRecordingRunner({
        git: { exitCode: 0, stdout: "", stderr: "" },
      });
      let failure: unknown;
      try {
        resolveMainCheckout(directory, runner);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(CommandFailure);
      expect(failure).toMatchObject({ label: "git rev-parse --git-common-dir" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
