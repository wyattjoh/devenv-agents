import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HELP_TEXT,
  PROJECT_NAME,
  PROJECT_VERSION,
  runCli,
  type CliDependencies,
  type CliIO,
} from "./cli.ts";
import { createRecordingRunner, type CommandResult } from "./command-runner.ts";

const created: string[] = [];

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

type CapturedOutput = {
  readonly io: CliIO;
  readonly stdout: () => string;
  readonly stderr: () => string;
};

const captureOutput = (): CapturedOutput => {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe("project CLI", () => {
  it("prints its version from the source entrypoint", () => {
    const output = captureOutput();

    expect(runCli(["--version"], output.io)).toBe(0);
    expect(output.stdout()).toBe(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);
    expect(output.stderr()).toBe("");
  });

  it("prints help from the source entrypoint", () => {
    const output = captureOutput();

    expect(runCli(["--help"], output.io)).toBe(0);
    expect(output.stdout()).toBe(HELP_TEXT);
    expect(output.stderr()).toBe("");
  });

  it("prints help for a bare invocation", () => {
    const output = captureOutput();

    expect(runCli([], output.io)).toBe(0);
    expect(output.stdout()).toBe(HELP_TEXT);
  });

  it("rejects unsupported arguments without terminating the test process", () => {
    const output = captureOutput();

    expect(runCli(["--not-a-command"], output.io)).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(
      "project: unknown argument '--not-a-command'\nRun 'project --help' for usage.\n",
    );
  });

  it("runs worktree setup through the injected runner", () => {
    const root = mkdtempSync(join("/tmp", "devenv-agents-cli-"));
    const mainCheckout = join(root, "main");
    const worktreePath = join(root, "worktree");
    mkdirSync(join(mainCheckout, ".agents"), { recursive: true });
    mkdirSync(worktreePath);
    writeFileSync(join(mainCheckout, ".agents", "project.toml"), 'session = "fixture"\n');
    writeFileSync(join(worktreePath, "devenv.nix"), "{ }: {}\n");
    created.push(root);

    const runner = createRecordingRunner({
      [`git -C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`]: result(
        0,
        `${mainCheckout}/.git\n`,
      ),
      devenv: result(0),
      herdr: result(1, "", "no socket"),
    });
    const dependencies: CliDependencies = {
      cwd: worktreePath,
      now: () => "2026-09-08T01:00:00.000Z",
      readLine: () => "q",
      runner,
      syncReferences: () => undefined,
    };
    const output = captureOutput();

    expect(runCli(["worktree-setup"], output.io, dependencies)).toBe(0);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["git", "-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["devenv", "allow"],
      ["devenv", "shell", "--", "true"],
      ["herdr", "pane", "list"],
    ]);
  });
});
