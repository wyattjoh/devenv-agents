import { describe, expect, it } from "bun:test";
import {
  createRecordingRunner,
  defaultCommandRunner,
  runCommand,
  type CommandResult,
} from "./command-runner.ts";

const result = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("command runner", () => {
  it("records Herdr, devenv, and systemctl calls and returns canned responses", () => {
    const runner = createRecordingRunner({
      herdr: result("herdr response"),
      devenv: result("devenv response"),
      systemctl: result("systemctl response"),
    });

    expect(runCommand(runner, "herdr", ["pane", "list"]).stdout).toBe("herdr response");
    expect(runCommand(runner, "devenv", ["allow"]).stdout).toBe("devenv response");
    expect(runCommand(runner, "systemctl", ["--user", "daemon-reload"]).stdout).toBe(
      "systemctl response",
    );
    expect(runner.calls).toEqual([
      { command: "herdr", args: ["pane", "list"], cwd: undefined, env: undefined },
      { command: "devenv", args: ["allow"], cwd: undefined, env: undefined },
      {
        command: "systemctl",
        args: ["--user", "daemon-reload"],
        cwd: undefined,
        env: undefined,
      },
    ]);
  });

  it("supports response sequences for repeated calls", () => {
    const runner = createRecordingRunner({
      "herdr plugin list": [result("first"), result("second")],
    });

    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("first");
    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("second");
    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("second");
  });

  it("advances command-keyed response arrays across different argument lists", () => {
    const runner = createRecordingRunner({
      herdr: [result("first"), result("second")],
    });

    expect(runCommand(runner, "herdr", ["pane", "list"]).stdout).toBe("first");
    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("second");
  });

  it("keeps exact-argv precedence and counters separate from command responses", () => {
    const runner = createRecordingRunner({
      herdr: [result("command-first"), result("command-second")],
      "herdr pane list": [result("exact-first"), result("exact-second")],
    });

    expect(runCommand(runner, "herdr", ["pane", "list"]).stdout).toBe("exact-first");
    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("command-first");
    expect(runCommand(runner, "herdr", ["pane", "list"]).stdout).toBe("exact-second");
    expect(runCommand(runner, "herdr", ["workspace", "list"]).stdout).toBe("command-second");
  });

  it("resets recorded calls and response sequences", () => {
    const runner = createRecordingRunner({
      herdr: [result("first"), result("second")],
    });

    expect(runCommand(runner, "herdr", ["pane", "list"]).stdout).toBe("first");
    runner.reset();
    expect(runner.calls).toEqual([]);
    expect(runCommand(runner, "herdr", ["plugin", "list"]).stdout).toBe("first");
  });

  it("spawns a real command through the default runner", () => {
    const response = runCommand(defaultCommandRunner, process.execPath, [
      "-e",
      "process.stdout.write('runner-ok')",
    ]);

    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBe("runner-ok");
    expect(response.stderr).toBe("");
  });

  it("returns a successful empty response for an unconfigured recording call", () => {
    const runner = createRecordingRunner();

    expect(runCommand(runner, "devenv", ["shell", "--", "true"])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});
