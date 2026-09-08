import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  claimWorktreeStatus,
  getWorktreeStatusPaths,
  readWorktreeStatus,
  worktreeStatusHash,
  type WorktreeStatus,
} from "./worktree-status.ts";

const created: string[] = [];

const makePaths = (): {
  readonly root: string;
  readonly main: string;
  readonly worktree: string;
} => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-status-"));
  const main = join(root, "main");
  const worktree = join(root, "worktree");
  mkdirSync(main);
  mkdirSync(worktree);
  created.push(root);
  return { root, main, worktree };
};

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktree status", () => {
  it("uses the first sixteen SHA-1 characters for a canonical path", () => {
    expect(worktreeStatusHash("/tmp/project-worktree")).toBe("26380a9337280f0c");
  });

  it("writes the canonical main-checkout status path and lifecycle fields", () => {
    const { main, worktree } = makePaths();
    const paths = getWorktreeStatusPaths(main, worktree);
    const claim = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:00.000Z");

    expect(paths.statusPath).toBe(
      join(
        realpathSync(main),
        ".devenv",
        "state",
        "project",
        "worktrees",
        paths.hash,
        "status.json",
      ),
    );
    expect(paths.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(claim?.paths).toEqual(paths);

    claim?.write("running", undefined, undefined);
    expect(readWorktreeStatus(paths.statusPath)).toEqual({
      path: paths.worktreePath,
      state: "running",
      started_at: "2026-09-08T01:00:00.000Z",
    });

    claim?.write("done", undefined, "2026-09-08T01:01:00.000Z");
    const status = readWorktreeStatus(paths.statusPath) as WorktreeStatus;
    expect(status).toEqual({
      path: paths.worktreePath,
      state: "done",
      started_at: "2026-09-08T01:00:00.000Z",
      finished_at: "2026-09-08T01:01:00.000Z",
    });
    expect(JSON.parse(readFileSync(paths.statusPath, "utf8"))).toEqual(status);
    claim?.release();
  });

  it("treats malformed status content as an absent record", () => {
    const { main, worktree } = makePaths();
    const paths = getWorktreeStatusPaths(main, worktree);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.statusPath, "not-json", "utf8");

    expect(readWorktreeStatus(paths.statusPath)).toBe(undefined);
  });

  it("allows exactly one concurrent claim for a path", () => {
    const { main, worktree } = makePaths();

    const first = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:00.000Z");
    const second = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:01.000Z");

    expect(first === undefined).toBe(false);
    expect(second).toBe(undefined);
    expect(existsSync(first?.paths.claimPath ?? "")).toBe(true);

    first?.release();
  });

  it("keeps failed status for inspection while resetting the claim for retry", () => {
    const { main, worktree } = makePaths();
    const first = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:00.000Z");
    const statusPath = first?.paths.statusPath ?? "";

    first?.write("failed", "warm failed", "2026-09-08T01:00:02.000Z");
    first?.release();

    const retry = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:03.000Z");
    expect(retry === undefined).toBe(false);
    expect(readWorktreeStatus(statusPath)?.state).toBe("failed");

    retry?.write("done", undefined, "2026-09-08T01:00:04.000Z");
    retry?.release();
    expect(claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:05.000Z")).toBe(undefined);

    const repair = claimWorktreeStatus(main, worktree, () => "2026-09-08T01:00:06.000Z", true);
    expect(repair === undefined).toBe(false);
    repair?.write("done", undefined, "2026-09-08T01:00:07.000Z");
    repair?.release();
  });
});
