import { describe, expect, it } from "bun:test";
import { HELP_TEXT, PROJECT_NAME, PROJECT_VERSION, runCli, type CliIO } from "./cli.ts";

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
});
