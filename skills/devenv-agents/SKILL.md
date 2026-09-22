---
name: devenv-agents
description: Integrates the devenv-agents shared module into existing devenv projects. Use when asked to add agent tooling, the project CLI, shared worktree state, Herdr-ready direnv activation, scoped services, or cross-project references to a devenv environment.
license: MIT
compatibility: Requires Git and devenv. The published input uses GitHub over SSH.
---

# Integrate devenv-agents

Add this repository's shared module to an existing devenv project without
replacing project-specific language, package, service, process, or task config.
The module supplies the common agent tooling and worktree environment; the
consumer continues to own its application environment.

## Read first

Always read [`references/integration.md`](references/integration.md) before
editing a consumer.

Read these only when the request needs them:

- [`references/module-contract.md`](references/module-contract.md) — packages,
  environment variables, worktree behavior, tasks, and platform differences.
- [`references/project-declaration.md`](references/project-declaration.md) —
  `.agents/project.toml`, scoped services, and cross-project references.

## Workflow

1. Find the consumer repository root and read its agent instructions.
2. Inspect `devenv.yaml`, `devenv.nix`, `devenv.lock`, `.envrc`, `.gitignore`,
   and `.agents/project.toml` when present. Preserve all unrelated config.
3. If the repository has no devenv configuration, ask whether to initialize it
   before creating files. Do not silently choose a project template.
4. Merge the `agents` input and `agents` import into `devenv.yaml`. Do not
   duplicate existing entries or replace other inputs, imports, or package
   policy.
5. Merge the committed direnv activation into `.envrc` and ensure `.direnv/` is
   ignored. Preserve custom hooks already in either file.
6. Add `agents.session` or `.agents/project.toml` only when the user needs a
   stable session name, main-checkout-only services, or cross-project grants.
   The checkout basename is already the default session.
7. Do not add `project`, Git, GitHub CLI, `just`, Claude Code, Pi, Python,
   `direnv`, or `claude-status-line` to the consumer's packages: the shared
   module owns them. Point out existing duplicates and ask before removing them.
8. Format changed files with the consumer's formatter, then run the bootstrap
   and verification sequence from the integration reference. If a command
   cannot run, report the exact command and blocker instead of claiming success.

## Boundaries

- Use the published SSH input from the repository templates. Do not invent a
  different input name or module path.
- Keep application-specific config in the consumer's `devenv.nix`; importing
  `agents` does not replace it.
- Do not install the Herdr plugin or modify user-level Herdr configuration
  unless the user explicitly asks for Herdr integration.
- `devenv allow` and `direnv allow` are trust decisions. Explain them before
  running them when the user has not already authorized environment setup.
- Never hand-edit generated reference overlays. Change
  `.agents/project.toml`, then run `project sync`.

## Completion

Report:

- files changed;
- whether `devenv.lock` moved the `agents` input;
- bootstrap and verification commands run;
- any optional Herdr or cross-project setup left for the user.
