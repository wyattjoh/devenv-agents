# Project declaration and references

`.agents/project.toml` is optional. Use it only when the checkout needs a stable
session name, services restricted to the main checkout, or grants from sibling
projects.

## Complete shape

```toml
session = "payments"

[services]
scoped = ["postgres", "redis"]

[[references]]
repo = "github.com/acme/platform"
grant = ["tree", "module", "services"]

[[references]]
repo = "github.com/acme/design-system"
grant = ["tree"]
```

All fields are optional. Unknown grant values fail closed.

## Fields

### `session`

Provides the default for `agents.session` and therefore `AGENTS_SESSION`; an
explicit `agents.session` value in `devenv.nix` takes precedence. Without
either setting, the module uses the checkout basename. Use a stable, shell-safe
project identity; the lifecycle tooling rejects unsafe session names where they
would become service or workspace identifiers.

### `services.scoped`

Names devenv services that should run only from the main checkout. Every entry
must match a service attribute such as `services.postgres`. The imported module
force-disables those services in linked worktrees.

When another project receives the `services` grant, `project sync` inspects
these named services with `devenv eval processes` and exports their allocated
TCP endpoints.

### `references`

Each `repo` is a sibling checkout identifier with exactly three path segments:

```text
forge/owner/repository
```

A trailing `.git` on the repository segment is accepted. Absolute paths,
`.`/`..`, and paths outside the machine's code root are rejected. The default
code root is `~/Code` on Darwin and `~/code` on Linux.

A reference can grant one or more capabilities:

| Grant      | Materialized result                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `tree`     | Adds the sibling checkout to `.claude/settings.local.json` under `permissions.additionalDirectories`            |
| `module`   | Adds a local `path:` input and import to `devenv.local.yaml`                                                    |
| `services` | Writes `REF_<PROJECT>_<SERVICE>_HOST` and `_PORT` exports to the main checkout's `.devenv/state/references.env` |

`project sync` owns those generated entries. Preserve unrelated content in the
same files, but do not edit generated `ref-*` inputs/imports or `REF_*_HOST` and
`REF_*_PORT` lines by hand.

## Apply changes

After adding or changing references, run from the consumer checkout:

```sh
project sync
devenv shell -- true
```

The sync operation materializes every available reference, collects missing
checkouts, then reports all missing repositories together. Fix the checkouts or
declaration and rerun it; do not patch the partial generated state manually.

For lifecycle-managed projects, these commands also synchronize references:

```sh
project worktree-setup
project wt create feature/my-change
project adopt-worktrees
```

## Naming of service variables

Repository and service names are uppercased and non-alphanumeric runs become
underscores. For example, this declaration:

```toml
[[references]]
repo = "github.com/acme/platform-api"
grant = ["services"]
```

with the referenced project's scoped `postgres` service produces:

```text
REF_PLATFORM_API_POSTGRES_HOST
REF_PLATFORM_API_POSTGRES_PORT
```

## Repository sources

- `src/project-declaration.ts` — TOML parser and validation
- `src/project-sync.ts` — grant materialization and generated-file ownership
- `devenv.nix` — session fallback, scoped-service behavior, and env loading
