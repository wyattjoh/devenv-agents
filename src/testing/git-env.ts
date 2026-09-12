import { cleanGitEnv } from "../command-runner.ts";

/**
 * The captured result of a Git process.
 */
export type GitResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

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
  const result = Bun.spawnSync(["git", ...args], {
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    env: cleanGitEnv(options?.env ?? process.env),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
