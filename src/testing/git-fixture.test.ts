import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFixture, withGitFixture } from "./git-fixture.ts";
import { spawnGit } from "./git-env.ts";

const created: string[] = [];

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

const commitCount = (repository: string): string =>
  spawnGit(["-C", repository, "rev-list", "--count", "HEAD"]).stdout.trim();

const treePaths = (repository: string): string =>
  spawnGit(["-C", repository, "ls-tree", "-r", "--name-only", "HEAD"]).stdout.trim();

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createGitFixture", () => {
  it("creates a repository with a linked worktree", () => {
    withGitFixture((fixture) => {
      expect(existsSync(join(fixture.repository, ".git"))).toBe(true);
      expect(existsSync(join(fixture.worktree, ".git"))).toBe(true);
      expect(fixture.branch).toBe("fixture/feature");
      expect(commitCount(fixture.repository)).toBe("1");
      expect(
        spawnGit(["-C", fixture.repository, "worktree", "list", "--porcelain"]).stdout,
      ).toContain(fixture.worktree);
    });
  });

  it("keeps fixture operations out of a decoy repository named by GIT_DIR", () => {
    const scratch = mkdtempSync(join(tmpdir(), "devenv-agents-git-env-"));
    created.push(scratch);
    const decoy = join(scratch, "decoy");
    mkdirSync(decoy);

    expect(spawnGit(["init", "-q", "-b", "main", decoy]).exitCode).toBe(0);
    writeFileSync(join(decoy, "decoy.txt"), "decoy\n");
    expect(spawnGit(["-C", decoy, "add", "decoy.txt"]).exitCode).toBe(0);
    expect(spawnGit(["-C", decoy, ...identity, "commit", "-q", "-m", "decoy"]).exitCode).toBe(0);

    const poisonedEnvironment = {
      ...process.env,
      GIT_DIR: join(decoy, ".git"),
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
    };

    const fixture = createGitFixture({
      prefix: undefined,
      branch: undefined,
      worktreeName: undefined,
      env: poisonedEnvironment,
    });

    created.push(fixture.root);

    expect(existsSync(join(fixture.repository, ".git"))).toBe(true);
    expect(commitCount(fixture.repository)).toBe("1");
    expect(treePaths(fixture.repository)).toBe("README.md");
    expect(commitCount(decoy)).toBe("1");
    expect(treePaths(decoy)).toBe("decoy.txt");
    expect(spawnGit(["-C", decoy, "config", "--get", "core.bare"]).stdout.trim()).toBe("false");
  });
});
