import { describe, expect, it } from "bun:test";
import { defaultDependencies, resolveHostConfiguration, type HostConfiguration } from "./cli.ts";
import { createRecordingRunner, type CommandResult } from "./command-runner.ts";

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

describe("CLI host configuration", () => {
  it("resolves the CLI environment once into typed host values", () => {
    const environment = {
      PROJECT_PLATFORM: "linux",
      PROJECT_HOME: "/fixture/home",
      HOME: "/ignored/home",
      PROJECT_PROJECTS_FILE: "/fixture/projects.toml",
      PROJECT_SYSTEMD_USER_DIRECTORY: "/fixture/systemd",
      PROJECT_CODE_ROOT: "/fixture/code",
      PROJECT_TEMPLATE_ROOT: "/fixture/templates",
      PROJECT_HOST: "fixture-host",
      USER: "fixture-user",
      USERNAME: "ignored-user",
      HERDR_BIN_PATH: "/fixture/herdr",
      HERDR_PLUGIN_EVENT_JSON: '{"workspace_id":"fixture-workspace"}',
      HERDR_WORKSPACE_ID: "fixture-workspace",
    };

    const configuration: HostConfiguration = resolveHostConfiguration(environment);

    expect(configuration).toEqual({
      platform: "linux",
      homeDirectory: "/fixture/home",
      projectsFile: "/fixture/projects.toml",
      systemdUserDirectory: "/fixture/systemd",
      codeRoot: "/fixture/code",
      templateRoot: "/fixture/templates",
      host: "fixture-host",
      user: "fixture-user",
      herdrBinPath: "/fixture/herdr",
      eventJson: '{"workspace_id":"fixture-workspace"}',
      workspaceId: "fixture-workspace",
    });
  });

  it("uses an injected environment for default Herdr dependencies", () => {
    const runner = createRecordingRunner({
      "/fixture/herdr plugin list --json": result(0, '{"result":{"plugins":[]}}'),
    });
    const environment = {
      PROJECT_PLATFORM: "darwin",
      HERDR_BIN_PATH: "/fixture/herdr",
    };
    const dependencies = defaultDependencies(environment, runner);

    expect(dependencies.herdrClient.listPlugins()).toEqual([]);
    expect(runner.calls).toEqual([
      {
        command: "/fixture/herdr",
        args: ["plugin", "list", "--json"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("rejects an unsupported platform during host resolution", () => {
    expect(() => resolveHostConfiguration({ PROJECT_PLATFORM: "freebsd" })).toThrow(
      "PROJECT_PLATFORM must be either linux or darwin, got 'freebsd'",
    );
  });
});
