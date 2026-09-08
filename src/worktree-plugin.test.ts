import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./command-runner.ts";
import {
  PROJECT_PLUGIN_ID,
  runPluginInstall,
  runWorktreeEvent,
  type WorktreeEventOptions,
} from "./worktree-plugin.ts";
import { getWorktreeStatusPaths, readWorktreeStatus } from "./worktree-status.ts";
import { runWorktreeSetup } from "./worktree-setup.ts";

const created: string[] = [];
const pluginRoot = fileURLToPath(new URL("../plugin", import.meta.url));

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/herdr-0.9.0/${name}`, import.meta.url), "utf8");

const makeProject = (): {
  readonly root: string;
  readonly mainCheckout: string;
  readonly worktreePath: string;
} => {
  const root = mkdtempSync("/tmp/devenv-agents-plugin-");
  const mainCheckout = join(root, "main");
  const worktreePath = join(root, "worktree");
  mkdirSync(join(mainCheckout, ".agents"), { recursive: true });
  mkdirSync(worktreePath);
  writeFileSync(join(mainCheckout, ".agents", "project.toml"), 'session = "fixture"\n');
  created.push(root);
  return {
    root,
    mainCheckout: realpathSync(mainCheckout),
    worktreePath: realpathSync(worktreePath),
  };
};

const gitResponse = (mainCheckout: string, worktreePath: string): [string, CommandResult] => [
  `git -C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`,
  result(0, `${mainCheckout}/.git\n`),
];

const eventOptions = (
  runner: RecordingRunner,
  eventJson: string,
  now = (): string => "2026-09-08T01:00:00.000Z",
): WorktreeEventOptions => ({
  eventJson,
  workspaceId: undefined,
  herdrPath: undefined,
  now,
  runner,
});

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktree plugin manifest", () => {
  it("declares the three lifecycle events and an unfocused setup overlay", () => {
    const manifest = Bun.TOML.parse(
      readFileSync(join(pluginRoot, "herdr-plugin.toml"), "utf8"),
    ) as {
      id: string;
      min_herdr_version: string;
      platforms: string[];
      events: { on: string; command: string[] }[];
      panes: { id: string; title: string; placement: string; command: string[] }[];
      build: unknown;
    };

    expect(manifest.id).toBe(PROJECT_PLUGIN_ID);
    expect(manifest.min_herdr_version).toBe("0.9.0");
    expect(manifest.platforms).toEqual(["linux", "macos"]);
    expect(manifest.events.map((event) => event.on)).toEqual([
      "worktree.created",
      "worktree.opened",
      "workspace.focused",
    ]);
    expect(
      manifest.events.every((event) => event.command.join(" ").includes("project wt on-event")),
    ).toBe(true);
    expect(manifest.panes).toEqual([
      {
        id: "setup",
        title: "Worktree setup",
        placement: "overlay",
        command: ["bash", "-c", "exec project worktree-setup --interactive"],
      },
    ]);
    expect(manifest.build).toBe(undefined);
  });
});

describe("worktree plugin event hook", () => {
  it("opens one unfocused setup overlay and hands its claim to setup", () => {
    const { mainCheckout, worktreePath } = makeProject();
    const [gitKey, gitResult] = gitResponse(mainCheckout, worktreePath);
    const openKey = [
      "herdr",
      "plugin",
      "pane",
      "open",
      "--plugin",
      PROJECT_PLUGIN_ID,
      "--entrypoint",
      "setup",
      "--placement",
      "overlay",
      "--cwd",
      worktreePath,
      "--no-focus",
    ].join(" ");
    const runner = createRecordingRunner({
      [gitKey]: gitResult,
      [openKey]: result(0),
      "devenv shell -- true": result(0),
      "herdr pane list": result(0, fixture("pane-list.json")),
    });
    const eventPayload = JSON.parse(fixture("worktree-created-event.json")) as {
      worktree: { path: string };
    };
    eventPayload.worktree.path = worktreePath;
    const eventJson = JSON.stringify(eventPayload);
    const first = runWorktreeEvent(eventOptions(runner, eventJson));
    const second = runWorktreeEvent(
      eventOptions(runner, JSON.stringify({ worktree: { path: worktreePath } })),
    );

    expect(first).toEqual({
      exitCode: 0,
      worktreePath,
      mainCheckout,
      claimed: true,
      opened: true,
      error: undefined,
    });
    expect(second.opened).toBe(false);
    expect(second.error).toBe(undefined);
    expect(
      runner.calls.filter((call) => call.args.includes("pane") && call.args.includes("open")),
    ).toHaveLength(1);

    const setup = runWorktreeSetup({
      allowCompleted: undefined,
      mainCheckout,
      now: () => "2026-09-08T01:00:01.000Z",
      runner,
      syncReferences: () => undefined,
      worktreePath,
    });

    expect(setup.exitCode).toBe(0);
    expect(readWorktreeStatus(setup.statusPath)?.state).toBe("done");
    expect(existsSync(setup.claimPath)).toBe(false);
  });

  it("resolves a linked worktree from a focused workspace id", () => {
    const { mainCheckout, worktreePath } = makeProject();
    const worktreeList = JSON.parse(fixture("worktree-list.json")) as {
      result: { worktrees: Record<string, unknown>[] };
    };
    worktreeList.result.worktrees = [
      { ...worktreeList.result.worktrees[0], open_workspace_id: "other" },
      { ...worktreeList.result.worktrees[1], open_workspace_id: "w42", path: worktreePath },
      { path: "/tmp/not-linked", open_workspace_id: "w42", is_linked_worktree: false },
    ];
    const [gitKey, gitResult] = gitResponse(mainCheckout, worktreePath);
    const listKey = "herdr worktree list --workspace w42";
    const openKey = [
      "herdr",
      "plugin",
      "pane",
      "open",
      "--plugin",
      PROJECT_PLUGIN_ID,
      "--entrypoint",
      "setup",
      "--placement",
      "overlay",
      "--cwd",
      worktreePath,
      "--no-focus",
    ].join(" ");
    const runner = createRecordingRunner({
      [listKey]: result(0, JSON.stringify(worktreeList)),
      [gitKey]: gitResult,
      [openKey]: result(0),
    });

    const event = runWorktreeEvent({
      eventJson: JSON.stringify({ workspace: { workspace_id: "w42" } }),
      herdrPath: undefined,
      now: () => "2026-09-08T01:00:00.000Z",
      runner,
      workspaceId: undefined,
    });

    expect(event.worktreePath).toBe(worktreePath);
    expect(event.opened).toBe(true);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "worktree", "list", "--workspace", "w42"],
      ["git", "-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      [
        "herdr",
        "plugin",
        "pane",
        "open",
        "--plugin",
        PROJECT_PLUGIN_ID,
        "--entrypoint",
        "setup",
        "--placement",
        "overlay",
        "--cwd",
        worktreePath,
        "--no-focus",
      ],
    ]);
  });

  it("records an overlay launch failure and permits a later retry", () => {
    const { mainCheckout, worktreePath } = makeProject();
    const [gitKey, gitResult] = gitResponse(mainCheckout, worktreePath);
    const openKey = [
      "herdr",
      "plugin",
      "pane",
      "open",
      "--plugin",
      PROJECT_PLUGIN_ID,
      "--entrypoint",
      "setup",
      "--placement",
      "overlay",
      "--cwd",
      worktreePath,
      "--no-focus",
    ].join(" ");
    const runner = createRecordingRunner({
      [gitKey]: gitResult,
      [openKey]: [result(1, "", "overlay unavailable"), result(0)],
    });

    const first = runWorktreeEvent(
      eventOptions(runner, JSON.stringify({ worktree: { path: worktreePath } })),
    );
    const statusPaths = getWorktreeStatusPaths(mainCheckout, worktreePath);

    expect(first.opened).toBe(false);
    expect(first.error).toBe("herdr plugin pane open failed with exit code 1: overlay unavailable");
    expect(readWorktreeStatus(statusPaths.statusPath)).toEqual({
      path: worktreePath,
      state: "failed",
      error: "herdr plugin pane open failed with exit code 1: overlay unavailable",
      started_at: "2026-09-08T01:00:00.000Z",
      finished_at: "2026-09-08T01:00:00.000Z",
    });
    expect(existsSync(statusPaths.claimPath)).toBe(false);

    const second = runWorktreeEvent(
      eventOptions(runner, JSON.stringify({ worktree: { path: worktreePath } })),
    );
    expect(second.opened).toBe(true);
  });

  it("ignores a worktree whose main checkout has no declaration", () => {
    const { mainCheckout, worktreePath } = makeProject();
    rmSync(join(mainCheckout, ".agents", "project.toml"));
    const [gitKey, gitResult] = gitResponse(mainCheckout, worktreePath);
    const runner = createRecordingRunner({ [gitKey]: gitResult });

    const event = runWorktreeEvent(
      eventOptions(runner, JSON.stringify({ worktree: { path: worktreePath } })),
    );

    expect(event.exitCode).toBe(0);
    expect(event.opened).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });
});

describe("plugin install", () => {
  it("links the plugin when the Herdr registry has no matching entry", () => {
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify({ result: { plugins: [] } })),
    });

    const install = runPluginInstall({
      herdrPath: undefined,
      pluginPath: pluginRoot,
      runner,
    });

    expect(install.action).toBe("linked");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
      ["herdr", "plugin", "link", pluginRoot, "--enabled"],
    ]);
  });

  it("treats an enabled matching plugin as an idempotent no-op", () => {
    const listed = JSON.parse(fixture("plugin-list.json")) as {
      result: { plugins: Record<string, unknown>[] };
    };
    listed.result.plugins[0] = {
      ...listed.result.plugins[0],
      enabled: true,
      manifest_path: join(pluginRoot, "herdr-plugin.toml"),
      plugin_id: PROJECT_PLUGIN_ID,
      plugin_root: pluginRoot,
      version: "0.1.0",
    };
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify(listed)),
    });

    const install = runPluginInstall({
      herdrPath: undefined,
      pluginPath: pluginRoot,
      runner,
    });

    expect(install.action).toBe("unchanged");
    expect(runner.calls).toHaveLength(1);
  });

  it("re-links a matching local plugin when its manifest version changed", () => {
    const listed = JSON.parse(fixture("plugin-list.json")) as {
      result: { plugins: Record<string, unknown>[] };
    };
    listed.result.plugins[0] = {
      ...listed.result.plugins[0],
      enabled: true,
      manifest_path: join(pluginRoot, "herdr-plugin.toml"),
      plugin_id: PROJECT_PLUGIN_ID,
      plugin_root: pluginRoot,
      version: "0.0.9",
    };
    const runner = createRecordingRunner({
      "herdr plugin list --json": result(0, JSON.stringify(listed)),
    });

    const install = runPluginInstall({
      herdrPath: undefined,
      pluginPath: pluginRoot,
      runner,
    });

    expect(install.action).toBe("relinked");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["herdr", "plugin", "list", "--json"],
      ["herdr", "plugin", "unlink", PROJECT_PLUGIN_ID],
      ["herdr", "plugin", "link", pluginRoot, "--enabled"],
    ]);
  });
});
