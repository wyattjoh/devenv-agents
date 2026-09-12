import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./command-runner.ts";
import {
  claimWorktreeStatus,
  getWorktreeStatusPaths,
  readWorktreeStatus,
} from "./worktree-status.ts";
import {
  resolveMainCheckout,
  runInteractiveWorktreeSetup,
  runWorktreeSetup,
  type SyncReferences,
  type WorktreeSetupOptions,
} from "./worktree-setup.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const makeOptions = (
  runner: RecordingRunner,
  syncReferences: SyncReferences,
  now: (() => string) | undefined = undefined,
): WorktreeSetupOptions & { readonly mainCheckout: string; readonly worktreePath: string } => {
  const root = mkdtempSync(join("/tmp", "devenv-agents-setup-"));
  const mainCheckout = join(root, "main");
  const worktreePath = join(root, "worktree");
  mkdirSync(join(mainCheckout, ".agents"), { recursive: true });
  mkdirSync(worktreePath);
  writeFileSync(join(mainCheckout, ".agents", "project.toml"), 'session = "fixture"\n');
  writeFileSync(join(worktreePath, "devenv.nix"), "{ pkgs, ... }: {}\n");
  writeFileSync(join(mainCheckout, "devenv.local.nix"), "{ }: {}\n");
  created.push(root);
  return {
    allowCompleted: undefined,
    mainCheckout,
    worktreePath,
    runner,
    syncReferences,
    now,
  };
};

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktree setup", () => {
  it("resolves the main checkout through Git's common directory", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-git-resolution-"));
    const mainCheckout = join(root, "main");
    const worktreePath = join(root, "worktree");
    mkdirSync(mainCheckout);
    mkdirSync(worktreePath);
    created.push(root);
    const runner = createRecordingRunner({
      [`git -C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`]: result(
        0,
        `${mainCheckout}/.git\n`,
      ),
    });

    expect(resolveMainCheckout(worktreePath, runner)).toBe(realpathSync(mainCheckout));
    expect(runner.calls[0]?.env?.GIT_DIR).toBe(undefined);
  });

  it("runs allow, direnv approval, local-layer linking, noninteractive warm, and sync in order", () => {
    const paneList = JSON.stringify({
      result: {
        panes: [{ cwd: "/tmp/not-this-worktree", pane_id: "w1:p1" }],
      },
    });
    const runner = createRecordingRunner({
      devenv: result(0),
      "herdr pane list": result(0, paneList),
    });
    const syncRequests: string[] = [];
    const options = makeOptions(
      runner,
      (request) => syncRequests.push(request.projectRoot),
      () => "2026-09-08T01:00:00.000Z",
    );

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(0);
    expect(syncRequests).toEqual([options.mainCheckout]);
    expect(runner.calls).toEqual([
      { command: "devenv", args: ["allow"], cwd: options.worktreePath, env: undefined },
      { command: "direnv", args: ["allow"], cwd: options.worktreePath, env: undefined },
      {
        command: "devenv",
        args: ["shell", "--", "true"],
        cwd: options.worktreePath,
        env: undefined,
      },
      { command: "herdr", args: ["pane", "list"], cwd: undefined, env: undefined },
    ]);
    expect(lstatSync(join(options.worktreePath, "devenv.local.nix")).isSymbolicLink()).toBe(true);
    expect(readWorktreeStatus(setup.statusPath)?.state).toBe("done");
  });

  it("does not run devenv allow when a worktree has no devenv file", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    rmSync(join(options.worktreePath, "devenv.nix"));

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(0);
    expect(runner.calls.filter((call) => call.command === "devenv")).toEqual([
      {
        command: "devenv",
        args: ["shell", "--", "true"],
        cwd: options.worktreePath,
        env: undefined,
      },
    ]);
    expect(runner.calls).toEqual([
      { command: "direnv", args: ["allow"], cwd: options.worktreePath, env: undefined },
      {
        command: "devenv",
        args: ["shell", "--", "true"],
        cwd: options.worktreePath,
        env: undefined,
      },
      { command: "herdr", args: ["pane", "list"], cwd: undefined, env: undefined },
    ]);
  });

  it("continues when the main checkout has no local layer", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    rmSync(join(options.mainCheckout, "devenv.local.nix"));

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(0);
    expect(existsSync(join(options.worktreePath, "devenv.local.nix"))).toBe(false);
  });

  it("returns non-zero while another setup owns a running claim", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    const owner = claimWorktreeStatus(options.mainCheckout, options.worktreePath);
    owner?.write("running", undefined, undefined);

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(1);
    expect(setup.error).toBe("worktree setup is already claimed");
    expect(existsSync(setup.claimPath)).toBe(true);
    owner?.release();
  });

  it("returns non-zero when a claim exists before its status is written", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    const paths = getWorktreeStatusPaths(options.mainCheckout, options.worktreePath);
    mkdirSync(paths.directory, { recursive: true });
    mkdirSync(paths.claimPath);

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(1);
    expect(setup.error).toBe("worktree setup is already claimed");
    expect(existsSync(paths.claimPath)).toBe(true);
    rmSync(paths.claimPath, { recursive: true, force: true });
  });

  it("replaces a dangling local-layer symlink", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    const destination = join(options.worktreePath, "devenv.local.nix");
    symlinkSync(join(options.worktreePath, "missing-local.nix"), destination);

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(0);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(realpathSync(destination)).toBe(
      realpathSync(join(options.mainCheckout, "devenv.local.nix")),
    );
  });

  it("keeps a regular worktree local file instead of replacing it", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    const destination = join(options.worktreePath, "devenv.local.nix");
    writeFileSync(destination, "branch-local\n");

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(1);
    expect(setup.error).toContain("a regular file already exists");
    expect(existsSync(destination)).toBe(true);
  });

  it("allows an explicit rerun after done to link a newly added local layer", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const syncCalls: string[] = [];
    const options = makeOptions(runner, (request) => syncCalls.push(request.worktreePath));
    const localLayer = join(options.mainCheckout, "devenv.local.nix");
    rmSync(localLayer);

    const first = runWorktreeSetup({ ...options, allowCompleted: true });
    writeFileSync(localLayer, "{ }: { rerun = true; }\n");
    const second = runWorktreeSetup({ ...options, allowCompleted: true });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(syncCalls).toHaveLength(2);
    expect(realpathSync(join(options.worktreePath, "devenv.local.nix"))).toBe(
      realpathSync(localLayer),
    );
    expect(readWorktreeStatus(second.statusPath)?.state).toBe("done");
  });

  it("does not treat a rejected explicit repair claim as completed", () => {
    const runner = createRecordingRunner({ devenv: result(0) });
    const options = makeOptions(runner, () => undefined);
    expect(runWorktreeSetup(options).exitCode).toBe(0);

    const owner = claimWorktreeStatus(options.mainCheckout, options.worktreePath, undefined, true);
    expect(owner === undefined).toBe(false);
    runner.reset();
    const loser = runWorktreeSetup({ ...options, allowCompleted: true });

    expect(loser.exitCode).toBe(1);
    expect(loser.error).toBe("worktree setup is already claimed");
    expect(runner.calls).toEqual([]);
    owner?.release();
  });

  it("records a warm failure and returns a non-zero result", () => {
    const runner = createRecordingRunner({
      "devenv allow": result(0),
      "devenv shell -- true": result(1, "", "warm exploded"),
    });
    const options = makeOptions(
      runner,
      () => undefined,
      () => "2026-09-08T01:00:00.000Z",
    );

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(1);
    expect(setup.error).toEqual(expect.stringContaining("devenv shell -- true"));
    expect(readWorktreeStatus(setup.statusPath)).toMatchObject({
      path: realpathSync(options.worktreePath),
      state: "failed",
      error: expect.stringContaining("devenv shell -- true"),
      started_at: "2026-09-08T01:00:00.000Z",
      finished_at: "2026-09-08T01:00:00.000Z",
    });
    expect(existsSync(setup.claimPath)).toBe(false);
  });

  it("retries after Enter in interactive mode and quits by releasing the claim", () => {
    const runner = createRecordingRunner({
      "devenv allow": result(0),
      "devenv shell -- true": [result(1, "", "first"), result(0)],
    });
    const options = makeOptions(
      runner,
      () => undefined,
      () => "2026-09-08T01:00:00.000Z",
    );
    const input = [""];

    const setup = runInteractiveWorktreeSetup(options, () => input.shift() ?? "q");

    expect(setup.exitCode).toBe(0);
    expect(readWorktreeStatus(setup.statusPath)?.state).toBe("done");
    expect(existsSync(setup.claimPath)).toBe(false);

    const quittingRunner = createRecordingRunner({
      "devenv allow": result(0),
      "devenv shell -- true": result(1, "", "still broken"),
    });
    const quittingOptions = makeOptions(quittingRunner, () => undefined);
    const quit = runInteractiveWorktreeSetup(quittingOptions, () => "q");

    expect(quit.exitCode).toBe(1);
    expect(existsSync(quit.claimPath)).toBe(false);
  });

  it("keeps setup successful when no Herdr socket is available", () => {
    const runner = createRecordingRunner({
      devenv: result(0),
      herdr: result(1, "", "no socket"),
    });
    const options = makeOptions(runner, () => undefined);

    const setup = runWorktreeSetup(options);

    expect(setup.exitCode).toBe(0);
    expect(runner.calls.at(-1)).toEqual({
      command: "herdr",
      args: ["pane", "list"],
      cwd: undefined,
      env: undefined,
    });
    expect(runner.calls.some((call) => call.args[0] === "send-keys")).toBe(false);
  });

  it("wakes the pane whose launch cwd is the worktree", () => {
    const runner = createRecordingRunner({
      devenv: result(0),
      "herdr pane list": result(
        0,
        JSON.stringify({
          result: {
            panes: [
              { cwd: "/tmp/not-this-worktree", pane_id: "w1:p1" },
              { cwd: "/tmp/not-this-worktree", foreground_cwd: "/tmp/other", pane_id: "w1:p2" },
            ],
          },
        }),
      ),
    });
    const options = makeOptions(runner, () => undefined);
    const panePath = options.worktreePath;
    const response = JSON.stringify({
      result: {
        panes: [
          { cwd: "/tmp/setup-overlay", pane_id: "w2:p9" },
          { cwd: panePath, pane_id: "w2:p8" },
        ],
      },
    });
    runner.reset();
    const setupRunner = createRecordingRunner({
      devenv: result(0),
      "herdr pane list": result(0, response),
    });
    const setup = runWorktreeSetup({ ...options, runner: setupRunner });

    expect(setup.exitCode).toBe(0);
    expect(setupRunner.calls.at(-1)).toEqual({
      command: "herdr",
      args: ["pane", "send-keys", "w2:p8", "Enter"],
      cwd: undefined,
      env: undefined,
    });
  });
});
