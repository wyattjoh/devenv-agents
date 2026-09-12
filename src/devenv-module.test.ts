import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withGitFixture } from "./testing/git-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const shellTest = fileURLToPath(new URL("../tests/module-shell.test.sh", import.meta.url));
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

const writeEnvironment = (directory: string, agentsRoot: string): void => {
  mkdirSync(`${directory}/.agents`, { recursive: true });
  writeFileSync(
    `${directory}/devenv.yaml`,
    `inputs:\n  agents:\n    url: path:${agentsRoot}\nimports:\n  - agents\nallowUnfree: true\n`,
  );
  writeFileSync(
    `${directory}/devenv.nix`,
    `{ config, ... }:\n{\n  services.postgres.enable = true;\n  env.TEST_SCOPED_SERVICE = if config.services.postgres.enable then "enabled" else "disabled";\n}\n`,
  );
  writeFileSync(
    `${directory}/.agents/project.toml`,
    `session = "fixture-session"\n\n[services]\nscoped = ["postgres"]\n`,
  );
};

describe("devenv agents module", () => {
  it("provides Claude Code through direnv while preserving caller configuration", () => {
    withGitFixture((fixture) => {
      writeEnvironment(fixture.repository, repositoryRoot);
      writeEnvironment(fixture.worktree, repositoryRoot);

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
        const result = Bun.spawnSync(["bash", shellTest, fixture.repository, fixture.worktree], {
          cwd: fixture.worktree,
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
    });
  }, 900_000);
});
