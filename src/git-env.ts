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
 * boundary keeps commands scoped to the repository in their argv.
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
