import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { PROJECT_PLUGIN_ID } from "./worktree-plugin.ts";
import { captureOutput, createCliDependencies } from "./testing/cli.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { createRecordingRunner, type CommandResult } from "./testing/command-runner.ts";

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

describe("CLI host configuration", () => {
  it("uses the resolved host and user through the public add command", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-host-"));
    const home = join(root, "home");
    const code = join(root, "code");
    const checkout = join(code, "github.com", "example", "widget");
    const projectsFile = join(root, "projects.toml");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "devenv.nix"), "{ }: {}\n");

    try {
      const output = captureOutput();
      const runner = createRecordingRunner({ devenv: result(0) });
      const dependencies = createCliDependencies({
        runner,
        herdrClient: createFakeHerdrClient({
          listPlugins: () => [
            {
              pluginId: PROJECT_PLUGIN_ID,
              enabled: true,
              pluginRoot: undefined,
              manifestPath: undefined,
              version: "0.1.0",
            },
          ],
        }),
        environment: {
          PROJECT_PLATFORM: "darwin",
          PROJECT_HOME: home,
          PROJECT_CODE_ROOT: code,
          PROJECT_PROJECTS_FILE: projectsFile,
          PROJECT_HOST: "fixture-host",
          USER: "fixture-user",
        },
      });

      expect(runCli(["add", "github.com/example/widget"], output.io, dependencies)).toBe(0);
      expect(output.stdout()).toContain("Host fixture-host-widget");
      expect(output.stdout()).toContain("  User fixture-user");
      expect(output.stderr()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported platform before dispatching through runCli", () => {
    const output = captureOutput();
    const runner = createRecordingRunner();
    const dependencies = createCliDependencies({
      runner,
      environment: { PROJECT_PLATFORM: "freebsd" },
    });

    expect(runCli(["--help"], output.io, dependencies)).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(
      "project: PROJECT_PLATFORM must be either linux or darwin, got 'freebsd'\n",
    );
    expect(runner.calls).toEqual([]);
  });
});
