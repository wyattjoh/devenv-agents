import { describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWorktreeBootstrap,
  warmWorktree,
  type WorktreeBootstrap,
} from "./worktree-bootstrap.ts";
import { createFakeHerdrClient } from "./testing/herdr-client.ts";
import { withGitFixture, type GitFixture } from "./testing/git-fixture.ts";
import {
  createRecordingRunner,
  type CommandResult,
  type RecordingRunner,
} from "./testing/command-runner.ts";

type BootstrapDependencies = Parameters<typeof createWorktreeBootstrap>[0];
type BootstrapRunOptions = Parameters<WorktreeBootstrap["run"]>[0];
type BootstrapAwaitOptions = Parameters<WorktreeBootstrap["await"]>[0];
type TestRunOptions = BootstrapDependencies & BootstrapRunOptions;

type RequestOptions = Parameters<WorktreeBootstrap["request"]>[0] &
  Pick<BootstrapDependencies, "herdrClient" | "now">;

type RequestResult = ReturnType<WorktreeBootstrap["request"]>;
type InspectOptions = Parameters<WorktreeBootstrap["inspect"]>[0];
type Inspection = ReturnType<WorktreeBootstrap["inspect"]>;
type AwaitResult = ReturnType<WorktreeBootstrap["await"]>;
type AwaitTestOptions = BootstrapAwaitOptions & { readonly now: BootstrapDependencies["now"] };

type ForgetOptions = Parameters<WorktreeBootstrap["forget"]>[0];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const prepareFixture = (fixture: GitFixture): void => {
  mkdirSync(join(fixture.repository, ".agents"), { recursive: true });
  writeFileSync(join(fixture.repository, ".agents", "project.toml"), 'session = "fixture"\n');
  writeFileSync(join(fixture.worktree, "devenv.nix"), "{ pkgs, ... }: {}\n");
  writeFileSync(join(fixture.repository, "devenv.local.nix"), "{ }: {}\n");
};

const fixtureOptions = {
  prefix: "devenv-agents-bootstrap-",
  branch: "feature/bootstrap",
  worktreeName: undefined,
  env: undefined,
} as const;

const makeRunOptions = (
  fixture: GitFixture,
  runner: RecordingRunner,
  syncReferences: BootstrapDependencies["syncReferences"],
  now: (() => string) | undefined = () => "2026-09-08T01:00:00.000Z",
): TestRunOptions => ({
  mainCheckout: fixture.repository,
  worktreePath: fixture.worktree,
  herdrClient: createFakeHerdrClient(),
  runner,
  syncReferences,
  now,
  allowCompleted: undefined,
  io: undefined,
});

const requestWorktreeBootstrap = (options: RequestOptions): RequestResult => {
  const bootstrap = createWorktreeBootstrap({
    herdrClient: options.herdrClient,
    runner: createRecordingRunner(),
    syncReferences: () => undefined,
    now: options.now,
  });
  return bootstrap.request({
    mainCheckout: options.mainCheckout,
    worktreePath: options.worktreePath,
  });
};

const runWorktreeBootstrap = (options: TestRunOptions): ReturnType<WorktreeBootstrap["run"]> => {
  const { herdrClient, runner, syncReferences, now, ...runOptions } = options;
  return createWorktreeBootstrap({ herdrClient, runner, syncReferences, now }).run(runOptions);
};

const awaitWorktreeBootstrap = (options: AwaitTestOptions): AwaitResult => {
  const { now, ...awaitOptions } = options;
  return createWorktreeBootstrap({
    herdrClient: createFakeHerdrClient(),
    runner: createRecordingRunner(),
    syncReferences: () => undefined,
    now,
  }).await(awaitOptions);
};

const inspectWorktreeBootstrap = (options: InspectOptions): Inspection =>
  createWorktreeBootstrap({
    herdrClient: createFakeHerdrClient(),
    runner: createRecordingRunner(),
    syncReferences: () => undefined,
    now: undefined,
  }).inspect(options);

const forgetWorktreeBootstrap = (options: ForgetOptions): void => {
  createWorktreeBootstrap({
    herdrClient: createFakeHerdrClient(),
    runner: createRecordingRunner(),
    syncReferences: () => undefined,
    now: undefined,
  }).forget(options);
};

describe("worktree bootstrap", () => {
  it("requests one bootstrap when duplicate events arrive", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const opened: string[] = [];
      const herdrClient = createFakeHerdrClient({
        openPluginPane: ({ cwd }) => opened.push(cwd),
      });
      const options = {
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        herdrClient,
        now: () => "2026-09-08T01:00:00.000Z",
      };

      const first = requestWorktreeBootstrap(options);
      const second = requestWorktreeBootstrap(options);

      expect(first).toMatchObject({ claimed: true, opened: true, state: "running" });
      expect(second).toMatchObject({ claimed: false, opened: false, state: "running" });
      expect(opened).toEqual([fixture.worktree]);
      expect(
        inspectWorktreeBootstrap({
          mainCheckout: fixture.repository,
          worktreePath: fixture.worktree,
        }),
      ).toMatchObject({ state: "running" });
    }, fixtureOptions);
  });

  it("adopts a request handoff and runs a fresh bootstrap without one", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const runner = createRecordingRunner({ devenv: result(0) });
      let syncCalls = 0;
      const options = makeRunOptions(fixture, runner, () => {
        syncCalls += 1;
      });
      requestWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        herdrClient: options.herdrClient,
        now: options.now,
      });

      const adopted = runWorktreeBootstrap(options);
      expect(adopted).toEqual({ exitCode: 0, state: "done", error: undefined });
      expect(syncCalls).toBe(1);
      expect(
        inspectWorktreeBootstrap({
          mainCheckout: fixture.repository,
          worktreePath: fixture.worktree,
        }),
      ).toMatchObject({ state: "done" });

      forgetWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
      });
      const fresh = runWorktreeBootstrap(options);
      expect(fresh.state).toBe("done");
      expect(syncCalls).toBe(2);
    }, fixtureOptions);
  });

  it("performs the warm and sync steps in order", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const sequence: string[] = [];
      const runner = createRecordingRunner({
        "devenv allow": () => {
          sequence.push("devenv allow");
          return result(0);
        },
        "direnv allow": () => {
          sequence.push("direnv allow");
          return result(0);
        },
        "devenv shell -- true": () => {
          sequence.push("devenv shell -- true");
          return result(0);
        },
      });
      const options = makeRunOptions(fixture, runner, () => sequence.push("sync"));

      const bootstrap = runWorktreeBootstrap(options);

      expect(bootstrap.state).toBe("done");
      expect(sequence).toEqual(["devenv allow", "direnv allow", "devenv shell -- true", "sync"]);
      expect(lstatSync(join(fixture.worktree, "devenv.local.nix")).isSymbolicLink()).toBe(true);
      expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
        ["devenv", "allow"],
        ["direnv", "allow"],
        ["devenv", "shell", "--", "true"],
      ]);
    }, fixtureOptions);
  });

  it("warms the main checkout through the shared path without self-linking", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      writeFileSync(join(fixture.repository, "devenv.nix"), "{ pkgs, ... }: {}\n");
      const runner = createRecordingRunner({ devenv: result(0) });

      warmWorktree({
        mainCheckout: fixture.repository,
        worktreePath: fixture.repository,
        runner,
        devenvTemplate: undefined,
        missingDevenvError: undefined,
      });

      expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
        ["devenv", "allow"],
        ["direnv", "allow"],
        ["devenv", "shell", "--", "true"],
      ]);
      expect(lstatSync(join(fixture.repository, "devenv.local.nix")).isSymbolicLink()).toBe(false);
    }, fixtureOptions);
  });

  it("records a failure and preserves its error for inspection", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const runner = createRecordingRunner({
        "devenv allow": result(0),
        "devenv shell -- true": result(1, "", "warm exploded"),
      });
      const options = makeRunOptions(fixture, runner, () => undefined);

      const bootstrap = runWorktreeBootstrap(options);

      expect(bootstrap.exitCode).toBe(1);
      expect(bootstrap.state).toBe("failed");
      expect(bootstrap.error).toContain("devenv shell -- true");
      expect(
        inspectWorktreeBootstrap({
          mainCheckout: fixture.repository,
          worktreePath: fixture.worktree,
        }),
      ).toMatchObject({ state: "failed", error: bootstrap.error });
    }, fixtureOptions);
  });

  it("awaits done and failed states and returns timeout at the deadline", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const runner = createRecordingRunner({ devenv: result(0) });
      const options = makeRunOptions(fixture, runner, () => undefined);
      requestWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        herdrClient: options.herdrClient,
        now: options.now,
      });
      let runs = 0;
      const awaitedDone = awaitWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        deadline: "2026-09-08T01:00:05.000Z",
        now: () => "2026-09-08T01:00:01.000Z",
        sleep: () => {
          runs += 1;
          runWorktreeBootstrap(options);
        },
      });
      expect(awaitedDone).toEqual({ state: "done", error: undefined });
      expect(runs).toBe(1);

      forgetWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
      });
      const failed = runWorktreeBootstrap({
        ...options,
        runner: createRecordingRunner({ "devenv allow": result(1, "", "allow failed") }),
      });
      expect(failed.state).toBe("failed");
      expect(
        awaitWorktreeBootstrap({
          mainCheckout: fixture.repository,
          worktreePath: fixture.worktree,
          deadline: "2026-09-08T01:00:05.000Z",
          now: () => "2026-09-08T01:00:01.000Z",
          sleep: () => {
            throw new Error("sleep should not run for a terminal record");
          },
        }),
      ).toEqual({ state: "failed", error: failed.error });

      forgetWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
      });
      requestWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        herdrClient: options.herdrClient,
        now: options.now,
      });
      let current = 0;
      const timeout = awaitWorktreeBootstrap({
        mainCheckout: fixture.repository,
        worktreePath: fixture.worktree,
        deadline: "2026-09-08T01:00:02.000Z",
        now: () => `2026-09-08T01:00:0${current}.000Z`,
        sleep: () => {
          current += 1;
        },
      });
      expect(timeout).toEqual({ state: "timeout", error: undefined });
    }, fixtureOptions);
  });

  it("reports every public inspection state and forgets records", () => {
    withGitFixture((fixture) => {
      prepareFixture(fixture);
      const target = { mainCheckout: fixture.repository, worktreePath: fixture.worktree };
      expect(inspectWorktreeBootstrap(target)).toMatchObject({ state: "none" });
      requestWorktreeBootstrap({
        ...target,
        herdrClient: createFakeHerdrClient(),
        now: () => "2026-09-08T01:00:00.000Z",
      });
      expect(inspectWorktreeBootstrap(target)).toMatchObject({ state: "running" });
      runWorktreeBootstrap(
        makeRunOptions(fixture, createRecordingRunner({ devenv: result(0) }), () => undefined),
      );
      expect(inspectWorktreeBootstrap(target)).toMatchObject({ state: "done" });
      forgetWorktreeBootstrap(target);
      expect(inspectWorktreeBootstrap(target)).toMatchObject({ state: "none" });
    }, fixtureOptions);
  });
});
