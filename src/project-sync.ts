import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  defaultCommandRunner,
  errorMessage,
  runRequiredCommand,
  type CommandRunner,
} from "./command-runner.ts";
import { readProjectDeclaration, type ProjectDeclaration } from "./project-declaration.ts";
import { resolveMainCheckout } from "./workspace.ts";
import type { SyncReferences, SyncRequest } from "./worktree-setup.ts";

/** The local Claude settings file populated by tree grants. */
export const CLAUDE_LOCAL_SETTINGS_PATH = join(".claude", "settings.local.json");

/** The local devenv overlay populated by module grants. */
export const DEVENV_LOCAL_YAML_PATH = "devenv.local.yaml";

/** The shared environment file populated by service grants. */
export const REFERENCES_ENV_PATH = join(".devenv", "state", "references.env");

/** The fallback host for services running on the same machine. */
export const DEFAULT_SERVICE_HOST = "localhost";

/** A resolved endpoint for one scoped service. */
export type ServiceEndpoint = {
  readonly host: string;
  readonly port: number;
};

/**
 * Optional adapter for resolving one service endpoint.
 *
 * The default implementation evaluates the sibling's `processes` attribute
 * through devenv, while tests can provide deterministic endpoint data without
 * starting a development environment.
 */
export type ServiceEndpointResolver = (
  projectRoot: string,
  serviceName: string,
  runner: CommandRunner,
) => ServiceEndpoint;

/** Dependencies that vary while materializing one project's references. */
export type ProjectSyncOptions = {
  readonly codeRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly resolveServiceEndpoint?: ServiceEndpointResolver;
};

/** The result of a successful reference synchronization. */
export type ProjectSyncResult = {
  readonly treeDirectories: readonly string[];
  readonly moduleInputs: readonly string[];
  readonly serviceEndpoints: readonly string[];
  readonly missingReferences: readonly string[];
};

/** Options for invoking `project sync` from a checkout path. */
export type ProjectSyncCommandOptions = {
  readonly worktreePath: string;
  readonly runner: CommandRunner;
  readonly syncReferences?: SyncReferences;
};

/** One checkout that could not be found under the machine's code root. */
export type MissingReferencedCheckout = {
  readonly repo: string;
  readonly path: string;
};

/**
 * Error reported after all available references have been materialized.
 *
 * Missing checkouts are kept together so one sync reports every unavailable
 * sibling rather than stopping at the first declaration entry.
 */
export class MissingReferencedCheckoutsError extends Error {
  readonly missingReferences: readonly MissingReferencedCheckout[];

  constructor(missingReferences: readonly MissingReferencedCheckout[]) {
    const details = missingReferences
      .map(({ repo, path }) => `- ${repo} (expected at ${path})`)
      .join("\n");
    super(`Missing referenced checkouts:\n${details}`);
    this.name = "MissingReferencedCheckoutsError";
    this.missingReferences = [...missingReferences];
  }
}

type JsonRecord = Record<string, unknown>;

type ResolvedReference = {
  readonly repo: string;
  readonly name: string;
  readonly path: string;
  readonly grant: ProjectDeclaration["references"][number]["grant"];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: JsonRecord | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const readRecord = (record: JsonRecord | undefined, key: string): JsonRecord | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const ensureParent = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const normalizedRepoParts = (repo: string): readonly string[] => {
  if (
    repo.length === 0 ||
    isAbsolute(repo) ||
    /^[A-Za-z]:[\\/]/.test(repo) ||
    repo.startsWith("\\\\")
  ) {
    throw new Error(`Project reference repo must be a relative path: ${repo}`);
  }
  const parts = repo.split(/[\\/]/);
  if (parts.some((part) => part === "..")) {
    throw new Error(`Project reference repo must stay under the code root: ${repo}`);
  }
  const last = parts.at(-1);
  if (last === undefined || parts.some((part) => part.length === 0 || part === ".")) {
    throw new Error(`Project reference repo must use forge/org/repo: ${repo}`);
  }
  const normalizedLast = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (normalizedLast.length === 0 || parts.length !== 3) {
    throw new Error(`Project reference repo must use forge/org/repo: ${repo}`);
  }
  return [...parts.slice(0, -1), normalizedLast];
};

const referenceName = (repo: string): string => {
  const last = normalizedRepoParts(repo).at(-1);
  if (last === undefined) throw new Error(`Project reference repo is invalid: ${repo}`);
  const name = last.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (name.length === 0) throw new Error(`Project reference repo has no usable name: ${repo}`);
  return name;
};

const environmentName = (value: string): string => {
  const name = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (name.length === 0) throw new Error(`Cannot derive an environment name from '${value}'`);
  return name.toUpperCase();
};

const machineCodeRoot = (options: ProjectSyncOptions): string => {
  if (options.codeRoot !== undefined) return resolve(options.codeRoot);
  const home = resolve(options.homeDirectory ?? homedir());
  return join(home, options.platform === "darwin" ? "Code" : "code");
};

const resolveReference = (
  codeRoot: string,
  reference: ProjectDeclaration["references"][number],
): ResolvedReference => {
  const parts = normalizedRepoParts(reference.repo);
  const path = resolve(codeRoot, ...parts);
  return {
    repo: reference.repo,
    name: referenceName(reference.repo),
    path,
    grant: reference.grant,
  };
};

const mergeResolvedReferences = (references: readonly ResolvedReference[]): ResolvedReference[] => {
  const merged = new Map<string, ResolvedReference>();
  for (const reference of references) {
    const previous = merged.get(reference.path);
    if (previous === undefined) {
      merged.set(reference.path, reference);
      continue;
    }
    const grant = [
      ...new Set([...previous.grant, ...reference.grant]),
    ] as ResolvedReference["grant"];
    merged.set(reference.path, { ...previous, grant });
  }
  return [...merged.values()];
};

const isPathWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const resolveReferences = (
  codeRoot: string,
  references: readonly ProjectDeclaration["references"][number][],
): {
  readonly available: readonly ResolvedReference[];
  readonly missing: readonly ResolvedReference[];
} => {
  const resolved = mergeResolvedReferences(
    references.map((reference) => resolveReference(codeRoot, reference)),
  );
  let canonicalCodeRoot: string;
  try {
    canonicalCodeRoot = realpathSync(codeRoot);
  } catch {
    canonicalCodeRoot = resolve(codeRoot);
  }

  const available: ResolvedReference[] = [];
  const missing: ResolvedReference[] = [];
  for (const reference of resolved) {
    if (!isDirectory(reference.path)) {
      missing.push(reference);
      continue;
    }
    const canonicalPath = realpathSync(reference.path);
    if (!isPathWithin(canonicalCodeRoot, canonicalPath)) {
      throw new Error(
        `Project reference checkout '${reference.repo}' escapes the code root: ${reference.path} -> ${canonicalPath}`,
      );
    }
    available.push({ ...reference, path: canonicalPath });
  }
  return {
    available: mergeResolvedReferences(available),
    missing: mergeResolvedReferences(missing),
  };
};

const validateIdentityCollisions = (references: readonly ResolvedReference[]): void => {
  for (const grant of ["module", "services"] as const) {
    const identities = new Map<string, ResolvedReference>();
    for (const reference of references) {
      if (!reference.grant.includes(grant)) continue;
      const previous = identities.get(reference.name);
      if (previous !== undefined && previous.path !== reference.path) {
        throw new Error(
          `Project reference ${grant} identity collision: '${previous.repo}' and '${reference.repo}' both map to '${reference.name}'`,
        );
      }
      identities.set(reference.name, reference);
    }
  }
};

const uniqueBy = <T>(values: readonly T[], key: (value: T) => string): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const valueKey = key(value);
    if (seen.has(valueKey)) return false;
    seen.add(valueKey);
    return true;
  });
};

const readJsonObject = (path: string, label: string): JsonRecord => {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${label} ${path}: ${errorMessage(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object: ${path}`);
  return parsed;
};

const stringArray = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
};

const writeClaudeSettings = (worktreePath: string, directories: readonly string[]): void => {
  const path = join(worktreePath, CLAUDE_LOCAL_SETTINGS_PATH);
  const settings = readJsonObject(path, "Claude local settings");
  const permissionsValue = settings.permissions;
  if (permissionsValue !== undefined && !isRecord(permissionsValue)) {
    throw new Error(`Claude local settings permissions must be an object: ${path}`);
  }
  const permissions = permissionsValue === undefined ? {} : permissionsValue;
  const existing = stringArray(permissions.additionalDirectories, "Claude additionalDirectories");
  const additionalDirectories = uniqueBy([...existing, ...directories], (directory) => directory);
  const updated = {
    ...settings,
    permissions: {
      ...permissions,
      additionalDirectories,
    },
  };
  ensureParent(path);
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
};

const readYamlObject = (path: string): JsonRecord | undefined => {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse devenv local YAML ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error(`devenv local YAML must contain an object: ${path}`);
  return parsed;
};

const writeYamlObject = (path: string, value: JsonRecord): void => {
  const yaml = Bun.YAML.stringify(value, undefined, 2).replaceAll(/[ \t]+\n/g, "\n");
  ensureParent(path);
  writeFileSync(path, `${yaml.trimEnd()}\n`, "utf8");
};

const managedReferenceName = (value: string): boolean => value.startsWith("ref-");

const reconcileDevenvOverlay = (
  worktreePath: string,
  references: readonly ResolvedReference[],
): void => {
  const path = join(worktreePath, DEVENV_LOCAL_YAML_PATH);
  const existing = readYamlObject(path);
  if (existing === undefined && references.length === 0) return;

  const updated: JsonRecord = existing === undefined ? {} : { ...existing };
  const existingInputs = existing?.inputs;
  if (existingInputs !== undefined && !isRecord(existingInputs)) {
    throw new Error(`devenv local YAML inputs must be an object: ${path}`);
  }
  const inputEntries = Object.entries(existingInputs ?? {}).filter(
    ([name]) => !managedReferenceName(name),
  );
  const managedInputsPreviouslyPresent = Object.keys(existingInputs ?? {}).some(
    managedReferenceName,
  );
  const inputs: JsonRecord = Object.fromEntries(inputEntries);
  for (const reference of references) {
    inputs[`ref-${reference.name}`] = {
      url: `path:${reference.path}`,
      flake: false,
    };
  }
  if (
    Object.keys(inputs).length > 0 ||
    (existingInputs !== undefined && !managedInputsPreviouslyPresent)
  ) {
    updated.inputs = inputs;
  } else {
    delete updated.inputs;
  }

  const existingImports = existing?.imports;
  const imports = stringArray(existingImports, "devenv local YAML imports");
  const managedImportsPreviouslyPresent = imports.some(managedReferenceName);
  if (
    references.length === 0 &&
    !managedInputsPreviouslyPresent &&
    !managedImportsPreviouslyPresent
  ) {
    return;
  }
  const reconciledImports = uniqueBy(
    [
      ...imports.filter((name) => !managedReferenceName(name)),
      ...references.map((reference) => `ref-${reference.name}`),
    ],
    (name) => name,
  );
  if (
    reconciledImports.length > 0 ||
    (existingImports !== undefined && !managedImportsPreviouslyPresent)
  ) {
    updated.imports = reconciledImports;
  } else {
    delete updated.imports;
  }

  if (Object.keys(updated).length === 0) {
    if (existing !== undefined) unlinkSync(path);
    return;
  }
  writeYamlObject(path, updated);
};

const shellScalar = (value: string): string => {
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

const managedEnvironmentLine = (line: string): boolean =>
  /^export REF_[A-Z0-9_]+_(?:HOST|PORT)=/.test(line);

const reconcileReferencesEnvironment = (
  projectRoot: string,
  endpoints: readonly {
    readonly name: string;
    readonly service: string;
    readonly endpoint: ServiceEndpoint;
  }[],
): void => {
  const path = join(projectRoot, REFERENCES_ENV_PATH);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const generated = endpoints.flatMap(({ name, service, endpoint }) => {
    const prefix = `REF_${environmentName(name)}_${environmentName(service)}`;
    return [
      `export ${prefix}_HOST=${shellScalar(endpoint.host)}`,
      `export ${prefix}_PORT=${endpoint.port}`,
    ];
  });
  if (existing === undefined && generated.length === 0) return;

  const existingLines = existing === undefined ? [] : existing.split(/\r?\n/);
  const preservedLines = existingLines.filter((line) => !managedEnvironmentLine(line));
  const hadManagedLines = preservedLines.length !== existingLines.length;
  while (preservedLines.at(-1) === "") preservedLines.pop();

  if (generated.length === 0 && preservedLines.length === 0) {
    if (hadManagedLines) unlinkSync(path);
    return;
  }
  if (!hadManagedLines && generated.length === 0) return;

  const lines = [
    ...preservedLines,
    ...(preservedLines.length > 0 && generated.length > 0 ? [""] : []),
    ...generated,
    "",
  ];
  ensureParent(path);
  writeFileSync(path, lines.join("\n"), "utf8");
};

const parseJsonOutput = (stdout: string): JsonRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`devenv eval processes returned invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed))
    throw new Error("devenv eval processes returned a JSON value, not an object");
  return parsed;
};

const portNumber = (value: unknown): number | undefined => {
  const candidate =
    typeof value === "number" || typeof value === "string"
      ? value
      : isRecord(value)
        ? (value.value ?? value.port)
        : undefined;
  const port = typeof candidate === "string" ? Number(candidate) : candidate;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    return undefined;
  return port;
};

const stringFromKeys = (
  record: JsonRecord | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

const serviceProcess = (output: JsonRecord, serviceName: string): JsonRecord | undefined => {
  const result = readRecord(output, "result");
  const processes =
    readRecord(output, "processes") ?? readRecord(result, "processes") ?? result ?? output;
  const process = readRecord(processes, serviceName);
  const services = readRecord(output, "services") ?? readRecord(result, "services");
  const service = readRecord(services, serviceName);
  if (process !== undefined && service !== undefined) return { ...service, ...process };
  return process ?? service;
};

const endpointFromProcess = (
  output: JsonRecord,
  serviceName: string,
): ServiceEndpoint | undefined => {
  const process = serviceProcess(output, serviceName);
  if (process === undefined) return undefined;
  const ports = readRecord(process, "ports");
  const mainPort = ports?.main;
  const port =
    portNumber(mainPort) ??
    (ports === undefined
      ? undefined
      : Object.values(ports)
          .map(portNumber)
          .find((candidate): candidate is number => candidate !== undefined)) ??
    portNumber(process.port) ??
    portNumber(process.value);
  if (port === undefined) return undefined;
  const host =
    stringFromKeys(mainPort && isRecord(mainPort) ? mainPort : undefined, [
      "host",
      "hostname",
      "address",
    ]) ??
    stringFromKeys(process, ["host", "hostname", "listen_address", "listenAddress", "address"]) ??
    DEFAULT_SERVICE_HOST;
  return { host, port };
};

const evaluateProcessOutput = (projectRoot: string, runner: CommandRunner): JsonRecord => {
  const result = runRequiredCommand(
    runner,
    "devenv eval processes",
    "devenv",
    ["eval", "processes"],
    { cwd: projectRoot, env: undefined },
  );
  return parseJsonOutput(result.stdout);
};

const defaultServiceEndpointResolver = (
  processOutput: JsonRecord,
  projectRoot: string,
  serviceName: string,
): ServiceEndpoint => {
  const endpoint = endpointFromProcess(processOutput, serviceName);
  if (endpoint !== undefined) return endpoint;
  throw new Error(
    `Referenced service '${serviceName}' in ${projectRoot} has no allocated TCP port in devenv processes`,
  );
};

const validatedEndpoint = (
  endpoint: ServiceEndpoint,
  projectRoot: string,
  serviceName: string,
): ServiceEndpoint => {
  if (typeof endpoint.host !== "string" || endpoint.host.length === 0) {
    throw new Error(`Referenced service '${serviceName}' in ${projectRoot} has no host`);
  }
  const port = portNumber(endpoint.port);
  if (port === undefined) {
    throw new Error(`Referenced service '${serviceName}' in ${projectRoot} has an invalid port`);
  }
  return { host: endpoint.host, port };
};

const materializeServices = (
  references: readonly ResolvedReference[],
  options: ProjectSyncOptions,
): readonly {
  readonly name: string;
  readonly service: string;
  readonly endpoint: ServiceEndpoint;
}[] => {
  const runner = options.runner ?? defaultCommandRunner;
  const outputByProject = new Map<string, JsonRecord>();
  const endpoints: {
    readonly name: string;
    readonly service: string;
    readonly endpoint: ServiceEndpoint;
  }[] = [];

  for (const reference of references) {
    if (!reference.grant.includes("services")) continue;
    const declaration = readProjectDeclaration(reference.path);
    for (const serviceName of declaration.scopedServices) {
      let endpoint: ServiceEndpoint;
      if (options.resolveServiceEndpoint !== undefined) {
        endpoint = options.resolveServiceEndpoint(reference.path, serviceName, runner);
      } else {
        let processOutput = outputByProject.get(reference.path);
        if (processOutput === undefined) {
          processOutput = evaluateProcessOutput(reference.path, runner);
          outputByProject.set(reference.path, processOutput);
        }
        endpoint = defaultServiceEndpointResolver(processOutput, reference.path, serviceName);
      }
      endpoints.push({
        name: reference.name,
        service: serviceName,
        endpoint: validatedEndpoint(endpoint, reference.path, serviceName),
      });
    }
  }

  return endpoints;
};

/**
 * Materializes all declared references for one worktree.
 *
 * Tree and module files are written below `worktreePath`; service endpoints
 * are written in the main checkout's shared state. Missing sibling checkouts
 * are collected and reported only after every available reference is written.
 *
 * @param request Project root, worktree path, and normalized declaration.
 * @param suppliedOptions Machine and command dependencies.
 * @returns Materialized paths when all declared checkouts are available.
 * @throws {@link MissingReferencedCheckoutsError} after partial materialization.
 */
export const syncProjectReferences = (
  request: SyncRequest,
  suppliedOptions: ProjectSyncOptions = {},
): ProjectSyncResult => {
  const options: ProjectSyncOptions = suppliedOptions;
  const references = request.declaration.references;
  if (references.length === 0) {
    reconcileDevenvOverlay(request.worktreePath, []);
    reconcileReferencesEnvironment(request.projectRoot, []);
    return {
      treeDirectories: [],
      moduleInputs: [],
      serviceEndpoints: [],
      missingReferences: [],
    };
  }

  const codeRoot = machineCodeRoot(options);
  const { available: availableReferences, missing: missingReferences } = resolveReferences(
    codeRoot,
    references,
  );
  validateIdentityCollisions([...availableReferences, ...missingReferences]);

  const treeDirectories = uniqueBy(
    availableReferences
      .filter((reference) => reference.grant.includes("tree"))
      .map((reference) => reference.path),
    (path) => path,
  );
  if (treeDirectories.length > 0) writeClaudeSettings(request.worktreePath, treeDirectories);

  const moduleReferences = uniqueBy(
    availableReferences.filter((reference) => reference.grant.includes("module")),
    (reference) => reference.path,
  );
  reconcileDevenvOverlay(request.worktreePath, moduleReferences);

  const serviceEndpoints = materializeServices(availableReferences, options);
  reconcileReferencesEnvironment(request.projectRoot, serviceEndpoints);

  const result: ProjectSyncResult = {
    treeDirectories,
    moduleInputs: moduleReferences.map((reference) => reference.name),
    serviceEndpoints: serviceEndpoints.map(({ name, service }) => `${name}:${service}`),
    missingReferences: missingReferences.map(({ repo }) => repo),
  };
  if (missingReferences.length > 0) throw new MissingReferencedCheckoutsError(missingReferences);
  return result;
};

/** Creates a setup seam adapter with stable machine/runner dependencies. */
export const createSyncReferences =
  (options: ProjectSyncOptions = {}): SyncReferences =>
  (request) => {
    syncProjectReferences(request, options);
  };

/** The default materializing adapter used by setup and CLI commands. */
export const syncReferences: SyncReferences = createSyncReferences();

/**
 * Resolves a checkout from the current path and runs the materializing sync.
 *
 * @param options Current worktree, runner, and optional injected sync adapter.
 */
export const runProjectSync = (options: ProjectSyncCommandOptions): void => {
  const projectRoot = resolveMainCheckout(options.worktreePath, options.runner);
  const declaration = readProjectDeclaration(projectRoot);
  const sync = options.syncReferences ?? createSyncReferences({ runner: options.runner });
  sync({
    projectRoot,
    worktreePath: options.worktreePath,
    declaration,
  });
};
