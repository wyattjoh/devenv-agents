#!/usr/bin/env bun

import { defaultCommandRunner, errorMessage, type CommandRunner } from "./command-runner.ts";
import { createHerdrClient, type HerdrClient } from "./herdr-client.ts";
import {
  defaultProjectRoots,
  enumerateProjects,
  runProjectAdd,
  type ProjectPlatform,
} from "./project-add.ts";
import { formatProjectUpdate, runProjectUpdate } from "./project-update.ts";
import {
  formatAdoptWorktrees,
  formatProjectGc,
  runAdoptWorktrees,
  runProjectGc,
} from "./project-gc.ts";
import { runWorktreeCreate, type WorktreeCreateResult } from "./worktree-create.ts";
import {
  PROJECT_PLUGIN_ID,
  resolvePluginPath,
  runPluginInstall,
  runWorktreeEvent,
  type PluginEnvironment,
} from "./worktree-plugin.ts";
import { createSyncReferences, runProjectSync } from "./project-sync.ts";
import {
  runInteractiveWorktreeSetup,
  runWorktreeSetup,
  type SyncReferences,
} from "./worktree-setup.ts";

/**
 * The public command name used by the standalone binary and the Bun entrypoint.
 */
export const PROJECT_NAME = "project";

/**
 * The initial version of the project CLI.
 */
export const PROJECT_VERSION = "0.1.0";

/**
 * The output channels used by the CLI, kept injectable so command behavior can
 * be tested without replacing the process streams.
 */
export type CliIO = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/**
 * The help text for the project CLI.
 */
export const HELP_TEXT = `Usage: ${PROJECT_NAME} [options]

Project lifecycle tooling for devenv and Herdr worktrees.

Commands:
  add <repo> [options]           Add and prepare a project checkout
      --from <template>          Bind a bundled devenv template
      --local                    Register without a systemd session
      --host <name>              Host used in printed attachment snippets
  worktree-setup [--interactive]  Bootstrap the current worktree
  wt create <branch> [options]  Create and bootstrap a worktree
      --base <ref>              Create from a base ref
      --no-focus                Leave the new workspace unfocused
      --json                    Print workspace and pane ids as JSON
  wt new                        Prompt for and create a focused worktree
  sync                           Materialize declared project references
  wt on-event                    Handle a Herdr worktree event
  plugin install                 Link the Herdr worktree plugin
  update [--all]                 Refresh and rebuild project environments
  gc [--all] [--dry-run]          Review or collect stale worktrees
  adopt-worktrees [--all]        Bootstrap registered worktrees

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Runtime seams used by commands without replacing the process itself.
 */
export type CliDependencies = {
  readonly cwd: string | undefined;
  readonly now: () => string;
  readonly readLine: (message?: string) => string;
  readonly runner: CommandRunner;
  readonly herdrClient: HerdrClient;
  readonly syncReferences: SyncReferences;
  /**
   * Environment snapshot used by Herdr commands, or undefined for process.env.
   */
  readonly environment: PluginEnvironment | undefined;
  /**
   * Override for the plugin root used by plugin install, or undefined to resolve it.
   */
  readonly pluginPath: string | undefined;
};

const BRANCH_PROMPT = "Branch name: ";

const interactiveLine = (message = "Press Enter to retry or q to quit: "): string => {
  const promptFunction = (
    globalThis as typeof globalThis & {
      prompt?: (message?: string) => string | null;
    }
  ).prompt;
  return promptFunction?.(message) ?? (message === BRANCH_PROMPT ? "" : "q");
};

const defaultDependencies = (): CliDependencies => ({
  cwd: undefined,
  now: () => new Date().toISOString(),
  readLine: interactiveLine,
  runner: defaultCommandRunner,
  herdrClient: createHerdrClient(defaultCommandRunner, process.env.HERDR_BIN_PATH),
  syncReferences: createSyncReferences({ runner: defaultCommandRunner }),
  environment: undefined,
  pluginPath: undefined,
});

const isHelpFlag = (argument: string): boolean => argument === "--help" || argument === "-h";

const isVersionFlag = (argument: string): boolean => argument === "--version" || argument === "-v";

const printUnknown = (output: CliIO, argument: string): number => {
  output.stderr(`${PROJECT_NAME}: unknown argument '${argument}'\n`);
  output.stderr(`Run '${PROJECT_NAME} --help' for usage.\n`);
  return 1;
};

const runWorktreeSetupCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  interactive: boolean,
): number => {
  const options = {
    allowCompleted: true,
    mainCheckout: undefined,
    now: dependencies.now,
    herdrClient: dependencies.herdrClient,
    runner: dependencies.runner,
    syncReferences: dependencies.syncReferences,
    worktreePath: dependencies.cwd ?? process.cwd(),
  };
  const reportFailure = (result: ReturnType<typeof runWorktreeSetup>): void => {
    output.stderr(`${PROJECT_NAME} worktree-setup: ${result.error ?? "setup failed"}\n`);
    if (interactive) output.stderr("Press Enter to retry or q to quit.\n");
  };

  try {
    const result = interactive
      ? runInteractiveWorktreeSetup(options, dependencies.readLine, reportFailure)
      : runWorktreeSetup(options);
    if (result.exitCode !== 0 && !interactive) reportFailure(result);
    return result.exitCode;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} worktree-setup: ${message}\n`);
    return 1;
  }
};

const runWorktreeEventCommand = (dependencies: CliDependencies): number => {
  const environment = dependencies.environment ?? process.env;
  return runWorktreeEvent({
    eventJson: environment.HERDR_PLUGIN_EVENT_JSON,
    workspaceId: environment.HERDR_WORKSPACE_ID,
    herdrClient: dependencies.herdrClient,
    now: dependencies.now,
    runner: dependencies.runner,
  }).exitCode;
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

const runWorktreeCreateCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  args: readonly string[],
  focus: boolean,
): number => {
  let branch: string | undefined;
  let base: string | undefined;
  let json = false;
  let noFocus = false;

  if (args.length === 0 || args[0]?.startsWith("--")) {
    output.stderr(`${PROJECT_NAME} wt create: branch name is required\n`);
    return 1;
  }
  branch = args[0];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        output.stderr(`${PROJECT_NAME} wt create: --base requires a ref\n`);
        return 1;
      }
      base = value;
      index += 1;
      continue;
    }
    if (argument === "--no-focus") {
      noFocus = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    return printUnknown(output, argument ?? "wt");
  }

  try {
    const result = runWorktreeCreate({
      base,
      branch,
      cwd: dependencies.cwd ?? process.cwd(),
      focus,
      herdrClient: dependencies.herdrClient,
      noFocus,
      runner: dependencies.runner,
      sleep: undefined,
    });
    output.stdout(worktreeCreateOutput(result, json));
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} wt create: ${message}\n`);
    return 1;
  }
};

const runWorktreeNewCommand = (output: CliIO, dependencies: CliDependencies): number => {
  const branch = dependencies.readLine(BRANCH_PROMPT).trim();
  if (branch.length === 0) {
    output.stderr(`${PROJECT_NAME} wt new: branch name is required\n`);
    return 1;
  }
  return runWorktreeCreateCommand(output, dependencies, [branch], true);
};

const platformFrom = (platform: string | undefined): ProjectPlatform => {
  if (platform === "linux" || platform === "darwin") return platform;
  if (platform !== undefined) {
    throw new Error(`PROJECT_PLATFORM must be either linux or darwin, got '${platform}'`);
  }
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new Error(`Unsupported host platform '${process.platform}'`);
};

const runProjectUpdateCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  args: readonly string[],
): number => {
  let all = false;
  for (const argument of args) {
    if (argument === "--all" && !all) {
      all = true;
      continue;
    }
    return printUnknown(output, argument ?? "update");
  }

  const environment = dependencies.environment ?? process.env;
  try {
    if (!all) {
      const result = runProjectUpdate({
        projectPath: dependencies.cwd ?? process.cwd(),
        runner: dependencies.runner,
      });
      output.stdout(formatProjectUpdate(result));
      return result.exitCode;
    }

    const roots = defaultProjectRoots();
    const projects = enumerateProjects({
      platform: platformFrom(environment.PROJECT_PLATFORM),
      homeDirectory: environment.PROJECT_HOME ?? environment.HOME ?? roots.homeDirectory,
      projectsFile: environment.PROJECT_PROJECTS_FILE,
      systemdUserDirectory: environment.PROJECT_SYSTEMD_USER_DIRECTORY,
    });
    let exitCode = 0;
    for (const project of projects) {
      try {
        const result = runProjectUpdate({ projectPath: project.path, runner: dependencies.runner });
        output.stdout(formatProjectUpdate(result, project.repo));
        if (result.exitCode !== 0) exitCode = 1;
      } catch (error) {
        const message = errorMessage(error);
        output.stderr(`[${project.repo}] ${PROJECT_NAME} update: ${message}\n`);
        exitCode = 1;
      }
    }
    return exitCode;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} update: ${message}\n`);
    return 1;
  }
};

const runProjectGcCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  args: readonly string[],
): number => {
  let all = false;
  let dryRun = false;
  for (const argument of args) {
    if (argument === "--all" && !all) {
      all = true;
      continue;
    }
    if (argument === "--dry-run" && !dryRun) {
      dryRun = true;
      continue;
    }
    return printUnknown(output, argument ?? "gc");
  }

  const environment = dependencies.environment ?? process.env;
  try {
    if (!all) {
      const result = runProjectGc({
        buildDirectories: undefined,
        dryRun,
        herdrClient: dependencies.herdrClient,
        projectPath: dependencies.cwd ?? process.cwd(),
        runner: dependencies.runner,
      });
      output.stdout(formatProjectGc(result));
      return result.exitCode;
    }

    const roots = defaultProjectRoots();
    const projects = enumerateProjects({
      platform: platformFrom(environment.PROJECT_PLATFORM),
      homeDirectory: environment.PROJECT_HOME ?? environment.HOME ?? roots.homeDirectory,
      projectsFile: environment.PROJECT_PROJECTS_FILE,
      systemdUserDirectory: environment.PROJECT_SYSTEMD_USER_DIRECTORY,
    });
    let exitCode = 0;
    for (const project of projects) {
      try {
        const result = runProjectGc({
          buildDirectories: undefined,
          dryRun,
          herdrClient: dependencies.herdrClient,
          projectPath: project.path,
          runner: dependencies.runner,
        });
        output.stdout(formatProjectGc(result, project.repo));
        if (result.exitCode !== 0) exitCode = 1;
      } catch (error) {
        const message = errorMessage(error);
        output.stderr(`[${project.repo}] ${PROJECT_NAME} gc: ${message}\n`);
        exitCode = 1;
      }
    }
    return exitCode;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} gc: ${message}\n`);
    return 1;
  }
};

const runAdoptWorktreesCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  args: readonly string[],
): number => {
  let all = false;
  for (const argument of args) {
    if (argument === "--all" && !all) {
      all = true;
      continue;
    }
    return printUnknown(output, argument ?? "adopt-worktrees");
  }

  const environment = dependencies.environment ?? process.env;
  try {
    if (!all) {
      const result = runAdoptWorktrees({
        herdrClient: dependencies.herdrClient,
        now: dependencies.now,
        projectPath: dependencies.cwd ?? process.cwd(),
        runner: dependencies.runner,
        syncReferences: dependencies.syncReferences,
      });
      output.stdout(formatAdoptWorktrees(result));
      return result.exitCode;
    }

    const roots = defaultProjectRoots();
    const projects = enumerateProjects({
      platform: platformFrom(environment.PROJECT_PLATFORM),
      homeDirectory: environment.PROJECT_HOME ?? environment.HOME ?? roots.homeDirectory,
      projectsFile: environment.PROJECT_PROJECTS_FILE,
      systemdUserDirectory: environment.PROJECT_SYSTEMD_USER_DIRECTORY,
    });
    let exitCode = 0;
    for (const project of projects) {
      try {
        const result = runAdoptWorktrees({
          herdrClient: dependencies.herdrClient,
          now: dependencies.now,
          projectPath: project.path,
          runner: dependencies.runner,
          syncReferences: dependencies.syncReferences,
        });
        output.stdout(formatAdoptWorktrees(result, project.repo));
        if (result.exitCode !== 0) exitCode = 1;
      } catch (error) {
        const message = errorMessage(error);
        output.stderr(`[${project.repo}] ${PROJECT_NAME} adopt-worktrees: ${message}\n`);
        exitCode = 1;
      }
    }
    return exitCode;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} adopt-worktrees: ${message}\n`);
    return 1;
  }
};

const runProjectAddCommand = (
  output: CliIO,
  dependencies: CliDependencies,
  args: readonly string[],
): number => {
  let repository: string | undefined;
  let from: string | undefined;
  let local = false;
  let host: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--from") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        output.stderr(`${PROJECT_NAME} add: --from requires a template\n`);
        return 1;
      }
      from = value;
      index += 1;
      continue;
    }
    if (argument === "--local") {
      local = true;
      continue;
    }
    if (argument === "--host") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        output.stderr(`${PROJECT_NAME} add: --host requires a host name\n`);
        return 1;
      }
      host = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) return printUnknown(output, argument);
    if (repository !== undefined) return printUnknown(output, argument ?? "add");
    repository = argument;
  }

  if (repository === undefined) {
    output.stderr(`${PROJECT_NAME} add: repository is required\n`);
    return 1;
  }

  const environment = dependencies.environment ?? process.env;
  const roots = defaultProjectRoots();
  const homeDirectory = environment.PROJECT_HOME ?? environment.HOME ?? roots.homeDirectory;
  try {
    const result = runProjectAdd({
      repository,
      from,
      local,
      platform: platformFrom(environment.PROJECT_PLATFORM),
      homeDirectory,
      codeRoot: environment.PROJECT_CODE_ROOT,
      projectsFile: environment.PROJECT_PROJECTS_FILE,
      systemdUserDirectory: environment.PROJECT_SYSTEMD_USER_DIRECTORY,
      templateRoot: environment.PROJECT_TEMPLATE_ROOT ?? roots.templateRoot,
      host: host ?? environment.PROJECT_HOST ?? "strix",
      user: environment.USER ?? environment.USERNAME ?? "user",
      herdrClient: dependencies.herdrClient,
      runner: dependencies.runner,
      syncReferences: dependencies.syncReferences,
    });
    output.stdout(result.instructions);
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} add: ${message}\n`);
    return 1;
  }
};

const runSyncCommand = (output: CliIO, dependencies: CliDependencies): number => {
  try {
    runProjectSync({
      runner: dependencies.runner,
      syncReferences: dependencies.syncReferences,
      worktreePath: dependencies.cwd ?? process.cwd(),
    });
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} sync: ${message}\n`);
    return 1;
  }
};

const runPluginInstallCommand = (output: CliIO, dependencies: CliDependencies): number => {
  const environment = dependencies.environment ?? process.env;
  try {
    const result = runPluginInstall({
      herdrClient: dependencies.herdrClient,
      pluginPath: resolvePluginPath(dependencies.pluginPath, environment),
    });
    if (result.action !== "unchanged") {
      output.stdout(`${PROJECT_PLUGIN_ID}: ${result.action}\n`);
    }
    return result.exitCode;
  } catch (error) {
    const message = errorMessage(error);
    output.stderr(`${PROJECT_NAME} plugin install: ${message}\n`);
    return 1;
  }
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

  if (args.length === 0 || args.some(isHelpFlag)) {
    output.stdout(HELP_TEXT);
    return 0;
  }

  if (args.length === 1 && isVersionFlag(args[0] ?? "")) {
    output.stdout(`${PROJECT_NAME} ${PROJECT_VERSION}\n`);
    return 0;
  }

  const command = args[0] ?? "";
  const resolvedDependencies = dependencies ?? defaultDependencies();
  if (command === "add") {
    return runProjectAddCommand(output, resolvedDependencies, args.slice(1));
  }

  if (command === "update") {
    return runProjectUpdateCommand(output, resolvedDependencies, args.slice(1));
  }

  if (command === "gc") {
    return runProjectGcCommand(output, resolvedDependencies, args.slice(1));
  }

  if (command === "adopt-worktrees") {
    return runAdoptWorktreesCommand(output, resolvedDependencies, args.slice(1));
  }

  if (command === "worktree-setup") {
    const commandArguments = args.slice(1);
    if (
      commandArguments.length > 1 ||
      (commandArguments.length === 1 && commandArguments[0] !== "--interactive")
    ) {
      return printUnknown(output, commandArguments[0] ?? command);
    }
    return runWorktreeSetupCommand(output, resolvedDependencies, commandArguments.length === 1);
  }

  if (command === "wt" && args[1] === "create") {
    return runWorktreeCreateCommand(output, resolvedDependencies, args.slice(2), false);
  }

  if (command === "wt" && args[1] === "new") {
    if (args.length !== 2) return printUnknown(output, args[2] ?? command);
    return runWorktreeNewCommand(output, resolvedDependencies);
  }

  if (command === "sync") {
    if (args.length !== 1) return printUnknown(output, args[1] ?? command);
    return runSyncCommand(output, resolvedDependencies);
  }

  if (command === "wt" && args[1] === "on-event") {
    if (args.length !== 2) return printUnknown(output, args[2] ?? command);
    return runWorktreeEventCommand(resolvedDependencies);
  }

  if (command === "plugin" && args[1] === "install") {
    if (args.length !== 2) return printUnknown(output, args[2] ?? command);
    return runPluginInstallCommand(output, resolvedDependencies);
  }

  return printUnknown(output, command);
};

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
