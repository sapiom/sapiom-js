---
"@sapiom/orchestration": minor
---

Declare `zod` as a `peerDependency` (`^4.0.0`) instead of a direct dependency, and remove the `z` / `ZodType` compatibility re-exports from the package entry.

Step `inputSchema`s are zod schemas authored in the consumer's project and passed into this package, so there must be a single shared `zod` instance — bundling our own copy could otherwise cause type and `instanceof` mismatches against the consumer's `zod`. zod 4 is required; npm 7+ and pnpm install the peer automatically (consumers on older package managers should add `zod` alongside this package).

The previous `export { z } from "zod"` shim only worked because the package bundled its own `zod`; with `zod` as a peer it would just re-export the consumer's own instance, so it has been removed. Import `z` from `zod` directly.
