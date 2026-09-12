import { defaultCommandRunner, runGitCommand } from "../command-runner.ts";

/**
 * The captured result of a Git process.
 */
export type GitResult = ReturnType<typeof runGitCommand>;

/**
 * Optional settings for a sanitized Git spawn.
 */
export type SpawnGitOptions = {
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
};

/**
 * Runs Git with a sanitized environment and captures stdout and stderr.
 *
 * @param args Arguments passed after the `git` executable.
 * @param options Optional child working directory and base environment.
 * @returns Git's exit code and captured output.
 */
export const spawnGit = (
  args: readonly string[],
  options: SpawnGitOptions | undefined = undefined,
): GitResult => {
  return runGitCommand(defaultCommandRunner, args, options?.cwd, options?.env);
};
