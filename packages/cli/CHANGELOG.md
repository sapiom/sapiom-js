# @sapiom/cli

## 0.2.0

### Minor Changes

- eb5dca2: Add a `staging` environment to host resolution. `resolveHost` maps the `staging` target (alias `dev`) to the staging API host, and the MCP server resolves `SAPIOM_ENVIRONMENT=staging`/`dev`/`prod` from built-in presets without requiring a `~/.sapiom/credentials.json` entry. A file-defined environment still takes precedence.

### Patch Changes

- @sapiom/orchestration@0.1.9
- @sapiom/orchestration-core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [e17b2d1]
- Updated dependencies [e17b2d1]
  - @sapiom/orchestration-core@0.3.0
  - @sapiom/orchestration@0.1.8

## 0.1.1

### Patch Changes

- Updated dependencies [704c9ac]
  - @sapiom/orchestration-core@0.2.0
  - @sapiom/orchestration@0.1.7
