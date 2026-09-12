import type { CommandRunner } from "../command-runner.ts";

/**
 * The result shape returned by a command runner in tests.
 */
export type CommandResult = ReturnType<CommandRunner["run"]>;

/**
 * The invocation shape recorded by the test command runner.
 */
export type CommandInvocation = Parameters<CommandRunner["run"]>[0];

/** A response configured for a recording runner. */
type CannedCommandResponse =
  | CommandResult
  | readonly CommandResult[]
  | ((invocation: CommandInvocation) => CommandResult);

/** Responses keyed by executable name or by its complete space-separated argv. */
type RecordingResponses = Readonly<Record<string, CannedCommandResponse>>;

/** A command runner that records every call and returns configured responses. */
export interface RecordingRunner extends CommandRunner {
  /** Every invocation received by the runner, in call order. */
  readonly calls: CommandInvocation[];
  /** Removes all recorded invocations and resets response sequence counters. */
  reset(): void;
}

const EMPTY_RESULT: CommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const copyInvocation = (invocation: CommandInvocation): CommandInvocation => ({
  command: invocation.command,
  args: [...invocation.args],
  cwd: invocation.cwd,
  env: invocation.env === undefined ? undefined : { ...invocation.env },
});

const copyResult = (result: CommandResult): CommandResult => ({ ...result });

/**
 * Creates a recording command runner for deterministic service tests.
 *
 * A response may be keyed by executable or by complete argv. Unconfigured
 * commands return a successful empty result instead of spawning a process.
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
