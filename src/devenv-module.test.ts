import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withGitFixture } from "./testing/git-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const shellTest = fileURLToPath(new URL("../tests/module-shell.test.sh", import.meta.url));

const treeRootShellTest = fileURLToPath(
  new URL("../tests/tree-root-shell.test.sh", import.meta.url),
);

const gitRepositoryEnvironmentKeys = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);

const withoutGitRepositoryEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !gitRepositoryEnvironmentKeys.has(entry[0]),
    ),
  );

const writeEnvironment = (
  directory: string,
  agentsRoot: string,
  session: string = "fixture-session",
): void => {
  mkdirSync(`${directory}/.agents`, { recursive: true });
  writeFileSync(
    `${directory}/devenv.yaml`,
    `inputs:\n  agents:\n    url: path:${agentsRoot}\nimports:\n  - agents\n`,
  );
  writeFileSync(
    `${directory}/devenv.nix`,
    `{ config, ... }:\n{\n  services.postgres.enable = true;\n  env.TEST_SCOPED_SERVICE = if config.services.postgres.enable then "enabled" else "disabled";\n}\n`,
  );
  writeFileSync(
    `${directory}/.agents/project.toml`,
    `session = "${session}"\n\n[services]\nscoped = ["postgres"]\n`,
  );
};

/**
 * Runs one shell assertion script against a throwaway home directory.
 *
 * The home directory is per-run so the Linux host-layer paths the module
 * exports never reach the caller's real agent configuration.
 *
 * @param script Absolute path to the shell assertion script.
 * @param args Positional arguments passed to the script.
 * @param cwd Working directory for the script.
 * @returns Nothing; a non-zero exit throws with the captured output.
 */
const runShellTest = (script: string, args: readonly string[], cwd: string): void => {
  const home = mkdtempSync(`${tmpdir()}/devenv-agents-module-home-`);

  try {
    const env = withoutGitRepositoryEnvironment({
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: `${home}/.cache`,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      CLAUDE_CONFIG_DIR: `${home}/caller-claude`,
      GH_CONFIG_DIR: `${home}/caller-gh`,
      PI_CODING_AGENT_DIR: `${home}/caller-pi`,
    });

    const result = Bun.spawnSync(["bash", script, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      throw new Error(
        [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join("\n"),
      );
    }

    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

describe("devenv agents module", () => {
  it("provides the shared agent tooling through direnv while preserving caller configuration", () => {
    withGitFixture((fixture) => {
      writeEnvironment(fixture.repository, repositoryRoot);
      writeEnvironment(fixture.worktree, repositoryRoot);

      runShellTest(shellTest, [fixture.repository, fixture.worktree], fixture.worktree);
    });
  }, 900_000);

  it("shares one environment across the checkouts under a tree root", () => {
    withGitFixture((fixture) => {
      // Only the tree root gets devenv files. The fixture's repository stays a
      // plain checkout underneath it, which is the shape this covers: several
      // repositories that cannot carry devenv config of their own.
      writeEnvironment(fixture.root, repositoryRoot, "tree-session");

      runShellTest(treeRootShellTest, [fixture.root, fixture.repository], fixture.root);
    });
  }, 900_000);
});
