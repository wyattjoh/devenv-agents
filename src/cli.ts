#!/usr/bin/env bun

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
 * The help text for the scaffold CLI.
 */
export const HELP_TEXT = `Usage: ${PROJECT_NAME} [options]

Project lifecycle tooling for devenv and Herdr worktrees.

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const isHelpFlag = (argument: string): boolean => argument === "--help" || argument === "-h";

const isVersionFlag = (argument: string): boolean => argument === "--version" || argument === "-v";

/**
 * Runs the scaffold CLI for the supplied arguments.
 *
 * @param args Arguments after the executable name.
 * @param io Output channels used for the response.
 * @returns The process exit code, without terminating the current process.
 */
export const runCli = (args: readonly string[], io: CliIO | undefined = undefined): number => {
  const output = io ?? processIO;

  if (args.length === 0 || args.some(isHelpFlag)) {
    output.stdout(HELP_TEXT);
    return 0;
  }

  if (args.length === 1 && isVersionFlag(args[0] ?? "")) {
    output.stdout(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);
    return 0;
  }

  const unknown = args[0] ?? "";
  output.stderr(`${PROJECT_NAME}: unknown argument '${unknown}'\n`);
  output.stderr(`Run '${PROJECT_NAME} --help' for usage.\n`);
  return 1;
};

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
