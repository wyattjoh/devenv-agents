import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCommand, type CommandResult, type CommandRunner } from "./command-runner.ts";
import { PROJECT_DECLARATION_PATH } from "./project-declaration.ts";
import { resolveMainCheckout } from "./worktree-setup.ts";
import { claimWorktreeStatus } from "./worktree-status.ts";

/**
 * The Herdr plugin identifier owned by this repository.
 */
export const PROJECT_PLUGIN_ID = "wyattjoh.project-worktrees";

/**
 * The manifest file expected at the root of a Herdr plugin directory.
 */
export const PROJECT_PLUGIN_MANIFEST = "herdr-plugin.toml";

/**
 * Environment variables accepted as an override for the packaged plugin path.
 */
export const PROJECT_PLUGIN_PATH_ENV = "DEVENV_AGENTS_PLUGIN_PATH";

/**
 * A read-only environment snapshot used by plugin commands.
 */
export type PluginEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies for one Herdr worktree lifecycle event.
 */
export type WorktreeEventOptions = {
  readonly eventJson: string | undefined;
  readonly workspaceId: string | undefined;
  readonly herdrPath: string | undefined;
  readonly runner: CommandRunner;
  readonly now: (() => string) | undefined;
};

/**
 * The observable result of a worktree lifecycle event.
 */
export type WorktreeEventResult = {
  readonly exitCode: number;
  readonly worktreePath: string | undefined;
  readonly mainCheckout: string | undefined;
  readonly claimed: boolean;
  readonly opened: boolean;
  readonly error: string | undefined;
};

/**
 * Dependencies for linking the packaged Herdr plugin.
 */
export type PluginInstallOptions = {
  readonly pluginPath: string;
  readonly herdrPath: string | undefined;
  readonly runner: CommandRunner;
};

/**
 * The action taken while installing or refreshing the plugin.
 */
export type PluginInstallAction = "linked" | "relinked" | "enabled" | "unchanged";

/**
 * The observable result of a plugin installation.
 */
export type PluginInstallResult = {
  readonly exitCode: number;
  readonly action: PluginInstallAction;
  readonly pluginPath: string;
};

type JsonRecord = Record<string, unknown>;

type PluginManifest = {
  readonly id: string;
  readonly version: string;
};

type ListedPlugin = {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly pluginRoot: string | undefined;
  readonly manifestPath: string | undefined;
  readonly version: string | undefined;
};

const defaultNow = (): string => new Date().toISOString();

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const readString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const readRecord = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const parseEventPayload = (eventJson: string | undefined): JsonRecord | undefined => {
  if (eventJson === undefined || eventJson.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(eventJson) as unknown;
    if (!isRecord(parsed)) return undefined;
    const data = readRecord(parsed, "data");
    return data ?? parsed;
  } catch {
    return undefined;
  }
};

const pathFromEventPayload = (payload: JsonRecord | undefined): string | undefined => {
  const worktree = payload === undefined ? undefined : readRecord(payload, "worktree");
  const workspace = payload === undefined ? undefined : readRecord(payload, "workspace");
  const workspaceWorktree = workspace === undefined ? undefined : readRecord(workspace, "worktree");
  const candidates = [
    worktree === undefined ? undefined : readString(worktree, "path"),
    worktree === undefined ? undefined : readString(worktree, "checkout_path"),
    workspaceWorktree === undefined ? undefined : readString(workspaceWorktree, "path"),
    workspaceWorktree === undefined ? undefined : readString(workspaceWorktree, "checkout_path"),
  ];
  return candidates.find((candidate): candidate is string => candidate !== undefined);
};

const workspaceIdFromPayload = (payload: JsonRecord | undefined): string | undefined => {
  if (payload === undefined) return undefined;
  const workspace = readRecord(payload, "workspace");
  const candidates = [
    workspace === undefined ? undefined : readString(workspace, "workspace_id"),
    workspace === undefined ? undefined : readString(workspace, "id"),
    readString(payload, "workspace_id"),
    readString(payload, "workspaceId"),
  ];
  return candidates.find((candidate): candidate is string => candidate !== undefined);
};

const commandFailure = (label: string, result: CommandResult): Error => {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return new Error(`${label} failed with exit code ${result.exitCode}: ${detail}`);
};

const herdrCommand = (herdrPath: string | undefined): string => herdrPath ?? "herdr";

const canonicalDirectory = (path: string): string | undefined => {
  try {
    const canonical = realpathSync(resolve(path));
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
};

const hasProjectDeclaration = (mainCheckout: string): boolean => {
  try {
    return statSync(join(mainCheckout, PROJECT_DECLARATION_PATH)).isFile();
  } catch {
    return false;
  }
};

const worktreesFromResponse = (stdout: string): readonly JsonRecord[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error("herdr worktree list returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("herdr worktree list returned an invalid envelope");
  const result = readRecord(parsed, "result");
  const worktrees = result?.worktrees;
  if (!Array.isArray(worktrees)) throw new Error("herdr worktree list returned no worktrees");
  return worktrees.filter(isRecord);
};

const pathFromWorkspace = (
  workspaceId: string,
  options: WorktreeEventOptions,
): string | undefined => {
  let response: CommandResult;
  try {
    response = runCommand(options.runner, herdrCommand(options.herdrPath), [
      "worktree",
      "list",
      "--workspace",
      workspaceId,
    ]);
  } catch {
    return undefined;
  }
  if (response.exitCode !== 0) return undefined;

  let worktrees: readonly JsonRecord[];
  try {
    worktrees = worktreesFromResponse(response.stdout);
  } catch {
    return undefined;
  }
  const worktree = worktrees.find(
    (candidate) =>
      candidate.open_workspace_id === workspaceId && candidate.is_linked_worktree === true,
  );
  return worktree === undefined ? undefined : readString(worktree, "path");
};

const resolveEventWorktreePath = (options: WorktreeEventOptions): string | undefined => {
  const payload = parseEventPayload(options.eventJson);
  const direct = pathFromEventPayload(payload);
  if (direct !== undefined) return canonicalDirectory(direct);

  const workspaceId = workspaceIdFromPayload(payload) ?? options.workspaceId;
  if (workspaceId === undefined || workspaceId.length === 0) return undefined;
  const listedPath = pathFromWorkspace(workspaceId, options);
  return listedPath === undefined ? undefined : canonicalDirectory(listedPath);
};

const skippedEvent = (
  worktreePath: string | undefined,
  mainCheckout: string | undefined,
  error: string | undefined = undefined,
): WorktreeEventResult => ({
  exitCode: 0,
  worktreePath,
  mainCheckout,
  claimed: false,
  opened: false,
  error,
});

/**
 * Resolves the canonical worktree path carried by an event or workspace id.
 *
 * Direct worktree paths take precedence. Workspace fallback results are limited
 * to linked worktrees whose open workspace id exactly matches the event.
 *
 * @param options Event payload, Herdr runner, and workspace context.
 * @returns A canonical worktree directory, or undefined for an unrelated event.
 */
export const resolveWorktreeEventPath = (options: WorktreeEventOptions): string | undefined =>
  resolveEventWorktreePath(options);

/**
 * Handles one Herdr worktree lifecycle event.
 *
 * The hook is deliberately fail-open: unrelated events, malformed payloads,
 * unavailable sockets, and overlay launch failures return exit code zero. A
 * status claim is handed to the setup pane through an atomic marker rename, so
 * the setup process can acquire the same claim while duplicate events no-op.
 *
 * @param options Event payload, Herdr runner, and clock dependencies.
 * @returns The observable event result without terminating the caller.
 */
export const runWorktreeEvent = (options: WorktreeEventOptions): WorktreeEventResult => {
  const worktreePath = resolveEventWorktreePath(options);
  if (worktreePath === undefined) return skippedEvent(undefined, undefined);

  let mainCheckout: string;
  try {
    mainCheckout = resolveMainCheckout(worktreePath, options.runner);
  } catch {
    return skippedEvent(worktreePath, undefined);
  }
  if (!hasProjectDeclaration(mainCheckout)) return skippedEvent(worktreePath, mainCheckout);

  let claim: ReturnType<typeof claimWorktreeStatus> = undefined;
  try {
    claim = claimWorktreeStatus(mainCheckout, worktreePath, options.now);
    if (claim === undefined) return skippedEvent(worktreePath, mainCheckout);

    claim.write("running", undefined, undefined);
    claim.handoff();
    const openResult = runCommand(options.runner, herdrCommand(options.herdrPath), [
      "plugin",
      "pane",
      "open",
      "--plugin",
      PROJECT_PLUGIN_ID,
      "--entrypoint",
      "setup",
      "--placement",
      "overlay",
      "--cwd",
      worktreePath,
      "--no-focus",
    ]);
    if (openResult.exitCode !== 0) throw commandFailure("herdr plugin pane open", openResult);

    return {
      exitCode: 0,
      worktreePath,
      mainCheckout,
      claimed: true,
      opened: true,
      error: undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let ownsClaim = false;
    try {
      ownsClaim = claim?.cancelHandoff() ?? false;
    } catch {
      // The event hook remains fail-open if claim cleanup itself fails.
    }
    if (ownsClaim && claim !== undefined) {
      try {
        claim.write("failed", message, (options.now ?? defaultNow)());
      } catch {
        // The event hook remains fail-open if status persistence itself fails.
      }
    }
    return {
      exitCode: 0,
      worktreePath,
      mainCheckout,
      claimed: claim !== undefined,
      opened: false,
      error: message,
    };
  }
};

const manifestRoot = (pluginPath: string): string => {
  const resolved = resolve(pluginPath);
  return existsSync(join(resolved, PROJECT_PLUGIN_MANIFEST)) ? resolved : dirname(resolved);
};

const readPluginManifest = (
  pluginPath: string,
): { readonly root: string; readonly manifest: PluginManifest } => {
  const root = manifestRoot(pluginPath);
  const manifestPath = join(root, PROJECT_PLUGIN_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`Herdr plugin manifest not found: ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse Herdr plugin manifest ${manifestPath}: ${message}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error("Herdr plugin manifest must be a TOML table");
  const id = readString(parsed, "id");
  const version = readString(parsed, "version");
  if (id !== PROJECT_PLUGIN_ID) {
    throw new Error(`Herdr plugin manifest id must be ${PROJECT_PLUGIN_ID}`);
  }
  if (version === undefined || version.length === 0) {
    throw new Error("Herdr plugin manifest requires a version");
  }
  return { root: realpathSync(root), manifest: { id, version } };
};

const pluginEntriesFromResponse = (stdout: string): readonly ListedPlugin[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error("herdr plugin list returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("herdr plugin list returned an invalid envelope");
  const result = readRecord(parsed, "result");
  const plugins = result?.plugins;
  if (!Array.isArray(plugins)) throw new Error("herdr plugin list returned no plugins");
  return plugins.flatMap((value) => {
    if (!isRecord(value)) return [];
    const pluginId = readString(value, "plugin_id");
    if (pluginId === undefined) return [];
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

const comparablePluginRoot = (plugin: ListedPlugin): string | undefined => {
  const path = plugin.pluginRoot ?? plugin.manifestPath;
  if (path === undefined) return undefined;
  try {
    const canonical = realpathSync(path);
    return canonical.endsWith(`/${PROJECT_PLUGIN_MANIFEST}`) ? dirname(canonical) : canonical;
  } catch {
    const resolved = resolve(path);
    return resolved.endsWith(`/${PROJECT_PLUGIN_MANIFEST}`) ? dirname(resolved) : resolved;
  }
};

const runRequiredHerdr = (
  options: PluginInstallOptions,
  args: readonly string[],
  label: string,
): void => {
  const result = runCommand(options.runner, herdrCommand(options.herdrPath), args);
  if (result.exitCode !== 0) throw commandFailure(label, result);
};

/**
 * Links or refreshes this repository's Herdr plugin for the current user.
 *
 * The installed plugin is compared by canonical local root, manifest version,
 * and enabled state. A matching enabled entry is a no-op. A changed entry is
 * unlinked and linked again; Herdr 0.9.0 reloads a changed local manifest using
 * exactly that sequence, so no server restart is needed.
 *
 * @param options Plugin root and injected Herdr command dependencies.
 * @returns The action taken and canonical plugin root.
 */
export const runPluginInstall = (options: PluginInstallOptions): PluginInstallResult => {
  const { root, manifest } = readPluginManifest(options.pluginPath);
  const list = runCommand(options.runner, herdrCommand(options.herdrPath), [
    "plugin",
    "list",
    "--json",
  ]);
  if (list.exitCode !== 0) throw commandFailure("herdr plugin list", list);

  const existing = pluginEntriesFromResponse(list.stdout).find(
    (plugin) => plugin.pluginId === manifest.id,
  );
  if (existing === undefined) {
    runRequiredHerdr(options, ["plugin", "link", root, "--enabled"], "herdr plugin link");
    return { exitCode: 0, action: "linked", pluginPath: root };
  }

  if (
    comparablePluginRoot(existing) === root &&
    existing.version === manifest.version &&
    existing.enabled
  ) {
    return { exitCode: 0, action: "unchanged", pluginPath: root };
  }

  if (comparablePluginRoot(existing) === root && existing.version === manifest.version) {
    runRequiredHerdr(options, ["plugin", "enable", manifest.id], "herdr plugin enable");
    return { exitCode: 0, action: "enabled", pluginPath: root };
  }

  runRequiredHerdr(options, ["plugin", "unlink", manifest.id], "herdr plugin unlink");
  runRequiredHerdr(options, ["plugin", "link", root, "--enabled"], "herdr plugin link");
  return { exitCode: 0, action: "relinked", pluginPath: root };
};

const pluginPathCandidates = (
  pluginPath: string | undefined,
  environment: PluginEnvironment,
): readonly string[] => {
  const configured =
    pluginPath ?? environment[PROJECT_PLUGIN_PATH_ENV] ?? environment.PROJECT_PLUGIN_PATH;
  if (configured !== undefined) return [configured];

  return [
    join(resolve(environment.PWD ?? process.cwd()), "plugin"),
    resolve(import.meta.dir, "..", "plugin"),
  ];
};

/**
 * Resolves the plugin directory packaged with the CLI or checked out locally.
 *
 * @param pluginPath Explicit plugin root, if supplied.
 * @param environment Environment used for optional path overrides.
 * @returns The first candidate containing a plugin manifest, or the first candidate.
 */
export const resolvePluginPath = (
  pluginPath: string | undefined,
  environment: PluginEnvironment = process.env,
): string => {
  const candidates = pluginPathCandidates(pluginPath, environment);
  return (
    candidates.find((candidate) => existsSync(join(candidate, PROJECT_PLUGIN_MANIFEST))) ??
    candidates[0] ??
    resolve(import.meta.dir, "..", "plugin")
  );
};
