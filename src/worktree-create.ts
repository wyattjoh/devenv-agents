import { relative, resolve, sep } from "node:path";
import { runRequiredCommand, type CommandRunner } from "./command-runner.ts";
import { assertProjectPluginEnabled } from "./worktree-plugin.ts";
import {
  getWorktreeStatusPaths,
  readWorktreeStatus,
  type WorktreeStatus,
} from "./worktree-status.ts";
import { getManagedWorktreeRoot, resolveMainCheckout, worktreeLabel } from "./workspace.ts";

/**
 * The ids returned by Herdr after creating a workspace and its root pane.
 */
export type WorktreeCreateIds = {
  readonly workspaceId: string;
  readonly rootPaneId: string;
};

/**
 * The completed result of a managed worktree creation.
 */
export type WorktreeCreateResult = WorktreeCreateIds & {
  readonly branch: string;
  readonly worktreePath: string;
};

/**
 * Dependencies and options for one managed worktree creation.
 */
export type WorktreeCreateOptions = {
  readonly cwd: string;
  readonly branch: string;
  readonly base: string | undefined;
  readonly focus: boolean;
  readonly noFocus: boolean;
  readonly herdrPath: string | undefined;
  readonly runner: CommandRunner;
  /**
   * Optional wait seam used by deterministic tests. Production callers omit it
   * and use the unbounded blocking wait.
   */
  readonly sleep: (() => void) | undefined;
};

type JsonRecord = Record<string, unknown>;

type ParsedCreateResponse = WorktreeCreateIds;

const herdrCommand = (herdrPath: string | undefined): string => herdrPath ?? "herdr";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const readRecord = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const readString = (record: JsonRecord | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const defaultSleep = (): void => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, 50);
};

const parseCreateResponse = (stdout: string): ParsedCreateResponse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error("herdr worktree create returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("herdr worktree create returned an invalid envelope");

  const result = readRecord(parsed, "result");
  const workspaceId = readString(readRecord(result ?? {}, "workspace"), "workspace_id");
  const rootPaneId = readString(readRecord(result ?? {}, "root_pane"), "pane_id");
  if (workspaceId === undefined || rootPaneId === undefined) {
    throw new Error(
      "herdr worktree create response is missing result.workspace.workspace_id or result.root_pane.pane_id",
    );
  }
  return { workspaceId, rootPaneId };
};

const worktreePathForBranch = (mainCheckout: string, branch: string): string => {
  if (branch.length === 0) throw new Error("worktree branch is required");
  const root = getManagedWorktreeRoot(mainCheckout);
  const path = resolve(root, branch);
  const relativePath = relative(root, path);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("worktree branch must stay under .claude/worktrees");
  }
  return path;
};

const worktreeCreateArgs = (
  mainCheckout: string,
  branch: string,
  worktreePath: string,
  base: string | undefined,
  focus: boolean,
  noFocus: boolean,
): readonly string[] => [
  "worktree",
  "create",
  "--cwd",
  mainCheckout,
  "--branch",
  branch,
  ...(base === undefined ? [] : ["--base", base]),
  "--path",
  worktreePath,
  "--label",
  worktreeLabel(branch),
  ...(noFocus ? ["--no-focus"] : focus ? ["--focus"] : []),
];

/**
 * Waits until the shared status record reaches a terminal state.
 *
 * There is intentionally no timeout: a successful Herdr command is not
 * complete until the plugin has recorded either `done` or `failed`.
 *
 * @param statusPath Shared worktree status file to observe.
 * @param sleep Wait operation between reads, or the production blocking wait.
 * @returns The terminal status record.
 */
export const waitForWorktreeStatus = (
  statusPath: string,
  sleep: (() => void) | undefined = undefined,
): Exclude<WorktreeStatus, { state: "running" }> => {
  for (;;) {
    const status = readWorktreeStatus(statusPath);
    if (status?.state === "done" || status?.state === "failed") return status;
    (sleep ?? defaultSleep)();
  }
};

/**
 * Creates a Herdr worktree and waits for its plugin bootstrap to finish.
 *
 * @param options Creation arguments, project cwd, and injected Herdr runner.
 * @returns The workspace and root-pane ids after a successful bootstrap.
 */
export const runWorktreeCreate = (options: WorktreeCreateOptions): WorktreeCreateResult => {
  assertProjectPluginEnabled({ herdrPath: options.herdrPath, runner: options.runner });
  const mainCheckout = resolveMainCheckout(options.cwd, options.runner);
  const worktreePath = worktreePathForBranch(mainCheckout, options.branch);
  const create = runRequiredCommand(
    options.runner,
    "herdr worktree create",
    herdrCommand(options.herdrPath),
    worktreeCreateArgs(
      mainCheckout,
      options.branch,
      worktreePath,
      options.base,
      options.focus,
      options.noFocus,
    ),
    { cwd: mainCheckout, env: undefined },
  );

  const ids = parseCreateResponse(create.stdout);
  const statusPath = getWorktreeStatusPaths(mainCheckout, worktreePath).statusPath;
  const status = waitForWorktreeStatus(statusPath, options.sleep);
  if (status.state === "failed") throw new Error(status.error);
  return { ...ids, branch: options.branch, worktreePath };
};
