# Vendored anti-slop plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Copied from `skills/install-anti-slop/assets/anti-slop/` at that revision by the bundled `scripts/install.mjs` installer.

Installed plugin paths:

- `tools/oxlint/anti-slop/index.ts` — generic anti-slop rules registered by this repository
- `tools/oxlint/anti-slop/effect/index.ts` — bundled Effect rules, not registered because this repository has no direct `effect` dependency
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/` — self-contained readability support, including its license and separate upstream record

## Intentional deviations

- The copied plugin source is unmodified from the recorded anti-slop revision.
- Repository-owned Oxlint configuration selects the generic rules at error severity and ignores the vendored source from linting and formatting.
- The optional Effect plugin remains bundled for provenance completeness but inactive.
