/**
 * Environment variables that tell Git which repository to operate on.
 */
export const GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
] as const;

const gitEnvKeys: ReadonlySet<string> = new Set(GIT_ENV_KEYS);

/**
 * Copies an environment without Git repository-location variables.
 *
 * Git's `-C` option changes directory, but it does not override `GIT_DIR` or
 * the other repository-location variables. Removing them at the spawn
 * boundary keeps fixture commands scoped to the repository in their argv.
 *
 * @param env Environment to sanitize. Defaults to the current process.
 * @returns A string-only environment safe to pass to a Git child process.
 */
export const cleanGitEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !gitEnvKeys.has(entry[0]),
    ),
  );

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
