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
its Bash hook for in-place activation and the Claude Code CLI, and adds the
flake's `project` package. Because Claude Code is an unfree nixpkgs package,
consumers must set `allowUnfree: true` in `devenv.yaml`. Templates use the
published GitHub input over SSH; CI overlays a local relative input so the
checkout under test is evaluated. Onboarding approves `devenv` first,
then the committed `.envrc` (with `.direnv/` ignored) using `direnv allow`,
and only uses `devenv shell -- true` as a noninteractive warm; it never starts
an interactive nested `devenv shell`. The packaged `project` wrapper supplies
`direnv` before entering devenv; source runs via `bun src/cli.ts` require both
`direnv` and `devenv` on the host `PATH`.

## Commands

Install development tools and lock them locally with `bun install`, then run:

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
is not run by the test suite. Pull requests run the Bun gates above and the
cross-platform template matrix. Dependabot groups weekly patch and minor Bun
updates, keeps Bun majors separate, and groups GitHub Actions updates. Keep
`bun.lock` at lockfile version 0 until Dependabot supports version 2; both
Dependabot's Bun 1.1.39 and current Bun releases can read version 0. A weekly
Actions workflow opens
the Nix lockfile pull request; because it uses
`GITHUB_TOKEN`, its pull-request checks require manual workflow approval.

GitHub Actions must be pinned to full commit SHAs with their release tags in
same-line comments so Dependabot can update both safely. The template workflow
intentionally installs floating `nixpkgs#devenv` as a compatibility canary.

Use Conventional Commits for changes. Do not edit captured fixtures unless a
new protocol probe intentionally replaces them.
