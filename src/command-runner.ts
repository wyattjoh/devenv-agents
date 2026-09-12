import { cleanGitEnv } from "./git-env.ts";

/**
 * External commands that the fleet invokes directly.
 */
export const EXTERNAL_COMMANDS = ["herdr", "devenv", "direnv", "systemctl", "git"] as const;

/**
 * Names of the external commands used by the fleet.
 */
export type ExternalCommand = (typeof EXTERNAL_COMMANDS)[number];

/**
 * A completed external-command invocation.
 */
export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * A required external command that exited unsuccessfully.
 */
export class CommandFailure extends Error {
  /**
   * The label assigned to the failed operation.
   */
  readonly label: string;

  /**
   * The non-zero exit code returned by the command.
   */
  readonly exitCode: number;

  /**
   * The complete captured result returned by the command runner.
   */
  readonly result: CommandResult;

  /**
   * Creates a typed failure from a command result.
   *
   * @param label Human-readable operation label.
   * @param result Captured result from the failed command.
   */
  constructor(label: string, result: CommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    super(`${label} failed with exit code ${result.exitCode}: ${detail}`);
    this.name = "CommandFailure";
    this.label = label;
    this.exitCode = result.exitCode;
    this.result = result;
  }
}

/**
 * The command and process settings supplied to a command runner.
 */
export type CommandInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
};

/**
 * Optional process settings accepted by {@link runCommand}.
 */
export type CommandOptions = {
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
};

/**
 * The injectable boundary for commands invoked by fleet services.
 */
export interface CommandRunner {
  /**
   * Runs one external command and captures its result.
   *
   * @param invocation Command and process settings to use.
   * @returns The command's exit code and captured output.
   */
  run(invocation: CommandInvocation): CommandResult;
}

const copyInvocation = (invocation: CommandInvocation): CommandInvocation => ({
  command: invocation.command,
  args: [...invocation.args],
  cwd: invocation.cwd,
  env: invocation.env === undefined ? undefined : { ...invocation.env },
});

const inheritedEnvironment = (
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Runs a real external command through Bun's synchronous process API.
 */
export const realCommandRunner: CommandRunner = {
  run: (invocation) => {
    const result = Bun.spawnSync([invocation.command, ...invocation.args], {
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.env === undefined ? {} : { env: inheritedEnvironment(invocation.env) }),
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
};

/**
 * The default runner used by production code.
 */
export const defaultCommandRunner = realCommandRunner;

/**
 * Runs one command through an injected runner.
 *
 * @param runner Runner implementation, real or recording.
 * @param command Executable name or path.
 * @param args Arguments passed to the executable.
 * @param options Optional working directory and environment overrides.
 * @returns The runner's captured command result.
 */
export const runCommand = (
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: CommandOptions | undefined = undefined,
): CommandResult =>
  runner.run({
    command,
    args: [...args],
    cwd: options?.cwd,
    env: options?.env,
  });

/**
 * Converts an unknown thrown value into its display message.
 *
 * @param error Value thrown by an operation.
 * @returns The Error message or the string representation of the value.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs one command and throws when it exits unsuccessfully.
 *
 * @param runner Runner implementation, real or recording.
 * @param label Human-readable operation label used in failures.
 * @param command Executable name or path.
 * @param args Arguments passed to the executable.
 * @param options Optional working directory and environment overrides.
 * @returns The runner's captured command result when it succeeds.
 * @throws {@link CommandFailure} When the command exits with a non-zero code.
 */
export const runRequiredCommand = (
  runner: CommandRunner,
  label: string,
  command: string,
  args: readonly string[],
  options: CommandOptions | undefined = undefined,
): CommandResult => {
  const result = runCommand(runner, command, args, options);
  if (result.exitCode !== 0) throw new CommandFailure(label, result);
  return result;
};

/**
 * Runs Git and throws when it exits unsuccessfully, sanitizing repository variables.
 *
 * @param runner Runner implementation, real or recording.
 * @param label Human-readable operation label used in failures.
 * @param args Arguments passed after the `git` executable.
 * @param cwd Working directory for Git, or undefined to inherit the caller's directory.
 * @param env Base environment to sanitize, or undefined to use the current process.
 * @returns Git's captured result when it succeeds.
 * @throws {@link CommandFailure} When Git exits with a non-zero code.
 */
export const runRequiredGitCommand = (
  runner: CommandRunner,
  label: string,
  args: readonly string[],
  cwd: string | undefined = undefined,
  env: Readonly<Record<string, string | undefined>> | undefined = undefined,
): CommandResult =>
  runRequiredCommand(runner, label, "git", args, {
    cwd,
    env: cleanGitEnv(env ?? process.env),
  });

/**
 * Runs Git through the injected runner with repository-location variables removed.
 *
 * @param runner Runner implementation, real or recording.
 * @param args Arguments passed after the `git` executable.
 * @param cwd Working directory for Git, or undefined to inherit the caller's directory.
 * @param env Base environment to sanitize, or undefined to use the current process.
 * @returns Git's captured result.
 */
export const runGitCommand = (
  runner: CommandRunner,
  args: readonly string[],
  cwd: string | undefined = undefined,
  env: Readonly<Record<string, string | undefined>> | undefined = undefined,
): CommandResult =>
  runCommand(runner, "git", args, {
    cwd,
    env: cleanGitEnv(env ?? process.env),
  });

/**
 * A response configured for a recording runner. Arrays provide responses for
 * repeated calls in order, and a function can derive a response from a call.
 */
export type CannedCommandResponse =
  | CommandResult
  | readonly CommandResult[]
  | ((invocation: CommandInvocation) => CommandResult);

/**
 * Responses keyed by executable name or by its complete space-separated argv.
 */
export type RecordingResponses = Readonly<Record<string, CannedCommandResponse>>;

/**
 * A command runner that records every call and returns configured responses.
 */
export interface RecordingRunner extends CommandRunner {
  /**
   * Every invocation received by the runner, in call order.
   */
  readonly calls: CommandInvocation[];

  /**
   * Removes all recorded invocations and resets response sequence counters.
   */
  reset(): void;
}

const EMPTY_RESULT: CommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const copyResult = (result: CommandResult): CommandResult => ({ ...result });

/**
 * Creates a recording command runner for deterministic service tests.
 *
 * A response may be keyed by `herdr`, `devenv`, `direnv`, or `systemctl`, or by the
 * complete invocation such as `herdr plugin list`. Unconfigured commands
 * return a successful empty result instead of spawning a process.
 *
 * @param responses Canned responses keyed by executable or complete argv.
 * @returns A recording runner suitable for dependency injection.
 */
export const createRecordingRunner = (
  responses: RecordingResponses | undefined = undefined,
): RecordingRunner => {
  const configured = responses ?? {};
  const calls: CommandInvocation[] = [];
  const sequence = new Map<string, number>();

  const run = (invocation: CommandInvocation): CommandResult => {
    const recorded = copyInvocation(invocation);
    calls.push(recorded);

    const exactKey = [invocation.command, ...invocation.args].join(" ");
    const responseKey = configured[exactKey] === undefined ? invocation.command : exactKey;
    const response = configured[responseKey];
    if (response === undefined) return copyResult(EMPTY_RESULT);

    if (typeof response === "function") return copyResult(response(recorded));
    if ("exitCode" in response) return copyResult(response);

    const index = sequence.get(responseKey) ?? 0;
    sequence.set(responseKey, index + 1);
    return copyResult(response[Math.min(index, response.length - 1)] ?? EMPTY_RESULT);
  };

  return {
    calls,
    run,
    reset: () => {
      calls.splice(0, calls.length);
      sequence.clear();
    },
  };
};
