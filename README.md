# devenv-agents

Project lifecycle tooling for [devenv](https://devenv.sh/) projects and
[Herdr](https://github.com/wyattjoh/herdr) worktrees.

`devenv-agents` provides the `project` command and a Herdr plugin. Together they
create project checkouts, bootstrap linked worktrees, keep declared references
in sync, refresh development environments, and clean up stale worktrees.

## Installation

The recommended installation uses Nix with flakes enabled:

```sh
nix profile install github:wyattjoh/devenv-agents
```

Verify that the command is available:

```sh
project --help
```

To integrate managed worktrees with Herdr, install the included plugin:

```sh
project plugin install
```

The packaged command includes the plugin, project templates, and `direnv`. It
expects `devenv` and Git to be available in the environment where projects are
managed.

## Usage

Add an existing repository and prepare its development environment:

```sh
project add git@github.com:owner/repository.git
```

Create and bootstrap a linked worktree:

```sh
project wt create feature/my-change
```

Run `project --help` to see the complete command list, including project
updates, reference synchronization, worktree adoption, and garbage collection.

## Development

Install the locked Bun dependencies and repository-owned Git hooks:

```sh
bun install --frozen-lockfile
bun run hooks:install
```

Run the same checks used by CI:

```sh
bun test
bun run check
bun run lint
bun run format:check
bun run build
```

Pre-commit hooks run formatting and lint checks against supported staged files. Use
`git commit --no-verify` to bypass them in an emergency. Run `bunx lefthook uninstall`
to remove the installed hook shims while leaving the repository configuration intact.
