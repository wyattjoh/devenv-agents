import type { CliDependencies, CliIO } from "../cli.ts";
import { createRecordingRunner } from "../command-runner.ts";
import { createFakeHerdrClient } from "./herdr-client.ts";
import { createFakeWorktreeBootstrap } from "./worktree-bootstrap.ts";

/**
 * Captured output channels for CLI tests.
 */
export type CapturedOutput = {
  readonly io: CliIO;
  readonly stdout: () => string;
  readonly stderr: () => string;
};

/**
 * Creates output channels that retain each stream for assertions.
 *
 * @returns Injectable CLI output channels and stream accessors.
 */
export const captureOutput = (): CapturedOutput => {
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

/**
 * Creates the standard injectable dependencies used by CLI tests.
 *
 * The defaults are side-effect-free adapters, an empty environment snapshot,
 * and a deterministic clock. Individual tests can replace only the seams they
 * exercise.
 *
 * @param overrides Dependency values to replace for one test.
 * @returns A complete dependency record suitable for {@link import("../cli.ts").runCli}.
 */
export const createCliDependencies = (
  overrides: Partial<CliDependencies> = {},
): CliDependencies => ({
  cwd: undefined,
  now: () => "2026-09-08T01:00:00.000Z",
  readLine: () => "q",
  runner: createRecordingRunner(),
  herdrClient: createFakeHerdrClient(),
  syncReferences: () => undefined,
  bootstrap: createFakeWorktreeBootstrap(),
  environment: {},
  pluginPath: undefined,
  ...overrides,
});
