import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CommandFailure } from "./command-runner.ts";
import { createHerdrClient } from "./herdr-client.ts";
import { createRecordingRunner } from "./testing/command-runner.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/herdr-0.9.0/${name}`, import.meta.url), "utf8");

describe("Herdr client", () => {
  it("lists worktrees with normalized state and strict linked detection", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 0, stdout: fixture("worktree-list.json"), stderr: "" },
    });

    const client = createHerdrClient(runner, undefined);

    expect(client.listWorktrees({ cwd: "/tmp/probe/repo", workspaceId: undefined })).toEqual([
      {
        path: "/tmp/probe/repo",
        branch: "main",
        linked: false,
        openWorkspaceId: "w1",
        prunable: false,
      },
      {
        path: "/tmp/probe/worktree/probe-feature",
        branch: "probe/feature",
        linked: true,
        openWorkspaceId: "w2",
        prunable: false,
      },
    ]);
    expect(runner.calls).toEqual([
      {
        command: "herdr",
        args: ["worktree", "list"],
        cwd: "/tmp/probe/repo",
        env: undefined,
      },
    ]);
  });

  it("resolves only an explicitly linked worktree for an event workspace", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 0, stdout: fixture("worktree-list.json"), stderr: "" },
    });

    const client = createHerdrClient(runner, undefined);

    expect(client.resolveWorktree("w2")).toEqual({
      path: "/tmp/probe/worktree/probe-feature",
      branch: "probe/feature",
      linked: true,
      openWorkspaceId: "w2",
      prunable: false,
    });
    expect(client.resolveWorktree("w1")).toBeUndefined();
    expect(runner.calls).toEqual([
      {
        command: "herdr",
        args: ["worktree", "list", "--workspace", "w2"],
        cwd: undefined,
        env: undefined,
      },
      {
        command: "herdr",
        args: ["worktree", "list", "--workspace", "w1"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("lists plugins from Herdr's JSON response", () => {
    const runner = createRecordingRunner({
      "herdr plugin list --json": {
        exitCode: 0,
        stdout: fixture("plugin-list.json"),
        stderr: "",
      },
    });

    const client = createHerdrClient(runner, undefined);

    expect(client.listPlugins()).toEqual([
      {
        pluginId: "probe",
        enabled: true,
        pluginRoot: "/tmp/probe/plugin",
        manifestPath: "/tmp/probe/plugin/herdr-plugin.toml",
        version: "0.2.0",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        command: "herdr",
        args: ["plugin", "list", "--json"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("lists typed panes from the captured response", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 0, stdout: fixture("pane-list.json"), stderr: "" },
    });

    const client = createHerdrClient(runner, undefined);

    expect(client.listPanes()).toEqual([
      { paneId: "w1:p1", cwd: "/tmp/probe/repo" },
      { paneId: "w1:p2", cwd: "/tmp/probe/repo" },
      { paneId: "w2:p1", cwd: "/tmp/probe/worktree/probe-feature" },
    ]);
    expect(runner.calls).toEqual([
      {
        command: "herdr",
        args: ["pane", "list"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("creates a worktree and extracts its workspace and root-pane ids", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 0, stdout: fixture("worktree-create.json"), stderr: "" },
    });

    const client = createHerdrClient(runner, undefined);

    expect(
      client.createWorktree({
        cwd: "/tmp/probe/repo",
        branch: "probe/capture",
        base: "main",
        path: "/tmp/probe/worktree/capture",
        label: "capture",
        focus: "no-focus",
      }),
    ).toEqual({ workspaceId: "w3", rootPaneId: "w3:p1" });
    expect(runner.calls).toEqual([
      {
        command: "herdr",
        args: [
          "worktree",
          "create",
          "--cwd",
          "/tmp/probe/repo",
          "--branch",
          "probe/capture",
          "--base",
          "main",
          "--path",
          "/tmp/probe/worktree/capture",
          "--label",
          "capture",
          "--no-focus",
        ],
        cwd: "/tmp/probe/repo",
        env: undefined,
      },
    ]);
  });

  it("issues worktree, workspace, pane, and plugin commands with stable argv", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 0, stdout: "", stderr: "" },
    });

    const client = createHerdrClient(runner, undefined);

    client.openWorktree({
      cwd: "/tmp/probe/repo",
      path: "/tmp/probe/worktree/probe-feature",
      label: "feature",
    });
    client.closeWorkspace("w2", "/tmp/probe/repo");
    client.openPluginPane({
      pluginId: "wyattjoh.project-worktrees",
      entrypoint: "setup",
      placement: "overlay",
      cwd: "/tmp/probe/worktree/probe-feature",
    });
    client.sendKeys("w2:p1", "Enter");
    client.linkPlugin("/tmp/probe/plugin");
    client.enablePlugin("wyattjoh.project-worktrees");
    client.unlinkPlugin("wyattjoh.project-worktrees");

    expect(
      runner.calls.map(({ command, args, cwd, env }) => ({ command, args, cwd, env })),
    ).toEqual([
      {
        command: "herdr",
        args: [
          "worktree",
          "open",
          "--cwd",
          "/tmp/probe/repo",
          "--path",
          "/tmp/probe/worktree/probe-feature",
          "--label",
          "feature",
          "--no-focus",
        ],
        cwd: "/tmp/probe/repo",
        env: undefined,
      },
      {
        command: "herdr",
        args: ["workspace", "close", "w2"],
        cwd: "/tmp/probe/repo",
        env: undefined,
      },
      {
        command: "herdr",
        args: [
          "plugin",
          "pane",
          "open",
          "--plugin",
          "wyattjoh.project-worktrees",
          "--entrypoint",
          "setup",
          "--placement",
          "overlay",
          "--cwd",
          "/tmp/probe/worktree/probe-feature",
          "--no-focus",
        ],
        cwd: undefined,
        env: undefined,
      },
      {
        command: "herdr",
        args: ["pane", "send-keys", "w2:p1", "Enter"],
        cwd: undefined,
        env: undefined,
      },
      {
        command: "herdr",
        args: ["plugin", "link", "/tmp/probe/plugin", "--enabled"],
        cwd: undefined,
        env: undefined,
      },
      {
        command: "herdr",
        args: ["plugin", "enable", "wyattjoh.project-worktrees"],
        cwd: undefined,
        env: undefined,
      },
      {
        command: "herdr",
        args: ["plugin", "unlink", "wyattjoh.project-worktrees"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("uses the configured binary path for every Herdr invocation", () => {
    const runner = createRecordingRunner({
      "/opt/herdr": { exitCode: 0, stdout: fixture("plugin-list.json"), stderr: "" },
    });

    const client = createHerdrClient(runner, "/opt/herdr");

    expect(client.listPlugins()[0]?.pluginId).toBe("probe");
    expect(runner.calls[0]?.command).toBe("/opt/herdr");
  });

  it("uses the standard command failure for required Herdr operations", () => {
    const runner = createRecordingRunner({
      herdr: { exitCode: 7, stdout: "", stderr: "socket unavailable" },
    });

    const client = createHerdrClient(runner, undefined);

    let failure: unknown;

    try {
      client.closeWorkspace("w2", undefined);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CommandFailure);
    expect(failure).toMatchObject({ label: "herdr workspace close", exitCode: 7 });
    // SAFETY: The asserted value is constrained by the surrounding validation or fixture.
    expect((failure as Error).message).toBe(
      "herdr workspace close failed with exit code 7: socket unavailable",
    );
  });

  it("keeps pane discovery fail-open for non-zero, malformed, and thrown calls", () => {
    const unavailable = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 1, stdout: "", stderr: "no socket" } }),
      undefined,
    );

    const malformed = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: "not json", stderr: "" } }),
      undefined,
    );

    const throwing = createHerdrClient(
      {
        run: () => {
          throw new Error("runner unavailable");
        },
      },
      undefined,
    );

    expect(unavailable.listPanes()).toEqual([]);
    expect(malformed.listPanes()).toEqual([]);
    expect(throwing.listPanes()).toEqual([]);
  });

  it("keeps event worktree resolution fail-open", () => {
    const unavailable = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 1, stdout: "", stderr: "no socket" } }),
      undefined,
    );

    const malformed = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: "not json", stderr: "" } }),
      undefined,
    );

    expect(unavailable.resolveWorktree("w2")).toBeUndefined();
    expect(malformed.resolveWorktree("w2")).toBeUndefined();
  });

  it("preserves the envelope error vocabulary for malformed required responses", () => {
    const invalidJson = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: "not json", stderr: "" } }),
      undefined,
    );

    const invalidEnvelope = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: "[]", stderr: "" } }),
      undefined,
    );

    const noWorktrees = createHerdrClient(
      createRecordingRunner({
        herdr: { exitCode: 0, stdout: fixture("workspace-get.json"), stderr: "" },
      }),
      undefined,
    );

    const noPlugins = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: '{"result":{}}', stderr: "" } }),
      undefined,
    );

    const eventEnvelope = createHerdrClient(
      createRecordingRunner({
        herdr: { exitCode: 0, stdout: fixture("worktree-created-event.json"), stderr: "" },
      }),
      undefined,
    );

    const missingCreateIds = createHerdrClient(
      createRecordingRunner({ herdr: { exitCode: 0, stdout: '{"result":{}}', stderr: "" } }),
      undefined,
    );

    expect(() => invalidJson.listWorktrees(undefined)).toThrow(
      "herdr worktree list returned invalid JSON",
    );
    expect(() => invalidEnvelope.listWorktrees(undefined)).toThrow(
      "herdr worktree list returned an invalid envelope",
    );
    expect(() => noWorktrees.listWorktrees(undefined)).toThrow(
      "herdr worktree list returned no results",
    );
    expect(() => noPlugins.listPlugins()).toThrow("herdr plugin list returned no results");
    expect(() =>
      eventEnvelope.createWorktree({
        cwd: "/tmp/probe/repo",
        branch: "probe/capture",
        base: undefined,
        path: "/tmp/probe/worktree/capture",
        label: "capture",
        focus: "no-focus",
      }),
    ).toThrow("herdr worktree create returned no results");
    expect(() =>
      missingCreateIds.createWorktree({
        cwd: "/tmp/probe/repo",
        branch: "probe/capture",
        base: undefined,
        path: "/tmp/probe/worktree/capture",
        label: "capture",
        focus: "no-focus",
      }),
    ).toThrow("herdr worktree create returned no results");
  });

  it("rejects empty workspace and root-pane identifiers", () => {
    const responses = [
      { workspace: { workspace_id: "" }, root_pane: { pane_id: "w3:p1" } },
      { workspace: { workspace_id: "w3" }, root_pane: { pane_id: "" } },
    ];

    for (const result of responses) {
      const client = createHerdrClient(
        createRecordingRunner({
          herdr: { exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" },
        }),
        undefined,
      );

      expect(() =>
        client.createWorktree({
          cwd: "/tmp/probe/repo",
          branch: "probe/capture",
          base: undefined,
          path: "/tmp/probe/worktree/capture",
          label: "capture",
          focus: "no-focus",
        }),
      ).toThrow("herdr worktree create returned no results");
    }
  });
});
