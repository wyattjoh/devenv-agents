# Consumer integration

## Minimal configuration

Merge these keys into the consumer's existing `devenv.yaml`:

```yaml
inputs:
  agents:
    url: git+ssh://git@github.com/wyattjoh/devenv-agents.git
imports:
  - agents
allowUnfree: true
```

The input name must remain `agents`: the imported module reads
`inputs.agents.packages` to obtain the packaged `project` command, status line,
Claude Code, and Pi. `imports: [agents]` imports the input's root `devenv.nix`;
no import needs to be added to the consumer's `devenv.nix`.

Claude Code and Pi come from the `agents` input's own nixpkgs, so their versions
move with `devenv update agents` rather than with the consumer's `nixpkgs`
input. Do not set `inputs.agents.inputs.nixpkgs.follows`; it pins both back to
the consumer's nixpkgs, which by default is the slower `devenv-nixpkgs/rolling`.

The templates set `allowUnfree: true`. The module no longer needs it for Claude
Code, which the flake admits itself, but keep the key so projects can add unfree
packages of their own. Merge the setting with existing YAML rather than
rewriting the file. Preserve other inputs, imports, and policy keys.

A consumer's `devenv.nix` stays application-specific:

```nix
{ ... }:
{
  languages.javascript = {
    enable = true;
    bun.enable = true;
  };
}
```

Do not redeclare the shared agent packages there. For an explicit session name,
set either `agents.session` in Nix:

```nix
{ ... }:
{
  agents.session = "payments";
}
```

or, preferably when the project also needs scoped services or references, put
it in `.agents/project.toml`:

```toml
session = "payments"
```

Without either setting, the checkout directory basename is used.

## Direnv activation

The committed `.envrc` used by this repository's templates is:

```bash
#!/usr/bin/env bash

eval "$(devenv direnvrc)"

use devenv
```

Merge those commands into an existing `.envrc` instead of discarding custom
logic. Ensure `.gitignore` contains:

```gitignore
.direnv/
```

The module installs direnv's Bash hook inside the long-lived devenv shell. The
committed `.envrc` activates each linked worktree in place, which lets Herdr
observe the foreground agent; do not replace it with an interactive nested
`devenv shell`.

## Bootstrap and verification

After reviewing the changes, initialize trust, update only the new input, warm
the environment noninteractively, and run the module's assertions:

```sh
devenv allow
direnv allow
devenv update agents
devenv shell -- true
devenv test
```

`devenv allow` trusts the devenv project and `direnv allow` trusts the committed
`.envrc`; both are user trust decisions. If either has already been approved,
running it again is harmless but unnecessary.

Commit `devenv.lock`. Updating the shared module later is intentionally scoped:

```sh
devenv update agents
devenv shell -- true
devenv test
```

The module also exposes the same update as a task after the environment loads:

```sh
devenv tasks run project:update
```

## Optional Herdr integration

The devenv import provides the `project` command, but it does not modify the
user's Herdr configuration. When the user explicitly requests managed Herdr
worktrees, install the packaged plugin:

```sh
project plugin install
```

Then create a worktree with:

```sh
project wt create feature/my-change
```

The plugin bootstraps new worktrees with `devenv allow`, `direnv allow`, a
noninteractive `devenv shell -- true` warm, and `project sync`.

## Troubleshooting

- **Unfree package error:** confirm the exact YAML key is
  `allowUnfree: true`.
- **Input fetch fails:** the published template URL uses GitHub over SSH; verify
  that the machine can authenticate to `git@github.com`.
- **Pi absent on Intel macOS:** nixpkgs does not build `pi-coding-agent` for
  `x86_64-darwin`. The flake does not export it there and the module omits it,
  keeping the rest of the environment evaluable.
- **Claude Code or Pi still old after `devenv update`:** both follow the
  `agents` input's `flake.lock`. Confirm `devenv.lock` moved the `agents` node,
  and that `devenv.yaml` does not make the input's nixpkgs follow the
  consumer's.
- **Herdr missing:** Herdr remains a native install under `~/.local/bin`; the
  module adds that directory to `PATH` but does not package Herdr.
- **Stale profile in a running shell:** rerun `devenv shell -- true`; the module
  keeps `$DEVENV_DOTFILE/profile/bin` first so rebuilt tools resolve from the
  stable profile path.

## Repository sources

- `templates/*/devenv.yaml` — published consumer input, import, and unfree policy
- `templates/*/.envrc` and `templates/*/.gitignore` — activation contract
- `devenv.nix` — imported module and verification assertions
- `src/worktree-bootstrap.ts` — worktree bootstrap order
