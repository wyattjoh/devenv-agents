# devenv-agents

`devenv-agents` provides the `project` CLI and the Herdr plugin used to manage
projects and linked Git worktrees. The CLI is intentionally built only from
Bun and platform APIs, with no runtime package dependencies.

## Layout

```
src/cli.ts                 # source entrypoint and help/version behavior
src/command-runner.ts      # injectable Herdr, devenv, and systemctl seam
src/testing/git-env.ts     # sanitized Git process boundary
src/testing/git-fixture.ts # temporary repository and linked-worktree helper
fixtures/                  # captured Herdr protocol responses
plugin/                    # packaged Herdr plugin directory
flake.nix                  # Nix packages for project and herdr-plugin
```

The command runner's default implementation spawns real processes. Tests use
its recording implementation instead. Every Git fixture operation goes through
the sanitized spawn helper so inherited `GIT_DIR` and related variables cannot
redirect a test into another repository.

## Commands

Install development tools and lock them locally with `bun install`, then run:

```sh
bun test
bun run check
bun run lint
bun run format
bun run format:check
bun run project -- --help
bun run project -- --version
nix build .#project
nix build .#herdr-plugin
```

`bun run project -- --help` and `bun run project -- --version` execute the
source entrypoint. The Nix build creates the standalone `project` binary but it
is not run by the test suite.

Use Conventional Commits for changes. Do not edit captured fixtures unless a
new protocol probe intentionally replaces them.
