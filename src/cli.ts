#!/usr/bin/env bun

import { defaultCommandRunner, type CommandRunner } from "./command-runner.ts";
import {
  noOpSyncReferences,
  runInteractiveWorktreeSetup,
  runWorktreeSetup,
  type SyncReferences,
} from "./worktree-setup.ts";

/**
 * The public command name used by the standalone binary and the Bun entrypoint.
 */
export const PROJECT_NAME = "project";

/**
 * The initial version of the project CLI.
 */
export const PROJECT_VERSION = "0.1.0";

/**
 * The output channels used by the CLI, kept injectable so command behavior can
 * be tested without replacing the process streams.
 */
export type CliIO = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/**
 * The help text for the project CLI.
 */
export const HELP_TEXT = `Usage: ${PROJECT_NAME} [options]

Project lifecycle tooling for devenv and Herdr worktrees.

Commands:
  worktree-setup [--interactive]  Bootstrap the current worktree

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Runtime seams used by commands without replacing the process itself.
 */
export type CliDependencies = {
  readonly cwd: string | undefined;
  readonly now: () => string;
  readonly readLine: () => string;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
};

const interactiveLine = (): string => {
  const promptFunction = (
    globalThis as typeof globalThis & {
      prompt?: (message?: string) => string | null;
    }
  ).prompt;
  return promptFunction?.("Press Enter to retry or q to quit: ") ?? "q";
};

const defaultDependencies = (): CliDependencies => ({
  cwd: undefined,
  now: () => new Date().toISOString(),
  readLine: interactiveLine,
  runner: defaultCommandRunner,
  syncReferences: noOpSyncReferences,
});

const isHelpFlag = (argument: string): boolean => argument === "--help" || argument === "-h";

const isVersionFlag = (argument: string): boolean => argument === "--version" || argument === "-v";

const printUnknown = (output: CliIO, argument: string): number => {
  output.stderr(`${PROJECT_NAME}: unknown argument '${argument}'\n`);
  output.stderr(`Run '${PROJECT_NAME} --help' for usage.\n`);
  return 1;
};

const runWorktreeSetupCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  interactive: boolean,
): number => {
  const options = {
    allowCompleted: true,
    mainCheckout: undefined,
    now: dependencies.now,
    runner: dependencies.runner,
    syncReferences: dependencies.syncReferences,
    worktreePath: dependencies.cwd ?? process.cwd(),
  };
  const reportFailure = (result: ReturnType<typeof runWorktreeSetup>): void => {
    output.stderr(`${PROJECT_NAME} worktree-setup: ${result.error ?? "setup failed"}\n`);
    if (interactive) output.stderr("Press Enter to retry or q to quit.\n");
  };

  try {
    const result = interactive
      ? runInteractiveWorktreeSetup(options, dependencies.readLine, reportFailure)
      : runWorktreeSetup(options);
    if (result.exitCode !== 0 && !interactive) reportFailure(result);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.stderr(`${PROJECT_NAME} worktree-setup: ${message}\n`);
    return 1;
  }
};

/**
 * Runs the project CLI for the supplied arguments.
 *
 * @param args Arguments after the executable name.
 * @param io Output channels used for the response.
 * @param dependencies Injectable command, filesystem-context, clock, and input seams.
 * @returns The process exit code, without terminating the current process.
 */
export const runCli = (
  args: readonly string[],
  io: CliIO | undefined = undefined,
  dependencies: CliDependencies | undefined = undefined,
): number => {
  const output = io ?? processIO;

  if (args.length === 0 || args.some(isHelpFlag)) {
    output.stdout(HELP_TEXT);
    return 0;
  }

  if (args.length === 1 && isVersionFlag(args[0] ?? "")) {
    output.stdout(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);
    return 0;
  }

  const command = args[0] ?? "";
  if (command === "worktree-setup") {
    const commandArguments = args.slice(1);
    if (
      commandArguments.length > 1 ||
      (commandArguments.length === 1 && commandArguments[0] !== "--interactive")
    ) {
      return printUnknown(output, commandArguments[0] ?? command);
    }
    return runWorktreeSetupCommand(
      output,
      dependencies ?? defaultDependencies(),
      commandArguments.length === 1,
    );
  }

  return printUnknown(output, command);
};

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
