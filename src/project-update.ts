import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  runCommand,
  runGitCommand,
  type CommandResult,
  type CommandRunner,
} from "./command-runner.ts";
import { resolveMainCheckout } from "./worktree-setup.ts";

/**
 * The operation represented by one project-update report item.
 */
export type ProjectUpdateKind = "agents-input" | "main" | "worktree-list" | "worktree";

/**
 * The result of updating one project path or worktree.
 */
export type ProjectUpdateItem = {
  readonly kind: ProjectUpdateKind;
  readonly path: string;
  readonly success: boolean;
  readonly error: string | undefined;
};

/**
 * The complete report from updating a project and its linked worktrees.
 */
export type ProjectUpdateResult = {
  readonly mainCheckout: string;
  readonly items: readonly ProjectUpdateItem[];
  readonly exitCode: number;
};

/**
 * Dependencies and project path needed for one update.
 */
export type ProjectUpdateOptions = {
  readonly projectPath: string;
  readonly runner: CommandRunner;
};

const commandFailure = (label: string, result: CommandResult): Error => {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return new Error(`${label} failed with exit code ${result.exitCode}: ${detail}`);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const comparablePath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const samePath = (left: string, right: string): boolean =>
  comparablePath(left) === comparablePath(right);

const worktreePaths = (stdout: string, mainCheckout: string): readonly string[] =>
  stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path.length > 0)
    .map((path) => (isAbsolute(path) ? path : resolve(mainCheckout, path)))
    .filter((path) => !samePath(path, mainCheckout));

const listWorktrees = (mainCheckout: string, runner: CommandRunner): readonly string[] => {
  const result = runGitCommand(
    runner,
    ["-C", mainCheckout, "worktree", "list", "--porcelain"],
    mainCheckout,
  );
  if (result.exitCode !== 0) throw commandFailure("git worktree list", result);
  return worktreePaths(result.stdout, mainCheckout);
};

const runDevenv = (
  runner: CommandRunner,
  kind: ProjectUpdateKind,
  path: string,
  args: readonly string[],
  label: string,
): ProjectUpdateItem => {
  try {
    const result = runCommand(runner, "devenv", args, { cwd: path, env: undefined });
    if (result.exitCode !== 0) throw commandFailure(label, result);
    return { kind, path, success: true, error: undefined };
  } catch (error) {
    return { kind, path, success: false, error: errorMessage(error) };
  }
};

/**
 * Updates the agents input and rebuilds a project's main checkout and every
 * linked Git worktree. A failed step is captured and does not stop later
 * worktrees from being attempted.
 *
 * @param options Project path and injected command runner.
 * @returns Ordered step results and a non-zero exit code when any step failed.
 */
export const runProjectUpdate = (options: ProjectUpdateOptions): ProjectUpdateResult => {
  const mainCheckout = resolveMainCheckout(options.projectPath, options.runner);
  const items: ProjectUpdateItem[] = [];
  items.push(
    runDevenv(
      options.runner,
      "agents-input",
      mainCheckout,
      ["update", "agents"],
      "devenv update agents",
    ),
  );

  items.push(
    runDevenv(
      options.runner,
      "main",
      mainCheckout,
      ["shell", "--", "true"],
      "devenv shell -- true",
    ),
  );

  let worktrees: readonly string[];
  try {
    worktrees = listWorktrees(mainCheckout, options.runner);
  } catch (error) {
    items.push({
      kind: "worktree-list",
      path: mainCheckout,
      success: false,
      error: errorMessage(error),
    });
    return { mainCheckout, items, exitCode: 1 };
  }
  for (const worktree of worktrees) {
    items.push(
      runDevenv(
        options.runner,
        "worktree",
        worktree,
        ["shell", "--", "true"],
        "devenv shell -- true",
      ),
    );
  }

  return {
    mainCheckout,
    items,
    exitCode: items.some((item) => !item.success) ? 1 : 0,
  };
};

const itemLabel = (kind: ProjectUpdateKind): string => {
  if (kind === "agents-input") return "Agents input";
  if (kind === "main") return "Main checkout";
  if (kind === "worktree-list") return "Worktree list";
  return "Worktree";
};

/**
 * Formats an update report for a human-readable CLI response.
 *
 * @param result Report returned by {@link runProjectUpdate}.
 * @param projectName Optional prefix used by `update --all`.
 * @returns One newline-terminated summary containing every step and failure.
 */
export const formatProjectUpdate = (
  result: ProjectUpdateResult,
  projectName: string | undefined = undefined,
): string => {
  const prefix = projectName === undefined ? "" : `[${projectName}] `;
  const lines = result.items.map((item) => {
    const status = item.success ? "succeeded" : `failed: ${item.error ?? "unknown error"}`;
    return `${prefix}${itemLabel(item.kind)} (${item.path}): ${status}`;
  });
  const succeeded = result.items.filter((item) => item.success).length;
  const failed = result.items.length - succeeded;
  lines.push(`${prefix}Summary: ${succeeded} succeeded, ${failed} failed`);
  return `${lines.join("\n")}\n`;
};
