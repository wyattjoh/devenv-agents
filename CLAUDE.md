# devenv-agents

`devenv-agents` provides the `project` CLI and the Herdr plugin used to manage
projects and linked Git worktrees. The CLI is intentionally built only from
Bun and platform APIs, with no runtime package dependencies.

## Layout

```
Devenv files:
devenv.nix                              # shared project/worktree environment module
templates/                             # bun-ts, rust, bare and deno starter environments
.github/workflows/templates.yml        # cross-platform template evaluation

Automation:
.github/workflows/ci.yml                # Bun tests, checks, lint, formatting and build
.github/workflows/update-flake-lock.yml # weekly Nix lockfile pull request
.github/dependabot.yml                  # weekly Bun and GitHub Actions updates

CLI and tests:
src/cli.ts                 # source entrypoint and help/version behavior
src/command-runner.ts      # injectable command seam and Git environment sanitization
src/testing/cli.ts         # shared CLI dependency and output test helpers
src/testing/command-runner.ts # recording command runner adapter for tests
src/testing/git-env.ts     # sanitized Git process helper for tests
src/testing/git-fixture.ts # temporary repository and linked-worktree helper
tests/module-shell.test.sh # shell assertions for the worktree environment
fixtures/                  # captured Herdr protocol responses
plugin/                    # packaged Herdr plugin directory
flake.nix                  # Nix packages for project and herdr-plugin
```

The command runner's default implementation spawns real processes. Tests use
its recording implementation instead. Every Git fixture operation goes through
the sanitized spawn helper so inherited `GIT_DIR` and related variables cannot
redirect a test into another repository.

The shared `devenv.nix` module is imported by projects through an `agents`
input. It owns the project/worktree environment layout, provides `direnv` with
its Bash hook for in-place activation, and adds the flake's `project` package.
It is also the single definition of the agent tooling every project shares:
the Claude Code CLI, Pi, and the `claude-status-line` wrapper this flake builds
from a pinned `claude-status-line` source input. Consumers declare none of the
three. Pi comes from the consumer's nixpkgs, so upgrading it is a nixpkgs bump
rather than an edit in each project. It also provides `python3`, which Herdr's
Claude integration hook execs; without it the hook exits silently and a running
Claude is never reported as an agent. Because Claude Code is an unfree nixpkgs
package, consumers must set `allowUnfree: true` in `devenv.yaml`. Claude Code
comes from nixpkgs rather than the native self-updating installer because that
installer ships a generic dynamically-linked binary that NixOS cannot execute
without `nix-ld`. Herdr stays native under `~/.local/bin`, which the module
appends to `PATH` behind the stable project profile. Templates use the
published GitHub input over SSH; CI overlays a local relative input so the
checkout under test is evaluated. Onboarding approves `devenv` first,
then the committed `.envrc` (with `.direnv/` ignored) using `direnv allow`,
and only uses `devenv shell -- true` as a noninteractive warm; it never starts
an interactive nested `devenv shell`. The packaged `project` wrapper supplies
`direnv` before entering devenv; source runs via `bun src/cli.ts` require both
`direnv` and `devenv` on the host `PATH`.

The module also defines `enterTest`, so `devenv test` asserts the invariants
every consumer depends on: the `AGENTS_*` variables, the per-language state
directories under `.devenv/state`, the fixed `PATH` prefix order, the tools the
module puts on `PATH`, and the Linux host-layer config paths. Keep these
assertions consumer-agnostic. Fixture-specific behavior -- scoped services, the
direnv prompt cycle, and Darwin's caller-preserved config paths -- belongs in
`tests/module-shell.test.sh`, which supplies its own two-checkout fixture. On
devenv 2.x the `devenv:enterTest` task carries no command and the `enterTest`
string is what actually runs; a non-zero exit there fails `devenv test`.

## Commands

Install development tools with `bun install --frozen-lockfile`, then run:

```sh
bun install --frozen-lockfile
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
is not run by the test suite, but CI builds `.#herdr-plugin` directly and
reaches `.#project` through the template matrix, which reuses it as the `agents`
input. Pull requests run the Bun gates above and the cross-platform template
matrix, where each template runs `devenv test` so the module's `enterTest`
assertions cover both Linux and macOS. Dependabot groups weekly patch and minor Bun
updates, keeps Bun majors separate, and groups GitHub Actions updates.

Let Dependabot own `bun.lock`. It runs Bun 1.1.39, which reads only lockfile
version 0, while Bun 1.4 and later always rewrite the file to version 1 with a
`configVersion` key and nested dependency entries, and expose no flag to pin the
version. Any lockfile-writing Bun command run locally -- including a bare
`bun install`, not just `bun add` and `bun update` -- therefore breaks
Dependabot's parser and silently stops its Bun pull requests. Always pass
`--frozen-lockfile`, which installs without touching the file. Upgrading a Bun
dependency by hand means accepting version 1 and retiring the `bun` ecosystem
from `.github/dependabot.yml`; make that a deliberate change, not a side effect
of running the wrong command.

A weekly Actions workflow opens the Nix lockfile pull request; because it uses
`GITHUB_TOKEN`, its pull-request checks require manual workflow approval. That
approval is now load-bearing: `main` carries a branch ruleset requiring the
`Bun` check and all eight template cells, so an unapproved run leaves the
lockfile pull request unmergeable rather than merely unchecked.

The ruleset lives in repository settings, not in this tree -- GitHub has no
in-repo format for branch protection. It requires a pull request with zero
approvals, since a solo repository cannot approve its own, and blocks branch
deletion and force pushes. The repository owner is the only bypass actor, so
direct pushes to `main` remain possible when a change does not warrant a pull
request. Renaming a CI job breaks the required-check contexts, which are matched
by name; update the ruleset in the same change.

GitHub Actions must be pinned to full commit SHAs with their release tags in
same-line comments so Dependabot can update both safely. The template workflow
intentionally installs floating `nixpkgs#devenv` as a compatibility canary.

Use Conventional Commits for changes. Do not edit captured fixtures unless a
new protocol probe intentionally replaces them.
