import { describe, expect, it } from "bun:test";
import { cleanGitEnv, GIT_ENV_KEYS, spawnGit } from "./git-env.ts";

describe("cleanGitEnv", () => {
  it("drops every repository-location variable and keeps identity variables", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_AUTHOR_NAME: "Test",
      GIT_DIR: "/decoy/.git",
      GIT_WORK_TREE: "/decoy",
      GIT_INDEX_FILE: "/decoy/.git/index",
      GIT_COMMON_DIR: "/decoy/.git",
      GIT_OBJECT_DIRECTORY: "/decoy/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/decoy/.git/objects",
      GIT_CEILING_DIRECTORIES: "/",
    };

    expect(cleanGitEnv(env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_AUTHOR_NAME: "Test",
    });
    expect(GIT_ENV_KEYS).toHaveLength(7);
  });

  it("omits keys whose value is undefined", () => {
    expect(cleanGitEnv({ PATH: "/usr/bin", EMPTY: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("spawnGit", () => {
  it("sanitizes the inherited repository before running a command", () => {
    const result = spawnGit(["--version"], {
      cwd: undefined,
      env: { ...process.env, GIT_DIR: "/decoy/.git" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("git version ")).toBe(true);
  });

  it("passes an explicit working directory to Git", () => {
    const result = spawnGit(["rev-parse", "--show-toplevel"], {
      cwd: "/tmp",
      env: undefined,
    });

    expect(result.exitCode).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
