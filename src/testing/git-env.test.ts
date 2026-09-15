import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultCommandRunner, runGitCommand } from "../command-runner.ts";
import { createRecordingRunner, type CommandResult } from "./command-runner.ts";
import { withGitFixture } from "./git-fixture.ts";
import { spawnGit } from "./git-env.ts";

const GIT_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
] as const;

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

describe("runGitCommand", () => {
  it("removes repository variables, preserves identity, and omits undefined values", () => {
    const runner = createRecordingRunner({ git: result(0) });

    const env = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      USER: "test",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_COMMITTER_NAME: "Test Committer",
      GIT_DIR: "/decoy/.git",
      GIT_WORK_TREE: "/decoy",
      GIT_INDEX_FILE: "/decoy/.git/index",
      GIT_COMMON_DIR: "/decoy/.git",
      GIT_OBJECT_DIRECTORY: "/decoy/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/decoy/.git/objects",
      GIT_CEILING_DIRECTORIES: "/",
      EMPTY: undefined,
    };

    expect(runGitCommand(runner, ["status"], undefined, env)).toEqual(result(0));
    expect(runner.calls).toEqual([
      {
        command: "git",
        args: ["status"],
        cwd: undefined,
        env: {
          PATH: "/usr/bin",
          HOME: "/home/test",
          USER: "test",
          GIT_AUTHOR_NAME: "Test Author",
          GIT_COMMITTER_NAME: "Test Committer",
        },
      },
    ]);
  });

  it("does not let inherited Git location variables redirect a real subprocess", () => {
    withGitFixture(
      (fixture) => {
        const decoy = join(fixture.root, "decoy");

        const values: Record<(typeof GIT_LOCATION_VARIABLES)[number], string> = {
          GIT_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, "index"),
          GIT_COMMON_DIR: join(decoy, ".git"),
          GIT_OBJECT_DIRECTORY: join(decoy, "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoy, "objects"),
          GIT_CEILING_DIRECTORIES: decoy,
        };

        const previous = new Map<string, string | undefined>();

        for (const key of GIT_LOCATION_VARIABLES) previous.set(key, process.env[key]);

        try {
          for (const key of GIT_LOCATION_VARIABLES) process.env[key] = values[key];

          const gitResult = runGitCommand(
            defaultCommandRunner,
            ["-C", fixture.repository, "rev-parse", "--show-toplevel"],
            fixture.repository,
          );

          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toBe(`${realpathSync(fixture.repository)}\n`);
        } finally {
          for (const key of GIT_LOCATION_VARIABLES) {
            const value = previous.get(key);

            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      },
      {
        prefix: "devenv-agents-real-git-env-",
        branch: "fixture/real-git-env",
        worktreeName: "worktree",
        env: undefined,
      },
    );
  });
});

describe("spawnGit", () => {
  it("sanitizes the inherited repository before running a command", () => {
    const gitResult = spawnGit(["--version"], {
      cwd: undefined,
      env: { ...process.env, GIT_DIR: "/decoy/.git" },
    });

    expect(gitResult.exitCode).toBe(0);
    expect(gitResult.stdout.startsWith("git version ")).toBe(true);
  });

  it("passes an explicit working directory to Git", () => {
    const gitResult = spawnGit(["rev-parse", "--show-toplevel"], {
      cwd: "/tmp",
      env: undefined,
    });

    expect(gitResult.exitCode).toBe(128);
    expect(gitResult.stdout).toBe("");
    expect(gitResult.stderr.length).toBeGreaterThan(0);
  });
});
