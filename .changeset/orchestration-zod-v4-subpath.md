---
"@sapiom/orchestration": minor
---

Broaden `zod` peer support to `^3.25.76 || ^4.0.0` (was `^4.0.0`).

The package now uses zod's v4 API via the `zod/v4` subpath internally (types, `z.toJSONSchema`) instead of importing from `zod` directly. That subpath ships in **both** zod 3.25.x and zod 4.x, so the package can be consumed on either — restoring support for zod-3.25 projects (which `^4.0.0` had excluded) while keeping zod 4 working. Author step schemas with `import { z } from "zod/v4"` (equivalent to `import { z } from "zod"` on zod 4).

Non-breaking for existing zod-4 consumers: `zod/v4` and `zod` resolve to the same v4 implementation there.
