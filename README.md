# devenv-agents

Project lifecycle tooling for devenv and Herdr worktrees.

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
