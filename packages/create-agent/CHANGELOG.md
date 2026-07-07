# @sapiom/create-orchestration

## 0.2.0

### Minor Changes

- ae1df3c: Scaffold honors `npm_config_registry` / `@scope:registry` when resolving the
  `@sapiom/*` versions to pin

  Version resolution previously hardcoded the public npm registry, so a scaffold
  always pinned public-npm `latest` even when the environment pointed at a
  different registry. It now resolves `latest` from the same registry a plain
  `npm install` would (a scoped `@<scope>:registry` wins over the global
  `npm_config_registry`, which wins over the public default). When that registry
  is non-default, the scaffolded project also gets a matching `.npmrc` so its
  pinned versions are installable. This makes a local registry dev loop work
  end-to-end with no manual pin edits; default scaffolds are unchanged.

## 0.1.1

### Patch Changes

- b2c5612: Move the orchestration authoring SDK onto zod 4 via the bare `zod` import (no
  more `zod/v4` subpath), so installing is just:

  ```sh
  npm install @sapiom/orchestration
  ```

  `zod` is now a regular dependency rather than a peer. Author your step schemas
  with your own `import { z } from "zod"` as usual; a compatibility re-export
  (`import { z } from "@sapiom/orchestration"`) is available for projects pinned
  to an incompatible zod. Scaffolded projects now pin zod 4.
