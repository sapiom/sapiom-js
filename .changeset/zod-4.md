---
"@sapiom/sandbox-preview": minor
"@sapiom/agent-map": minor
"@sapiom/mcp": patch
"@sapiom/harness": patch
"@sapiom/cli": patch
"@sapiom/agent-core": patch
---

Upgrade zod to 4.6.7.

`@sapiom/sandbox-preview` (`sandboxConfigBodySchema` and the other exported schemas) and `@sapiom/agent-map` (`./host-protocol`) now export zod 4 schemas. Compose them with zod 4: `import { z } from "zod"` on zod 4, or `import { z } from "zod/v4"` on zod 3.25.

Projects scaffolded by `sapiom agents init` now pin zod 4.6.7.
