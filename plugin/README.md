# Project worktrees Herdr plugin

This directory is the manifest-only Herdr plugin shipped with `devenv-agents`.
It invokes the `project` CLI for worktree lifecycle events and provides the
`setup` overlay used to bootstrap managed linked worktrees.

The plugin has no build step or runtime dependencies. Link it with:

```sh
project plugin install
```
