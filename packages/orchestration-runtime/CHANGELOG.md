# @sapiom/orchestration-runtime

## 0.2.1

### Patch Changes

- Updated dependencies [f41ab95]
  - @sapiom/orchestration@0.3.0

## 0.2.0

### Minor Changes

- b2c5612: Move the orchestration authoring SDK onto zod 4 via the bare `zod` import (no
  more `zod/v4` subpath), so installing is just:

  ```sh
  npm install @sapiom/orchestration
  ```

  `zod` is now a regular dependency rather than a peer. Author your step schemas
  with your own `import { z } from "zod"` as usual; a compatibility re-export
  (`import { z } from "@sapiom/orchestration"`) is available for projects pinned
  to an incompatible zod. Scaffolded projects now pin zod 4.

### Patch Changes

- Updated dependencies [b2c5612]
  - @sapiom/orchestration@0.2.0
