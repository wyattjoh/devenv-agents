#!/usr/bin/env bun

import { defaultCommandRunner, errorMessage, type CommandRunner } from "./command-runner.ts";
import { createHerdrClient, type HerdrClient } from "./herdr-client.ts";
import {
  defaultProjectRoots,
  enumerateProjects,
  runProjectAdd,
  type ProjectAddResult,
  type ProjectPlatform,
} from "./project-add.ts";
import {
  formatProjectUpdate,
  formatProjectUpdateRecords,
  runProjectUpdate,
  type ProjectUpdateResult,
} from "./project-update.ts";
import {
  formatAdoptWorktrees,
  formatAdoptWorktreesRecords,
  formatProjectGc,
  formatProjectGcRecords,
  runAdoptWorktrees,
  runProjectGc,
  type AdoptWorktreesResult,
  type ProjectGcResult,
} from "./project-gc.ts";
import {
  createWorktreeBootstrap,
  type WorktreeBootstrap,
  type WorktreeBootstrapResult,
} from "./worktree-bootstrap.ts";
import { runWorktreeCreate, type WorktreeCreateResult } from "./worktree-create.ts";
import {
  PROJECT_PLUGIN_ID,
  resolvePluginPath,
  runPluginInstall,
  runWorktreeEvent,
  type PluginEnvironment,
  type PluginInstallResult,
  type WorktreeEventResult,
} from "./worktree-plugin.ts";
import { createSyncReferences, runProjectSync, type SyncReferences } from "./project-sync.ts";

/**
 * The public command name used by the standalone binary and the Bun entrypoint.
 */
const PROJECT_NAME = "project";

/**
 * The initial version of the project CLI.
 */
const PROJECT_VERSION = "0.1.0";

/**
 * The output channels used by the CLI, kept injectable so command behavior can
 * be tested without replacing the process streams.
 */
type CliIO = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/**
 * Host values resolved from the CLI environment before dispatching a command.
 */
type HostConfiguration = {
  readonly platform: ProjectPlatform;
  readonly homeDirectory: string;
  readonly projectsFile: string | undefined;
  readonly systemdUserDirectory: string | undefined;
  readonly codeRoot: string | undefined;
  readonly templateRoot: string;
  readonly host: string;
  readonly user: string;
  readonly herdrBinPath: string | undefined;
  readonly eventJson: string | undefined;
  readonly workspaceId: string | undefined;
};

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Runtime seams used by commands without replacing the process itself.
 */
type CliDependencies = {
  readonly cwd: string | undefined;
  readonly now: () => string;
  readonly readLine: (message?: string) => string;
  readonly runner: CommandRunner;
  readonly herdrClient: HerdrClient;
  readonly syncReferences: SyncReferences;
  readonly bootstrap: WorktreeBootstrap;
  /**
   * Project registry seam used by --all, or undefined to use the real enumerator.
   */
  readonly enumerateProjects: typeof enumerateProjects | undefined;
  /**
   * Environment snapshot used to resolve host settings, or undefined for process.env.
   */
  readonly environment: PluginEnvironment | undefined;
  /**
   * Override for the plugin root used by plugin install, or undefined to resolve it.
   */
  readonly pluginPath: string | undefined;
};

const BRANCH_PROMPT = "Branch name: ";

const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;

const defaultNow = (): string => new Date().toISOString();

const worktreeBootstrapDeadline = (now: () => string): number => {
  const current = Date.parse(now());

  if (Number.isNaN(current)) throw new Error("Invalid bootstrap clock value");

  return current + WORKTREE_BOOTSTRAP_TIMEOUT_MS;
};

const interactiveLine = (message = "Press Enter to retry or q to quit: "): string => {
  const promptFunction =
    // SAFETY: The asserted value is constrained by the surrounding validation or fixture.
    (
      globalThis as typeof globalThis & {
        prompt?: (message?: string) => string | null;
      }
    ).prompt;

  return promptFunction?.(message) ?? (message === BRANCH_PROMPT ? "" : "q");
};

const platformFrom = (platform: string | undefined): ProjectPlatform => {
  if (platform === "linux" || platform === "darwin") return platform;

  if (platform !== undefined) {
    throw new Error(`PROJECT_PLATFORM must be either linux or darwin, got '${platform}'`);
  }

  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new Error(`Unsupported host platform '${process.platform}'`);
};

/**
 * Resolves the process environment into the values needed by CLI commands.
 *
 * Platform validation and all CLI environment fallbacks live here so commands
 * receive one stable host record instead of consulting process-global state.
 *
 * @param environment Environment snapshot used for resolution.
 * @returns The typed host configuration for one CLI invocation.
 * @throws When the configured or running host platform is unsupported.
 */
const resolveHostConfiguration = (
  environment: PluginEnvironment = process.env,
): HostConfiguration => {
  const roots = defaultProjectRoots();

  return {
    platform: platformFrom(environment.PROJECT_PLATFORM),
    homeDirectory: environment.PROJECT_HOME ?? environment.HOME ?? roots.homeDirectory,
    projectsFile: environment.PROJECT_PROJECTS_FILE,
    systemdUserDirectory: environment.PROJECT_SYSTEMD_USER_DIRECTORY,
    codeRoot: environment.PROJECT_CODE_ROOT,
    templateRoot: environment.PROJECT_TEMPLATE_ROOT ?? roots.templateRoot,
    host: environment.PROJECT_HOST ?? "strix",
    user: environment.USER ?? environment.USERNAME ?? "user",
    herdrBinPath: environment.HERDR_BIN_PATH,
    eventJson: environment.HERDR_PLUGIN_EVENT_JSON,
    workspaceId: environment.HERDR_WORKSPACE_ID,
  };
};

const createDefaultDependencies = (
  hostConfiguration: HostConfiguration,
  environment: PluginEnvironment,
  runner: CommandRunner,
): CliDependencies => {
  const now = defaultNow;
  const herdrClient = createHerdrClient(runner, hostConfiguration.herdrBinPath);
  const syncReferences = createSyncReferences({ runner });

  return {
    cwd: undefined,
    now,
    readLine: interactiveLine,
    runner,
    herdrClient,
    syncReferences,
    bootstrap: createWorktreeBootstrap({
      herdrClient,
      now,
      runner,
      syncReferences,
    }),
    enumerateProjects: undefined,
    environment,
    pluginPath: undefined,
  };
};

const isHelpFlag = (argument: string): boolean => argument === "--help" || argument === "-h";

const isVersionFlag = (argument: string): boolean => argument === "--version" || argument === "-v";

const printUnknown = (output: CliIO, argument: string): number => {
  output.stderr(`${PROJECT_NAME}: unknown argument '${argument}'\n`);
  output.stderr(`Run '${PROJECT_NAME} --help' for usage.\n`);

  return 1;
};

type FlagSpec = {
  readonly name: string;
  readonly takesValue: boolean;
  readonly valueName: string | undefined;
  readonly description: string;
};

type PositionalSpec = {
  readonly name: string;
  readonly usageName: string;
  readonly required: boolean;
  readonly missingMessage: string | undefined;
};

type ParsedCommandArguments = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
};

type CommandContext = {
  readonly arguments: ParsedCommandArguments;
  readonly dependencies: CliDependencies;
  readonly entry: CommandMetadata;
  readonly hostConfiguration: HostConfiguration;
  readonly output: CliIO;
  readonly pluginPath: string;
  readonly projectPath: string;
};

type CommandExecution<Result> = {
  readonly exitCode: number;
  readonly result: Result;
};

type LegacyHelpLayout = "standard" | "compact" | "expanded";

type CommandMetadata = {
  readonly tokens: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  readonly forEachProject: boolean;
  readonly description: string;
  readonly helpLayout: LegacyHelpLayout;
};

type CommandDefinition<Result> = CommandMetadata & {
  readonly run: (context: CommandContext) => CommandExecution<Result>;
  readonly format: (result: Result, context: CommandContext) => string;
};

type ReportRecordFormatter<Result> = (result: Result) => readonly string[];

type FormattedCommandExecution = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutRecords: readonly string[] | undefined;
  readonly stderr: string;
};

type CommandEntry = CommandMetadata & {
  readonly execute: (context: CommandContext) => FormattedCommandExecution;
};

class ArgumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentParseError";
  }
}

const booleanFlag = (name: string, description: string): FlagSpec => ({
  name,
  takesValue: false,
  valueName: undefined,
  description,
});

const valueFlag = (name: string, valueName: string, description: string): FlagSpec => ({
  name,
  takesValue: true,
  valueName,
  description,
});

const commandExecution = <Result>(result: Result, exitCode = 0): CommandExecution<Result> => ({
  result,
  exitCode,
});

const booleanFlagValue = (arguments_: ParsedCommandArguments, name: string): boolean =>
  arguments_.flags[name] === true;

const stringFlagValue = (arguments_: ParsedCommandArguments, name: string): string | undefined => {
  const value = arguments_.flags[name];

  return value === String(value) ? value : undefined;
};

const flagFor = (entry: CommandEntry, name: string): FlagSpec | undefined =>
  entry.flags.find((flag) => flag.name === name);

const parseCommandArguments = (
  entry: CommandEntry,
  args: readonly string[],
): ParsedCommandArguments => {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === undefined) continue;

    if (argument.startsWith("--")) {
      const spec = flagFor(entry, argument);

      if (spec === undefined) throw new ArgumentParseError(`unknown flag '${argument}'`);

      if (flags[spec.name] !== undefined) {
        throw new ArgumentParseError(`flag '${argument}' may only be specified once`);
      }

      if (!spec.takesValue) {
        flags[spec.name] = true;
        continue;
      }

      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new ArgumentParseError(`flag '${argument}' requires a value`);
      }

      flags[spec.name] = value;
      index += 1;
      continue;
    }

    if (positionals.length >= entry.positionals.length) {
      throw new ArgumentParseError(`unknown argument '${argument}'`);
    }

    positionals.push(argument);
  }

  for (const [index, positional] of entry.positionals.entries()) {
    if (positional.required && positionals[index] === undefined) {
      throw new ArgumentParseError(positional.missingMessage ?? `${positional.name} is required`);
    }
  }

  return { positionals, flags };
};

const commandLabel = (entry: CommandMetadata): string => entry.tokens.join(" ");

const commandErrorDetail = (entry: CommandMetadata | undefined, cause: unknown): string => {
  const message = errorMessage(cause);

  if (cause !== undefined || entry === undefined) return message;
  const label = commandLabel(entry);

  if (label === "worktree-setup") return "setup failed";

  if (label === "wt create") return "worktree bootstrap failed";

  return message;
};

const formatCommandError = (entry: CommandMetadata | undefined, cause: unknown): string => {
  const prefix = entry === undefined ? PROJECT_NAME : `${PROJECT_NAME} ${commandLabel(entry)}`;

  return `${prefix}: ${commandErrorDetail(entry, cause)}\n`;
};

const printArgumentError = (output: CliIO, entry: CommandEntry, cause: unknown): number => {
  output.stderr(formatCommandError(entry, cause));
  output.stderr(`Run '${PROJECT_NAME} --help' for usage.\n`);

  return 1;
};

const printCommandError = (output: CliIO, entry: CommandEntry, cause: unknown): number => {
  output.stderr(formatCommandError(entry, cause));

  return 1;
};

const requiredPositional = (context: CommandContext, index: number, name: string): string => {
  const value = context.arguments.positionals[index];

  if (value === undefined) throw new Error(`${name} is required`);

  return value;
};

const runWorktreeSetupCommand = (
  context: CommandContext,
): CommandExecution<WorktreeBootstrapResult> => {
  const interactive = booleanFlagValue(context.arguments, "--interactive");

  const reportFailure = (result: WorktreeBootstrapResult): void => {
    context.output.stderr(formatCommandError(context.entry, result.error));

    if (interactive) context.output.stderr("Press Enter to retry or q to quit.\n");
  };

  const result = context.dependencies.bootstrap.run({
    allowCompleted: true,
    io: interactive
      ? {
          onFailure: reportFailure,
          readLine: context.dependencies.readLine,
        }
      : undefined,
    mainCheckout: undefined,
    worktreePath: context.dependencies.cwd ?? process.cwd(),
  });

  if (result.exitCode !== 0 && !interactive) throw result.error;

  return commandExecution(result, result.exitCode);
};

const worktreeCreateExecution = (
  context: CommandContext,
  branch: string,
  focus: boolean,
): CommandExecution<WorktreeCreateResult> =>
  commandExecution(
    runWorktreeCreate({
      base: stringFlagValue(context.arguments, "--base"),
      branch,
      bootstrap: context.dependencies.bootstrap,
      deadline: worktreeBootstrapDeadline(context.dependencies.now),
      cwd: context.dependencies.cwd ?? process.cwd(),
      focus,
      herdrClient: context.dependencies.herdrClient,
      noFocus: booleanFlagValue(context.arguments, "--no-focus"),
      runner: context.dependencies.runner,
      sleep: undefined,
    }),
  );

const runWorktreeCreateCommand = (
  context: CommandContext,
): CommandExecution<WorktreeCreateResult> =>
  worktreeCreateExecution(context, requiredPositional(context, 0, "branch name"), false);

const runWorktreeNewCommand = (
  context: CommandContext,
): CommandExecution<WorktreeCreateResult | undefined> => {
  const branch = context.dependencies.readLine(BRANCH_PROMPT).trim();

  if (branch.length === 0) throw new Error("branch name is required");

  return worktreeCreateExecution(context, branch, true);
};

const worktreeCreateOutput = (result: WorktreeCreateResult, json: boolean): string => {
  if (json) {
    return `${JSON.stringify({
      workspace_id: result.workspaceId,
      root_pane_id: result.rootPaneId,
    })}\n`;
  }

  return `Workspace ID: ${result.workspaceId}\nRoot pane ID: ${result.rootPaneId}\n`;
};

const formatWorktreeCreate = (
  result: WorktreeCreateResult | undefined,
  context: CommandContext,
): string =>
  result === undefined
    ? ""
    : worktreeCreateOutput(result, booleanFlagValue(context.arguments, "--json"));

const runProjectUpdateCommand = (
  context: CommandContext,
): CommandExecution<ProjectUpdateResult> => {
  const result = runProjectUpdate({
    projectPath: context.projectPath,
    runner: context.dependencies.runner,
  });

  return commandExecution(result, result.exitCode);
};

const formatProjectUpdateCommand = (result: ProjectUpdateResult): string =>
  formatProjectUpdate(result);

const runProjectGcCommand = (context: CommandContext): CommandExecution<ProjectGcResult> => {
  const result = runProjectGc({
    bootstrap: context.dependencies.bootstrap,
    buildDirectories: undefined,
    dryRun: booleanFlagValue(context.arguments, "--dry-run"),
    herdrClient: context.dependencies.herdrClient,
    projectPath: context.projectPath,
    runner: context.dependencies.runner,
  });

  return commandExecution(result, result.exitCode);
};

const formatProjectGcCommand = (result: ProjectGcResult): string => formatProjectGc(result);

const runAdoptWorktreesCommand = (
  context: CommandContext,
): CommandExecution<AdoptWorktreesResult> => {
  const result = runAdoptWorktrees({
    bootstrap: context.dependencies.bootstrap,
    herdrClient: context.dependencies.herdrClient,
    projectPath: context.projectPath,
    runner: context.dependencies.runner,
  });

  return commandExecution(result, result.exitCode);
};

const formatAdoptWorktreesCommand = (result: AdoptWorktreesResult): string =>
  formatAdoptWorktrees(result);

const runProjectAddCommand = (context: CommandContext): CommandExecution<ProjectAddResult> =>
  commandExecution(
    runProjectAdd({
      repository: requiredPositional(context, 0, "repository"),
      from: stringFlagValue(context.arguments, "--from"),
      local: booleanFlagValue(context.arguments, "--local"),
      platform: context.hostConfiguration.platform,
      homeDirectory: context.hostConfiguration.homeDirectory,
      codeRoot: context.hostConfiguration.codeRoot,
      projectsFile: context.hostConfiguration.projectsFile,
      systemdUserDirectory: context.hostConfiguration.systemdUserDirectory,
      templateRoot: context.hostConfiguration.templateRoot,
      host: stringFlagValue(context.arguments, "--host") ?? context.hostConfiguration.host,
      user: context.hostConfiguration.user,
      herdrClient: context.dependencies.herdrClient,
      runner: context.dependencies.runner,
      syncReferences: context.dependencies.syncReferences,
    }),
  );

const formatProjectAdd = (result: ProjectAddResult): string => result.instructions;

const runSyncCommand = (context: CommandContext): CommandExecution<void> => {
  runProjectSync({
    runner: context.dependencies.runner,
    syncReferences: context.dependencies.syncReferences,
    worktreePath: context.projectPath,
  });

  return commandExecution(undefined);
};

const runWorktreeEventCommand = (
  context: CommandContext,
): CommandExecution<WorktreeEventResult> => {
  const result = runWorktreeEvent({
    eventJson: context.hostConfiguration.eventJson,
    workspaceId: context.hostConfiguration.workspaceId,
    bootstrap: context.dependencies.bootstrap,
    herdrClient: context.dependencies.herdrClient,
    runner: context.dependencies.runner,
  });

  return commandExecution(result, result.exitCode);
};

const runPluginInstallCommand = (context: CommandContext): CommandExecution<PluginInstallResult> =>
  commandExecution(
    runPluginInstall({
      herdrClient: context.dependencies.herdrClient,
      pluginPath: context.pluginPath,
    }),
  );

const formatPluginInstall = (result: PluginInstallResult): string =>
  result.action === "unchanged" ? "" : `${PROJECT_PLUGIN_ID}: ${result.action}\n`;

const formatWorktreeSetup = (_result: WorktreeBootstrapResult): string => "";

const formatSync = (_result: void): string => "";

const formatWorktreeEvent = (_result: WorktreeEventResult): string => "";

const failedCommandExecution = (
  entry: CommandMetadata,
  cause: unknown,
): FormattedCommandExecution => ({
  exitCode: 1,
  stdout: "",
  stdoutRecords: undefined,
  stderr: formatCommandError(entry, cause),
});

const formatCommandExecution = <Result>(
  definition: CommandDefinition<Result>,
  context: CommandContext,
  formatRecords: ReportRecordFormatter<Result> | undefined,
): FormattedCommandExecution => {
  try {
    const execution = definition.run(context);
    const stdout = definition.format(execution.result, context);
    const records = formatRecords?.(execution.result);

    return {
      exitCode: execution.exitCode,
      stdout,
      stdoutRecords: records?.map((record) => `${record}\n`),
      stderr: "",
    };
  } catch (error) {
    return failedCommandExecution(definition, error);
  }
};

const outputRecords = (output: string): readonly string[] => (output.length === 0 ? [] : [output]);

const prefixProjectOutput = (projectName: string, records: readonly string[]): string =>
  records.map((record) => `[${projectName}] ${record}`).join("");

const runAllProjects = <Result>(
  definition: CommandDefinition<Result>,
  formatRecords: ReportRecordFormatter<Result> | undefined,
  context: CommandContext,
): FormattedCommandExecution => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  let projects: ReturnType<typeof enumerateProjects>;

  try {
    const enumerate = context.dependencies.enumerateProjects ?? enumerateProjects;
    projects = enumerate({
      platform: context.hostConfiguration.platform,
      homeDirectory: context.hostConfiguration.homeDirectory,
      projectsFile: context.hostConfiguration.projectsFile,
      systemdUserDirectory: context.hostConfiguration.systemdUserDirectory,
    });
  } catch (error) {
    return failedCommandExecution(definition, error);
  }

  for (const project of projects) {
    const projectContext: CommandContext = {
      ...context,
      projectPath: project.path,
    };

    const execution = formatCommandExecution(definition, projectContext, formatRecords);
    stdout.push(
      prefixProjectOutput(project.repo, execution.stdoutRecords ?? outputRecords(execution.stdout)),
    );
    stderr.push(prefixProjectOutput(project.repo, outputRecords(execution.stderr)));

    if (execution.exitCode !== 0) exitCode = 1;
  }

  return { exitCode, stdout: stdout.join(""), stdoutRecords: undefined, stderr: stderr.join("") };
};

const executeCommand = <Result>(
  definition: CommandDefinition<Result>,
  formatRecords: ReportRecordFormatter<Result> | undefined,
  context: CommandContext,
): FormattedCommandExecution =>
  definition.forEachProject && booleanFlagValue(context.arguments, "--all")
    ? runAllProjects(definition, formatRecords, context)
    : formatCommandExecution(definition, context, formatRecords);

const command = <Result>(
  definition: CommandDefinition<Result>,
  formatRecords: ReportRecordFormatter<Result> | undefined = undefined,
): CommandEntry => ({
  tokens: definition.tokens,
  positionals: definition.positionals,
  flags: definition.flags,
  forEachProject: definition.forEachProject,
  description: definition.description,
  helpLayout: definition.helpLayout,
  execute: (context) => executeCommand(definition, formatRecords, context),
});

const commandTable: readonly CommandEntry[] = [
  command<ProjectAddResult>({
    tokens: ["add"],
    positionals: [
      {
        name: "repository",
        usageName: "repo",
        required: true,
        missingMessage: "repository is required",
      },
    ],
    flags: [
      valueFlag("--from", "template", "Bind a bundled devenv template"),
      booleanFlag("--local", "Register without a systemd session"),
      valueFlag("--host", "name", "Host used in printed attachment snippets"),
    ],
    forEachProject: false,
    description: "Add and prepare a project checkout",
    helpLayout: "standard",
    run: runProjectAddCommand,
    format: formatProjectAdd,
  }),
  command<WorktreeBootstrapResult>({
    tokens: ["worktree-setup"],
    positionals: [],
    flags: [booleanFlag("--interactive", "Retry setup failures interactively")],
    forEachProject: false,
    description: "Bootstrap the current worktree",
    helpLayout: "expanded",
    run: runWorktreeSetupCommand,
    format: formatWorktreeSetup,
  }),
  command<WorktreeCreateResult>({
    tokens: ["wt", "create"],
    positionals: [
      {
        name: "branch",
        usageName: "branch",
        required: true,
        missingMessage: "branch name is required",
      },
    ],
    flags: [
      valueFlag("--base", "ref", "Create from a base ref"),
      booleanFlag("--no-focus", "Leave the new workspace unfocused"),
      booleanFlag("--json", "Print workspace and pane ids as JSON"),
    ],
    forEachProject: false,
    description: "Create and bootstrap a worktree",
    helpLayout: "compact",
    run: runWorktreeCreateCommand,
    format: formatWorktreeCreate,
  }),
  command<WorktreeCreateResult | undefined>({
    tokens: ["wt", "new"],
    positionals: [],
    flags: [],
    forEachProject: false,
    description: "Prompt for and create a focused worktree",
    helpLayout: "compact",
    run: runWorktreeNewCommand,
    format: formatWorktreeCreate,
  }),
  command<void>({
    tokens: ["sync"],
    positionals: [],
    flags: [],
    forEachProject: false,
    description: "Materialize declared project references",
    helpLayout: "standard",
    run: runSyncCommand,
    format: formatSync,
  }),
  command<WorktreeEventResult>({
    tokens: ["wt", "on-event"],
    positionals: [],
    flags: [],
    forEachProject: false,
    description: "Handle a Herdr worktree event",
    helpLayout: "standard",
    run: runWorktreeEventCommand,
    format: formatWorktreeEvent,
  }),
  command<PluginInstallResult>({
    tokens: ["plugin", "install"],
    positionals: [],
    flags: [],
    forEachProject: false,
    description: "Link the Herdr worktree plugin",
    helpLayout: "standard",
    run: runPluginInstallCommand,
    format: formatPluginInstall,
  }),
  command<ProjectUpdateResult>(
    {
      tokens: ["update"],
      positionals: [],
      flags: [booleanFlag("--all", "Refresh and rebuild every registered project")],
      forEachProject: true,
      description: "Refresh and rebuild project environments",
      helpLayout: "standard",
      run: runProjectUpdateCommand,
      format: formatProjectUpdateCommand,
    },
    formatProjectUpdateRecords,
  ),
  command<ProjectGcResult>(
    {
      tokens: ["gc"],
      positionals: [],
      flags: [
        booleanFlag("--all", "Review or collect worktrees in every registered project"),
        booleanFlag("--dry-run", "Review stale worktrees without changing them"),
      ],
      forEachProject: true,
      description: "Review or collect stale worktrees",
      helpLayout: "expanded",
      run: runProjectGcCommand,
      format: formatProjectGcCommand,
    },
    formatProjectGcRecords,
  ),
  command<AdoptWorktreesResult>(
    {
      tokens: ["adopt-worktrees"],
      positionals: [],
      flags: [booleanFlag("--all", "Bootstrap every registered project's worktrees")],
      forEachProject: true,
      description: "Bootstrap registered worktrees",
      helpLayout: "standard",
      run: runAdoptWorktreesCommand,
      format: formatAdoptWorktreesCommand,
    },
    formatAdoptWorktreesRecords,
  ),
];

const commandUsage = (entry: CommandEntry): string => {
  const positionals = entry.positionals.map((positional) =>
    positional.required ? `<${positional.usageName}>` : `[${positional.usageName}]`,
  );

  const flags =
    entry.flags.length === 0
      ? []
      : entry.flags.some((flag) => flag.takesValue)
        ? ["[options]"]
        : entry.flags.map((flag) => `[${flag.name}]`);

  return [...entry.tokens, ...positionals, ...flags].join(" ");
};

/**
 * The prior literal help used three command-line description columns. Keep those
 * compatibility values centralized while entries select the legacy layout.
 */
const HELP_DESCRIPTION_COLUMNS: Readonly<Record<LegacyHelpLayout, number>> = {
  standard: 33,
  compact: 32,
  expanded: 34,
};

const formatHelpLine = (label: string, description: string, descriptionColumn: number): string =>
  `${label.padEnd(Math.max(descriptionColumn, label.length + 1))}${description}`;

type HelpLine = readonly [label: string, description: string];

/**
 * Preserve the historical option spacing while keeping its alignment derived.
 */
const formatOptionLines = (lines: readonly HelpLine[]): string[] => {
  const descriptionColumn = Math.max(...lines.map(([label]) => label.length + 2));

  return lines.map(([label, description]) => formatHelpLine(label, description, descriptionColumn));
};

const renderHelp = (entries: readonly CommandEntry[]): string => {
  const lines = [
    `Usage: ${PROJECT_NAME} [options]`,
    "",
    "Project lifecycle tooling for devenv and Herdr worktrees.",
    "",
    "Commands:",
  ];

  for (const entry of entries) {
    const descriptionColumn = HELP_DESCRIPTION_COLUMNS[entry.helpLayout];
    lines.push(formatHelpLine(`  ${commandUsage(entry)}`, entry.description, descriptionColumn));

    if (entry.flags.some((flag) => flag.takesValue)) {
      for (const flag of entry.flags) {
        const value = flag.valueName === undefined ? "" : ` <${flag.valueName}>`;
        lines.push(
          formatHelpLine(`      ${flag.name}${value}`, flag.description, descriptionColumn),
        );
      }
    }
  }

  lines.push(
    "",
    "Options:",
    ...formatOptionLines([
      ["  -h, --help", "Show this help message"],
      ["  -v, --version", "Show the version"],
    ]),
  );

  return `${lines.join("\n")}\n`;
};

/**
 * The help text for the project CLI, rendered from the command table.
 */
const HELP_TEXT = renderHelp(commandTable);

const commandEntryFor = (args: readonly string[]): CommandEntry | undefined => {
  let match: CommandEntry | undefined;

  for (const entry of commandTable) {
    if (args.length < entry.tokens.length) continue;

    if (!entry.tokens.every((token, index) => args[index] === token)) continue;

    if (match === undefined || entry.tokens.length > match.tokens.length) match = entry;
  }

  return match;
};

/**
 * Runs the project CLI for the supplied arguments.
 *
 * @param args Arguments after the executable name.
 * @param io Output channels used for the response.
 * @param dependencies Injectable command, filesystem-context, clock, and input seams.
 * @returns The process exit code, without terminating the current process.
 */
export const runCli = (
  args: readonly string[],
  io: CliIO | undefined = undefined,
  dependencies: CliDependencies | undefined = undefined,
): number => {
  const output = io ?? processIO;
  const environment = dependencies?.environment ?? process.env;
  let hostConfiguration: HostConfiguration;

  try {
    hostConfiguration = resolveHostConfiguration(environment);
  } catch (error) {
    output.stderr(formatCommandError(undefined, error));

    return 1;
  }

  const pluginPath = resolvePluginPath(dependencies?.pluginPath, environment);

  if (args.length === 0 || args.some(isHelpFlag)) {
    output.stdout(HELP_TEXT);

    return 0;
  }

  if (args.length === 1 && isVersionFlag(args[0] ?? "")) {
    output.stdout(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);

    return 0;
  }

  const entry = commandEntryFor(args);

  if (entry === undefined) return printUnknown(output, args[0] ?? "");

  let parsedArguments: ParsedCommandArguments;

  try {
    parsedArguments = parseCommandArguments(entry, args.slice(entry.tokens.length));
  } catch (error) {
    return printArgumentError(output, entry, error);
  }

  const resolvedDependencies =
    dependencies ?? createDefaultDependencies(hostConfiguration, environment, defaultCommandRunner);

  const context: CommandContext = {
    arguments: parsedArguments,
    dependencies: resolvedDependencies,
    entry,
    hostConfiguration,
    output,
    pluginPath,
    projectPath: resolvedDependencies.cwd ?? process.cwd(),
  };

  try {
    const execution = entry.execute(context);

    if (execution.stdout.length > 0) output.stdout(execution.stdout);

    if (execution.stderr.length > 0) output.stderr(execution.stderr);

    return execution.exitCode;
  } catch (error) {
    return printCommandError(output, entry, error);
  }
};

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
