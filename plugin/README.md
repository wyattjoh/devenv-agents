# Project worktrees Herdr plugin

This directory is the manifest-only Herdr plugin shipped with `devenv-agents`.
It invokes the `project` CLI for worktree lifecycle events and provides the
`setup` overlay used to bootstrap managed linked worktrees.

Project templates use a committed `.envrc` with `use devenv` and ignore
`.direnv/`, so activation is applied in place through direnv and Herdr can
observe the foreground agent.
Bootstrap approves `devenv` and direnv, then performs the existing
noninteractive `devenv shell -- true` warm before syncing references; it does
not launch an interactive nested devenv shell. The packaged `project` wrapper
adds `direnv` to its PATH; source-CLI runs require host `direnv` and `devenv`.

The plugin has no build step or runtime dependencies. Link it with:

```sh
project plugin install
```

## Worktree keybinding

Herdr keybindings live in the user's config rather than in a plugin manifest. To
make `prefix+shift+g` create a managed worktree through this CLI, add this
fragment to `~/.config/herdr/config.toml` and reload the configuration:

```toml
[[keys.command]]
key = "prefix+shift+g"
type = "pane"
command = "project wt new"
description = "create a project worktree"
```

```sh
herdr server reload-config
```
