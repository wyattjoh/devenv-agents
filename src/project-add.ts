import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  errorMessage,
  runRequiredCommand,
  runRequiredGitCommand,
  type CommandRunner,
} from "./command-runner.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { assertProjectPluginEnabled } from "./worktree-plugin.ts";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";
import type { SyncReferences } from "./project-sync.ts";

/**
 * Operating systems supported by the project registry.
 */
export type ProjectPlatform = "linux" | "darwin";

/**
 * Templates shipped with devenv-agents for repositories without a devenv file.
 */
export const PROJECT_TEMPLATES = ["bare", "bun-ts", "deno", "rust"] as const;

/**
 * A supported devenv-agents template name.
 */
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

/**
 * One project known to the local fleet.
 */
export type ProjectRegistration = {
  readonly repo: string;
  readonly path: string;
  readonly session: string;
};

/**
 * The parsed forge, organization, and repository components of a project.
 */
export type ProjectRepository = {
  readonly repo: string;
  readonly forge: string;
  readonly organization: string;
  readonly name: string;
  readonly cloneUrl: string;
};

/**
 * Inputs required to add one project without touching process-global state.
 */
export type ProjectAddOptions = {
  readonly repository: string;
  readonly from: string | undefined;
  readonly local: boolean;
  readonly platform: ProjectPlatform;
  readonly homeDirectory: string;
  readonly codeRoot: string | undefined;
  readonly projectsFile: string | undefined;
  readonly systemdUserDirectory: string | undefined;
  readonly templateRoot: string;
  readonly host: string;
  readonly user: string;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
};

/**
 * The result of adding a project and registering its session.
 */
export type ProjectAddResult = {
  readonly registration: ProjectRegistration;
  readonly checkoutCreated: boolean;
  readonly local: boolean;
  readonly unitDropIn: string | undefined;
  readonly projectsFile: string | undefined;
  readonly instructions: string;
};

/**
 * Inputs for enumerating registrations on one operating system.
 */
export type ProjectEnumerationOptions = {
  readonly platform: ProjectPlatform;
  readonly homeDirectory: string;
  readonly projectsFile: string | undefined;
  readonly systemdUserDirectory: string | undefined;
};

/**
 * Options for writing a Linux Herdr systemd drop-in.
 */
export type ProjectDropInOptions = {
  readonly project: ProjectRegistration;
  readonly systemdUserDirectory: string;
};

/**
 * Options for writing the Darwin per-user project registry.
 */
export type ProjectFileOptions = {
  readonly project: ProjectRegistration;
  readonly projectsFile: string;
};

const LOCAL_FILES = [
  ".devenv/",
  "devenv.local.nix",
  "devenv.local.yaml",
  ".claude/settings.local.json",
  ".claude/worktrees/",
] as const;

const DEFAULT_HOST = "strix";
const DEFAULT_TEMPLATE_ROOT = resolve(import.meta.dir, "..", "templates");
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const isProjectTemplate = (value: string): value is ProjectTemplate =>
  PROJECT_TEMPLATES.includes(value as ProjectTemplate);

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const templateHint = (): string =>
  `Available templates: ${PROJECT_TEMPLATES.join(", ")}. Use 'project add ${"<forge>/<org>/<repo>"} --from <template>'.`;

/**
 * Parses and validates a forge/org/repo project identifier.
 *
 * @param value Repository identifier supplied to `project add`.
 * @returns The normalized repository components and clone URL.
 * @throws When the identifier is not exactly forge/org/repo or contains a path traversal segment.
 */
export const parseProjectRepository = (value: string): ProjectRepository => {
  const parts = value.trim().split("/");
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    parts.some((part) => /[\s\\]/u.test(part))
  ) {
    throw new Error(`Repository must be <forge>/<org>/<repo>: ${value}`);
  }
  const [forge, organization, name] = parts as [string, string, string];
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new Error(`Repository name is not safe for a Herdr session: ${name}`);
  }
  const repo = parts.join("/");
  return {
    repo,
    forge,
    organization,
    name,
    cloneUrl: `https://${repo}.git`,
  };
};

const projectCodeRoot = (platform: ProjectPlatform, homeDirectory: string): string =>
  join(homeDirectory, platform === "darwin" ? "Code" : "code");

const projectRegistration = (
  repository: ProjectRepository,
  checkoutPath: string,
  session: string,
): ProjectRegistration => ({
  repo: repository.repo,
  path: checkoutPath,
  session,
});

const projectSession = (repository: ProjectRepository, declaration: ProjectDeclaration): string => {
  const session = declaration.session ?? repository.name;
  if (!SESSION_NAME_PATTERN.test(session)) {
    throw new Error(
      `Project session '${session}' is not safe for Herdr; use letters, numbers, '.', '_' or '-'`,
    );
  }
  return session;
};

const hasDevenvFile = (projectPath: string): boolean =>
  ["devenv.nix", "devenv.yaml", "devenv.yml"].some((file) => existsSync(join(projectPath, file)));

const templatePath = (templateRoot: string, template: string): string => {
  if (!isProjectTemplate(template)) {
    throw new Error(`Unknown devenv template '${template}'. ${templateHint()}`);
  }

  const directory = resolve(templateRoot, template);
  if (!isDirectory(directory)) {
    throw new Error(`Devenv template '${template}' is missing at ${directory}. ${templateHint()}`);
  }
  for (const file of ["devenv.nix", "devenv.yaml"] as const) {
    if (!existsSync(join(directory, file))) {
      throw new Error(`Devenv template '${template}' is missing ${file}. ${templateHint()}`);
    }
  }
  return directory;
};

const ensureCheckout = (
  repository: ProjectRepository,
  checkoutPath: string,
  codeRoot: string,
  runner: CommandRunner,
): boolean => {
  if (existsSync(checkoutPath)) {
    if (!isDirectory(checkoutPath))
      throw new Error(`Checkout path is not a directory: ${checkoutPath}`);
    return false;
  }

  mkdirSync(dirname(checkoutPath), { recursive: true });
  runRequiredGitCommand(
    runner,
    "git clone",
    ["clone", repository.cloneUrl, checkoutPath],
    codeRoot,
  );

  // A recording runner stands in for clone in tests. The real command creates
  // this directory itself; making the postcondition explicit keeps subsequent
  // local-file steps deterministic for either adapter.
  mkdirSync(checkoutPath, { recursive: true });
  return true;
};

const gitDirectory = (projectPath: string): string => {
  const dotGit = join(projectPath, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return dotGit;
    const marker = readFileSync(dotGit, "utf8").trim();
    const target = marker.match(/^gitdir:\s*(.+)$/u)?.[1];
    if (target !== undefined) return resolve(projectPath, target);
  } catch {
    // The clone adapter may be a recording fixture without a .git directory.
  }
  return dotGit;
};

const infoExcludePath = (projectPath: string): string =>
  join(gitDirectory(projectPath), "info", "exclude");

const writeInfoExcludes = (projectPath: string): void => {
  const path = infoExcludePath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/u).filter((line) => line.length > 0));
  let changed = false;
  for (const file of LOCAL_FILES) {
    if (lines.has(file)) continue;
    lines.add(file);
    changed = true;
  }
  if (!changed) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  const additions = LOCAL_FILES.filter((file) => !current.split(/\r?\n/u).includes(file));
  writeFileSync(path, `${prefix}${additions.join("\n")}\n`);
};

const ensureLocalLayer = (projectPath: string): void => {
  const path = join(projectPath, "devenv.local.nix");
  if (!existsSync(path)) writeFileSync(path, "{ ... }: {}\n");
};

const projectsFileRecords = (projectsFile: string): ProjectRegistration[] => {
  if (!existsSync(projectsFile)) return [];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(projectsFile, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse projects file ${projectsFile}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Projects file ${projectsFile} must contain a TOML table`);
  }
  const values = (parsed as { projects?: unknown }).projects;
  if (values === undefined) return [];
  if (!Array.isArray(values))
    throw new Error(`Projects file ${projectsFile} projects must be an array`);

  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as { repo?: unknown; path?: unknown; session?: unknown };
    if (typeof record.repo !== "string" || typeof record.path !== "string") return [];
    return [
      {
        repo: record.repo,
        path: resolve(record.path),
        session: typeof record.session === "string" ? record.session : basename(record.path),
      },
    ];
  });
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const tomlString = (value: string): string => JSON.stringify(value);

const projectFileText = (projects: readonly ProjectRegistration[]): string =>
  projects
    .map((project) =>
      [
        "[[projects]]",
        `repo = ${tomlString(project.repo)}`,
        `path = ${tomlString(project.path)}`,
        `session = ${tomlString(project.session)}`,
        "",
      ].join("\n"),
    )
    .join("\n");

/**
 * Writes or updates the Darwin per-user project registry without duplicates.
 *
 * This function is the supported Darwin registry interface shared by project
 * add, enumeration, and tests that seed registered projects.
 *
 * @param options Project registration and target TOML path.
 * @returns Nothing; the registry is persisted atomically from the caller's perspective.
 */
export const writeProjectsFile = (options: ProjectFileOptions): void => {
  const directory = dirname(options.projectsFile);
  mkdirSync(directory, { recursive: true });
  const existing = projectsFileRecords(options.projectsFile);
  const projects = existing.filter(
    (project) => project.repo !== options.project.repo && project.path !== options.project.path,
  );
  projects.push(options.project);
  const temporaryPath = `${options.projectsFile}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, projectFileText(projects));
    renameSync(temporaryPath, options.projectsFile);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
};

const dropInDirectory = (systemdUserDirectory: string, session: string): string =>
  join(systemdUserDirectory, `herdr@${session}.service.d`);

/**
 * Writes the per-project Linux systemd user-unit registry entry.
 *
 * This function is the supported Linux registry interface shared by project
 * add, enumeration, and tests that seed registered projects.
 *
 * @param options Project registration and systemd user configuration directory.
 * @returns The written drop-in path.
 */
export const writeProjectDropIn = (options: ProjectDropInOptions): string => {
  const directory = dropInDirectory(options.systemdUserDirectory, options.project.session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "project.conf");
  writeFileSync(
    path,
    `[Service]\nWorkingDirectory=${options.project.path}\n# ProjectRepository=${options.project.repo}\n`,
  );
  return path;
};

const systemdProjects = (systemdUserDirectory: string): ProjectRegistration[] => {
  if (!existsSync(systemdUserDirectory)) return [];
  return readdirSync(systemdUserDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const match = /^herdr@(.+)\.service\.d$/u.exec(entry.name);
      if (match === null) return [];
      const path = join(systemdUserDirectory, entry.name, "project.conf");
      if (!existsSync(path)) return [];
      const contents = readFileSync(path, "utf8");
      const workingDirectory = contents.match(/^WorkingDirectory=(.+)$/mu)?.[1];
      if (workingDirectory === undefined || workingDirectory.length === 0) return [];
      const session = match[1] ?? "";
      const repo = contents.match(/^# ProjectRepository=(.+)$/mu)?.[1] ?? session;
      return [{ repo, path: resolve(workingDirectory), session }];
    })
    .toSorted((left, right) => left.repo.localeCompare(right.repo));
};

/**
 * Enumerates registered projects using the host's unit drop-ins or Darwin registry.
 *
 * @param options Platform and injected filesystem roots.
 * @returns Registered projects sorted by repository/session name.
 */
export const enumerateProjects = (
  options: ProjectEnumerationOptions,
): readonly ProjectRegistration[] => {
  if (options.platform === "darwin") {
    return projectsFileRecords(
      options.projectsFile ?? join(options.homeDirectory, ".config", "project", "projects.toml"),
    ).toSorted((left, right) => left.repo.localeCompare(right.repo));
  }
  return systemdProjects(
    options.systemdUserDirectory ?? join(options.homeDirectory, ".config", "systemd", "user"),
  );
};

/**
 * Formats the copy-and-paste attachment instructions printed after a host add.
 *
 * @param project Added project registration.
 * @param host Tailnet SSH and Herdr host name.
 * @param user SSH user name.
 * @returns The phone alias block and Mac machine command.
 */
export const projectAttachInstructions = (
  project: ProjectRegistration,
  host: string = DEFAULT_HOST,
  user: string = "user",
): string =>
  [
    "Phone SSH alias:",
    `Host ${host}-${project.session}`,
    `  HostName ${host}`,
    `  User ${user}`,
    "  RequestTTY force",
    `  RemoteCommand bash -lc 'herdr --session ${project.session}'`,
    "",
    "Mac Herdr machine:",
    `herdr machine add ${host} --label "${host} · ${project.session}" --remote-session ${project.session}`,
    "",
  ].join("\n");

const projectTemplate = (from: string | undefined, templateRoot: string): string | undefined => {
  if (from === undefined) return undefined;
  const directory = templatePath(templateRoot, from);
  return `path:${directory}`;
};

const prepareDevenv = (
  projectPath: string,
  from: string | undefined,
  templateRoot: string,
  runner: CommandRunner,
): void => {
  const template = projectTemplate(from, templateRoot);
  if (hasDevenvFile(projectPath)) {
    runRequiredCommand(runner, "devenv allow", "devenv", ["allow"], {
      cwd: projectPath,
      env: undefined,
    });
    return;
  }
  if (template === undefined) {
    throw new Error(`No devenv files found in ${projectPath}. ${templateHint()}`);
  }
  // `allow` persists the --from binding for later commands in this checkout.
  runRequiredCommand(runner, "devenv template allow", "devenv", ["--from", template, "allow"], {
    cwd: projectPath,
    env: undefined,
  });
};

const registerProject = (
  project: ProjectRegistration,
  options: ProjectAddOptions,
): { readonly unitDropIn: string | undefined; readonly projectsFile: string | undefined } => {
  const useProjectsFile = options.local || options.platform === "darwin";
  if (useProjectsFile) {
    const projectsFile =
      options.projectsFile ?? join(options.homeDirectory, ".config", "project", "projects.toml");
    writeProjectsFile({ project, projectsFile });
    return { unitDropIn: undefined, projectsFile };
  }

  const systemdUserDirectory =
    options.systemdUserDirectory ?? join(options.homeDirectory, ".config", "systemd", "user");
  const unitDropIn = writeProjectDropIn({ project, systemdUserDirectory });
  runRequiredCommand(
    options.runner,
    "systemctl --user daemon-reload",
    "systemctl",
    ["--user", "daemon-reload"],
    { cwd: project.path, env: undefined },
  );
  runRequiredCommand(
    options.runner,
    `systemctl --user enable --now herdr@${project.session}`,
    "systemctl",
    ["--user", "enable", "--now", `herdr@${project.session}`],
    { cwd: project.path, env: undefined },
  );
  return { unitDropIn, projectsFile: undefined };
};

/**
 * Adds one project and prepares its environment using injected external commands.
 *
 * The plugin guard runs before repository parsing or clone setup. Existing
 * checkouts are reused, while new repositories are cloned under the platform's
 * code root. Reference materialization is deliberately delegated to the shared
 * {@link SyncReferences} seam so this module does not own ticket07 behavior.
 *
 * @param options Project identifier, platform paths, and command adapters.
 * @returns The checkout, registration, and attachment instructions.
 */
export const runProjectAdd = (options: ProjectAddOptions): ProjectAddResult => {
  assertProjectPluginEnabled(options.herdrClient);
  const repository = parseProjectRepository(options.repository);
  if (options.from !== undefined) templatePath(options.templateRoot, options.from);
  const codeRoot = resolve(
    options.codeRoot ?? projectCodeRoot(options.platform, options.homeDirectory),
  );
  const checkoutPath = join(codeRoot, repository.forge, repository.organization, repository.name);
  const checkoutCreated = ensureCheckout(repository, checkoutPath, codeRoot, options.runner);

  prepareDevenv(checkoutPath, options.from, options.templateRoot, options.runner);
  runRequiredCommand(options.runner, "direnv allow", "direnv", ["allow"], {
    cwd: checkoutPath,
    env: undefined,
  });
  const declaration: ProjectDeclaration = readProjectDeclaration(checkoutPath);
  const session = projectSession(repository, declaration);
  ensureLocalLayer(checkoutPath);
  writeInfoExcludes(checkoutPath);
  // Warm the profile without opening an interactive nested shell.
  runRequiredCommand(options.runner, "devenv shell -- true", "devenv", ["shell", "--", "true"], {
    cwd: checkoutPath,
    env: undefined,
  });

  options.syncReferences({
    projectRoot: checkoutPath,
    worktreePath: checkoutPath,
    declaration,
  });

  const registration = projectRegistration(repository, checkoutPath, session);
  const { unitDropIn, projectsFile } = registerProject(registration, options);
  return {
    registration,
    checkoutCreated,
    local: options.local || options.platform === "darwin",
    unitDropIn,
    projectsFile,
    instructions: projectAttachInstructions(registration, options.host, options.user),
  };
};

/**
 * Returns the default add roots used by the CLI when no test override is supplied.
 *
 * @returns Stable host paths for the current user's home directory.
 */
export const defaultProjectRoots = (): {
  readonly homeDirectory: string;
  readonly templateRoot: string;
} => ({ homeDirectory: homedir(), templateRoot: DEFAULT_TEMPLATE_ROOT });

/**
 * Returns a human-readable hint for the supported templates.
 *
 * @returns The template list and command shape.
 */
export const projectTemplateHint = (): string => templateHint();
