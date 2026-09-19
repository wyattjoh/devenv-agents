import { errorMessage, runRequiredCommand, type CommandRunner } from "./command-runner.ts";
import { readProjectDeclaration } from "./project-declaration.ts";
import type { SyncReferences } from "./project-sync.ts";
import { listLinkedWorktrees, resolveMainCheckout, type WorkspaceWorktree } from "./workspace.ts";
import { warmWorktree } from "./worktree-bootstrap.ts";

/**
 * The operation represented by one project-update report item.
 */
type ProjectUpdateKind = "agents-input" | "main" | "worktree-list" | "worktree";

/**
 * The result of updating one project path or worktree.
 */
type ProjectUpdateItem = {
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
type ProjectUpdateOptions = {
  readonly projectPath: string;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
};

const runDevenv = (
  runner: CommandRunner,
  kind: ProjectUpdateKind,
  path: string,
  args: readonly string[],
  label: string,
): ProjectUpdateItem => {
  try {
    runRequiredCommand(runner, label, "devenv", args, { cwd: path, env: undefined });

    return { kind, path, success: true, error: undefined };
  } catch (error) {
    return { kind, path, success: false, error: errorMessage(error) };
  }
};

const runWarmup = (
  options: ProjectUpdateOptions,
  kind: "main" | "worktree",
  mainCheckout: string,
  worktreePath: string,
): ProjectUpdateItem => {
  try {
    warmWorktree({
      mainCheckout,
      worktreePath,
      runner: options.runner,
      devenvTemplate: undefined,
      missingDevenvError: undefined,
    });
    options.syncReferences({
      projectRoot: mainCheckout,
      worktreePath,
      declaration: readProjectDeclaration(mainCheckout),
    });

    return { kind, path: worktreePath, success: true, error: undefined };
  } catch (error) {
    return { kind, path: worktreePath, success: false, error: errorMessage(error) };
  }
};

/**
 * Updates the agents input, then rebuilds and synchronizes a project's main
 * checkout and every linked Git worktree. A failed step is captured and does
 * not stop later worktrees from being attempted.
 *
 * @param options Project path, command runner, and reference sync seam.
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

  items.push(runWarmup(options, "main", mainCheckout, mainCheckout));

  let worktrees: readonly WorkspaceWorktree[];

  try {
    worktrees = listLinkedWorktrees(mainCheckout, options.runner);
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
    items.push(runWarmup(options, "worktree", mainCheckout, worktree.path));
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

const itemStatus = (item: ProjectUpdateItem): string => {
  if (item.success) return "succeeded";

  if (item.error === undefined) return "failed: unknown error";

  return `failed: ${item.error}`;
};

/**
 * Formats update output as logical records without separators.
 *
 * @param result Report returned by {@link runProjectUpdate}.
 * @returns Ordered report records, preserving embedded continuation lines.
 */
export const formatProjectUpdateRecords = (result: ProjectUpdateResult): readonly string[] => {
  const records = result.items.map(
    (item) => `${itemLabel(item.kind)} (${item.path}): ${itemStatus(item)}`,
  );

  const succeeded = result.items.filter((item) => item.success).length;
  const failed = result.items.length - succeeded;
  records.push(`Summary: ${succeeded} succeeded, ${failed} failed`);

  return records;
};

/**
 * Formats an update report for a human-readable CLI response.
 *
 * @param result Report returned by {@link runProjectUpdate}.
 * @returns One newline-terminated summary containing every step and failure.
 */
export const formatProjectUpdate = (result: ProjectUpdateResult): string =>
  `${formatProjectUpdateRecords(result).join("\n")}\n`;
