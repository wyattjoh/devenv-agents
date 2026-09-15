import { runCommand, runRequiredCommand, type CommandRunner } from "./command-runner.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type JsonRecord = { readonly [key: string]: JsonValue };

/**
 * A worktree reported by Herdr, with protocol names normalized for callers.
 */
export type HerdrWorktree = {
  /** The checkout path reported by Herdr. */
  readonly path: string;
  /** The branch name without a `refs/heads/` prefix, when attached. */
  readonly branch: string | undefined;
  /** Whether Herdr explicitly reports this checkout as a linked worktree. */
  readonly linked: boolean;
  /** The open workspace id, when this checkout has a workspace. */
  readonly openWorkspaceId: string | undefined;
  /** Whether Herdr reports this worktree registration as prunable. */
  readonly prunable: boolean;
};

/**
 * Optional scope for a Herdr worktree-list request.
 */
type HerdrWorktreeListOptions = {
  /** Working directory for the Herdr command. */
  readonly cwd: string | undefined;
  /** Restrict the list to one workspace, when supplied. */
  readonly workspaceId: string | undefined;
};

/**
 * The mutually exclusive focus modes accepted by Herdr worktree creation.
 */
type HerdrWorktreeFocus = "focus" | "no-focus" | undefined;

/**
 * Arguments for creating a Herdr-managed worktree.
 */
type HerdrWorktreeCreateOptions = {
  /** Main checkout passed to Herdr as the command working directory. */
  readonly cwd: string;
  /** Branch name to create. */
  readonly branch: string;
  /** Base revision, when the caller supplied one. */
  readonly base: string | undefined;
  /** Checkout path to create. */
  readonly path: string;
  /** Workspace label shown by Herdr. */
  readonly label: string;
  /** Focus mode for the created workspace. */
  readonly focus: HerdrWorktreeFocus;
};

/**
 * Identifiers returned by Herdr after creating a worktree.
 */
type HerdrWorktreeCreateResult = {
  /** The created workspace identifier. */
  readonly workspaceId: string;
  /** The created workspace's root pane identifier. */
  readonly rootPaneId: string;
};

/**
 * Arguments for opening an existing Herdr-managed worktree.
 */
type HerdrWorktreeOpenOptions = {
  /** Main checkout passed to Herdr as the command working directory. */
  readonly cwd: string;
  /** Checkout path to open. */
  readonly path: string;
  /** Workspace label shown by Herdr. */
  readonly label: string;
};

/**
 * Arguments for opening a Herdr plugin pane.
 */
type HerdrPluginPaneOpenOptions = {
  /** Plugin identifier owning the entrypoint. */
  readonly pluginId: string;
  /** Plugin entrypoint to open. */
  readonly entrypoint: string;
  /** Herdr pane placement. */
  readonly placement: string;
  /** Working directory passed to the plugin pane. */
  readonly cwd: string;
};

/**
 * A plugin reported by Herdr's plugin registry.
 */
export type HerdrPlugin = {
  /** The stable plugin identifier. */
  readonly pluginId: string;
  /** Whether Herdr has enabled the plugin. */
  readonly enabled: boolean;
  /** The local plugin root, when Herdr reports one. */
  readonly pluginRoot: string | undefined;
  /** The local manifest path, when Herdr reports one. */
  readonly manifestPath: string | undefined;
  /** The installed plugin version, when Herdr reports one. */
  readonly version: string | undefined;
};

/**
 * A pane reported by Herdr, reduced to the fields needed by lifecycle calls.
 */
export type HerdrPane = {
  /** The stable pane identifier used by pane commands. */
  readonly paneId: string;
  /** The pane's launch working directory, when Herdr reports one. */
  readonly cwd: string | undefined;
};

/**
 * The typed seam for Herdr operations used by project lifecycle modules.
 */
export interface HerdrClient {
  /**
   * Lists Herdr worktree registrations.
   *
   * @param options Command working directory and optional workspace filter.
   * @returns Normalized worktree registrations.
   */
  listWorktrees(options: HerdrWorktreeListOptions | undefined): readonly HerdrWorktree[];
  /**
   * Resolves an event workspace to its explicitly linked worktree.
   *
   * Herdr availability and response validity are optional for event handling,
   * so this lookup fails open and returns undefined on any failure.
   *
   * @param workspaceId Workspace identifier carried by the event.
   * @returns The matching linked worktree, or undefined when it cannot be resolved.
   */
  resolveWorktree(workspaceId: string): HerdrWorktree | undefined;
  /**
   * Creates a Herdr-managed worktree.
   *
   * @param options Worktree creation arguments and focus behavior.
   * @returns The created workspace and root-pane identifiers.
   */
  createWorktree(options: HerdrWorktreeCreateOptions): HerdrWorktreeCreateResult;
  /**
   * Opens an existing worktree without focusing it.
   *
   * @param options Worktree checkout and label arguments.
   * @returns Nothing after Herdr accepts the request.
   */
  openWorktree(options: HerdrWorktreeOpenOptions): void;
  /**
   * Closes a Herdr workspace.
   *
   * @param workspaceId Workspace identifier to close.
   * @param cwd Working directory for Herdr, or undefined to inherit.
   * @returns Nothing after Herdr accepts the request.
   */
  closeWorkspace(workspaceId: string, cwd: string | undefined): void;
  /**
   * Opens a plugin entrypoint in a non-focused overlay pane.
   *
   * @param options Plugin pane placement and working-directory arguments.
   * @returns Nothing after Herdr accepts the request.
   */
  openPluginPane(options: HerdrPluginPaneOpenOptions): void;
  /**
   * Sends key input to a pane.
   *
   * @param paneId Pane identifier receiving the keys.
   * @param keys Herdr key sequence to send.
   * @returns Nothing after Herdr accepts the request.
   */
  sendKeys(paneId: string, keys: string): void;
  /**
   * Lists installed Herdr plugins.
   *
   * @returns Normalized plugin registry entries.
   */
  listPlugins(): readonly HerdrPlugin[];
  /**
   * Links a local plugin and enables it immediately.
   *
   * @param pluginRoot Local plugin directory to link.
   * @returns Nothing after Herdr accepts the request.
   */
  linkPlugin(pluginRoot: string): void;
  /**
   * Enables an already-linked plugin.
   *
   * @param pluginId Plugin identifier to enable.
   * @returns Nothing after Herdr accepts the request.
   */
  enablePlugin(pluginId: string): void;
  /**
   * Unlinks a plugin from Herdr's registry.
   *
   * This companion operation is needed when refreshing a changed local plugin.
   *
   * @param pluginId Plugin identifier to unlink.
   * @returns Nothing after Herdr accepts the request.
   */
  unlinkPlugin(pluginId: string): void;
  /**
   * Lists panes, failing open because pane discovery is optional wake-up work.
   *
   * @returns Normalized panes, or an empty list when Herdr is unavailable.
   */
  listPanes(): readonly HerdrPane[];
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && !Array.isArray(value) && value === Object(value);

const isString = (value: unknown): value is string => value === String(value);

const readString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];

  return isString(value) ? value : undefined;
};

const readRecord = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];

  return isRecord(value) ? value : undefined;
};

const normalizeBranch = (branch: string | undefined): string | undefined => {
  if (branch === undefined) return undefined;

  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
};

const parseEnvelopeResult = (stdout: string, operation: string): JsonRecord => {
  let parsed: unknown;

  try {
    // SAFETY: The JSON result is validated as a protocol envelope below.
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }

  if (!isRecord(parsed)) throw new Error(`${operation} returned an invalid envelope`);
  const result = readRecord(parsed, "result");

  if (result === undefined) throw new Error(`${operation} returned no results`);

  return result;
};

const parseWorktrees = (stdout: string): readonly HerdrWorktree[] => {
  const operation = "herdr worktree list";
  const result = parseEnvelopeResult(stdout, operation);
  const worktrees = result.worktrees;

  if (!Array.isArray(worktrees)) throw new Error(`${operation} returned no results`);

  return worktrees.flatMap((value) => {
    if (!isRecord(value)) return [];
    const path = readString(value, "path");

    if (path === undefined || path.length === 0) return [];

    return [
      {
        path,
        branch: normalizeBranch(readString(value, "branch")),
        linked: value.is_linked_worktree === true,
        openWorkspaceId: readString(value, "open_workspace_id"),
        prunable: value.is_prunable === true,
      },
    ];
  });
};

const parseCreateWorktree = (stdout: string): HerdrWorktreeCreateResult => {
  const operation = "herdr worktree create";
  const result = parseEnvelopeResult(stdout, operation);
  const workspaceId = readString(readRecord(result, "workspace") ?? {}, "workspace_id");
  const rootPaneId = readString(readRecord(result, "root_pane") ?? {}, "pane_id");

  if (
    workspaceId === undefined ||
    workspaceId.length === 0 ||
    rootPaneId === undefined ||
    rootPaneId.length === 0
  ) {
    throw new Error(`${operation} returned no results`);
  }

  return { workspaceId, rootPaneId };
};

const parsePlugins = (stdout: string): readonly HerdrPlugin[] => {
  const operation = "herdr plugin list";
  const result = parseEnvelopeResult(stdout, operation);
  const plugins = result.plugins;

  if (!Array.isArray(plugins)) throw new Error(`${operation} returned no results`);

  return plugins.flatMap((value) => {
    if (!isRecord(value)) return [];
    const pluginId = readString(value, "plugin_id");

    if (pluginId === undefined || pluginId.length === 0) return [];

    return [
      {
        pluginId,
        enabled: value.enabled === true,
        pluginRoot: readString(value, "plugin_root"),
        manifestPath: readString(value, "manifest_path"),
        version: readString(value, "version"),
      },
    ];
  });
};

const parsePanes = (stdout: string): readonly HerdrPane[] => {
  const operation = "herdr pane list";
  const result = parseEnvelopeResult(stdout, operation);
  const panes = result.panes;

  if (!Array.isArray(panes)) throw new Error(`${operation} returned no results`);

  return panes.flatMap((value) => {
    if (!isRecord(value)) return [];
    const paneId = readString(value, "pane_id");

    if (paneId === undefined || paneId.length === 0) return [];

    return [{ paneId, cwd: readString(value, "cwd") }];
  });
};

/**
 * Constructs the runner-backed Herdr adapter.
 *
 * The adapter is the centralized production home for Herdr's executable path,
 * command arguments, JSON envelope, and response-field names. Callers using
 * the adapter receive normalized values and never need to parse Herdr output
 * themselves.
 *
 * @param runner Injected command runner used to invoke Herdr.
 * @param herdrPath Herdr executable or absolute path, defaulting to `herdr`.
 * @returns A typed Herdr client backed by the supplied runner.
 */
export const createHerdrClient = (
  runner: CommandRunner,
  herdrPath: string | undefined = undefined,
): HerdrClient => {
  const command = herdrPath ?? "herdr";

  const listWorktrees = (
    options: HerdrWorktreeListOptions = { cwd: undefined, workspaceId: undefined },
  ): readonly HerdrWorktree[] => {
    const result = runRequiredCommand(
      runner,
      "herdr worktree list",
      command,
      [
        "worktree",
        "list",
        ...(options.workspaceId === undefined ? [] : ["--workspace", options.workspaceId]),
      ],
      { cwd: options.cwd, env: undefined },
    );

    return parseWorktrees(result.stdout);
  };

  return {
    listWorktrees,
    resolveWorktree: (workspaceId) => {
      try {
        return listWorktrees({ cwd: undefined, workspaceId }).find(
          (worktree) => worktree.openWorkspaceId === workspaceId && worktree.linked,
        );
      } catch {
        return undefined;
      }
    },
    createWorktree: (options) => {
      const result = runRequiredCommand(
        runner,
        "herdr worktree create",
        command,
        [
          "worktree",
          "create",
          "--cwd",
          options.cwd,
          "--branch",
          options.branch,
          ...(options.base === undefined ? [] : ["--base", options.base]),
          "--path",
          options.path,
          "--label",
          options.label,
          ...(options.focus === undefined ? [] : [`--${options.focus}`]),
        ],
        { cwd: options.cwd, env: undefined },
      );

      return parseCreateWorktree(result.stdout);
    },
    openWorktree: (options) => {
      runRequiredCommand(
        runner,
        "herdr worktree open",
        command,
        [
          "worktree",
          "open",
          "--cwd",
          options.cwd,
          "--path",
          options.path,
          "--label",
          options.label,
          "--no-focus",
        ],
        { cwd: options.cwd, env: undefined },
      );
    },
    closeWorkspace: (workspaceId, cwd = undefined) => {
      runRequiredCommand(
        runner,
        "herdr workspace close",
        command,
        ["workspace", "close", workspaceId],
        { cwd, env: undefined },
      );
    },
    openPluginPane: (options) => {
      runRequiredCommand(runner, "herdr plugin pane open", command, [
        "plugin",
        "pane",
        "open",
        "--plugin",
        options.pluginId,
        "--entrypoint",
        options.entrypoint,
        "--placement",
        options.placement,
        "--cwd",
        options.cwd,
        "--no-focus",
      ]);
    },
    sendKeys: (paneId, keys) => {
      runRequiredCommand(runner, "herdr pane send-keys", command, [
        "pane",
        "send-keys",
        paneId,
        keys,
      ]);
    },
    listPlugins: () => {
      const result = runRequiredCommand(runner, "herdr plugin list", command, [
        "plugin",
        "list",
        "--json",
      ]);

      return parsePlugins(result.stdout);
    },
    linkPlugin: (pluginRoot) => {
      runRequiredCommand(runner, "herdr plugin link", command, [
        "plugin",
        "link",
        pluginRoot,
        "--enabled",
      ]);
    },
    enablePlugin: (pluginId) => {
      runRequiredCommand(runner, "herdr plugin enable", command, ["plugin", "enable", pluginId]);
    },
    unlinkPlugin: (pluginId) => {
      runRequiredCommand(runner, "herdr plugin unlink", command, ["plugin", "unlink", pluginId]);
    },
    listPanes: () => {
      try {
        const result = runCommand(runner, command, ["pane", "list"]);

        if (result.exitCode !== 0) return [];

        return parsePanes(result.stdout);
      } catch {
        return [];
      }
    },
  };
};
