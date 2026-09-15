import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The declaration file consumed by the project module and bootstrap tooling.
 */
export const PROJECT_DECLARATION_PATH = ".agents/project.toml";

/**
 * A grant that can be materialized from a referenced project.
 */
type ReferenceGrant = "tree" | "module" | "services";

/**
 * One declared cross-project reference and its allowed grants.
 */
type ProjectReference = {
  readonly repo: string;
  readonly grant: readonly ReferenceGrant[];
};

/**
 * The normalized project declaration used by setup and future sync adapters.
 */
export type ProjectDeclaration = {
  readonly session: string | undefined;
  readonly scopedServices: readonly string[];
  readonly references: readonly ProjectReference[];
};

const EMPTY_DECLARATION: ProjectDeclaration = {
  session: undefined,
  scopedServices: [],
  references: [],
};

const REFERENCE_GRANTS: readonly ReferenceGrant[] = ["tree", "module", "services"];

type ProjectDeclarationValue =
  | string
  | readonly ProjectDeclarationValue[]
  | ProjectDeclarationRecord;

type ProjectDeclarationRecord = { readonly [key: string]: ProjectDeclarationValue | undefined };

const isRecord = (value: unknown): value is ProjectDeclarationRecord =>
  value !== null && !Array.isArray(value) && value === Object(value);

const isString = (value: unknown): value is string => value === String(value);

const readString = (record: ProjectDeclarationRecord, key: string): string | undefined => {
  const value = record[key];

  if (value === undefined) return undefined;

  if (!isString(value)) throw new Error(`Project declaration field '${key}' must be a string`);

  return value;
};

const readStringArray = (value: ProjectDeclarationValue | undefined, field: string): string[] => {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.some((item) => !isString(item))) {
    throw new Error(`Project declaration field '${field}' must be an array of strings`);
  }

  return [...value];
};

const isReferenceGrant = (value: string): value is ReferenceGrant =>
  REFERENCE_GRANTS.some((grant) => grant === value);

const readGrants = (value: ProjectDeclarationValue | undefined): ReferenceGrant[] => {
  const values = Array.isArray(value) ? value : [value];

  if (values.length === 1 && values[0] === undefined) return [];

  if (values.some((item) => !isString(item) || !isReferenceGrant(item))) {
    throw new Error("Project declaration reference grant must be tree, module, or services");
  }

  return values;
};

const readReferences = (value: ProjectDeclarationValue | undefined): ProjectReference[] => {
  if (value === undefined) return [];

  if (!Array.isArray(value)) throw new Error("Project declaration references must be an array");

  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Project declaration reference ${index} must be a table`);
    const repo = readString(entry, "repo");

    if (repo === undefined || repo.length === 0) {
      throw new Error(`Project declaration reference ${index} requires repo`);
    }

    return { repo, grant: readGrants(entry.grant) };
  });
};

/**
 * Reads and normalizes `.agents/project.toml` from a project checkout.
 *
 * An absent declaration is an empty declaration so setup can safely perform a
 * no-reference sync. Malformed declarations fail closed with a descriptive error.
 *
 * @param projectRoot Checkout whose declaration should be read.
 * @returns The normalized declaration.
 */
export const readProjectDeclaration = (projectRoot: string): ProjectDeclaration => {
  const path = join(projectRoot, PROJECT_DECLARATION_PATH);

  if (!existsSync(path)) return { ...EMPTY_DECLARATION };

  // SAFETY: TOML parsing accepts arbitrary source text and is validated below.
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as unknown;

  if (!isRecord(parsed)) throw new Error("Project declaration must be a TOML table");

  const services = parsed.services;

  if (services !== undefined && !isRecord(services)) {
    throw new Error("Project declaration services must be a TOML table");
  }

  const session = readString(parsed, "session");
  const scopedServices = readStringArray(services?.scoped, "services.scoped");

  return {
    session,
    scopedServices,
    references: readReferences(parsed.references),
  };
};
