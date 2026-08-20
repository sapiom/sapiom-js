---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

Expose structured `CodingRunHttpError` details for failed coding requests and clarify that repository handles represent Sapiom-hosted repositories rather than external Git imports.

Teach generated agent projects to terminate immediately on deterministic coding-repository failures instead of consuming the workflow step's remaining attempts.
