---
"@sapiom/agent-core": minor
"@sapiom/tools": minor
"@sapiom/mcp": patch
"@sapiom/cli": patch
---

Correct the public schedule and signal contracts: expose authenticated cron preview through
`@sapiom/tools`, reject the unimplemented `overlapPolicy: "skip"` option at the type boundary,
align schedule inputs and signal payloads with the server's JSON-object contract, and document
that signals route by `(name, correlationId)` within the execution's tenant.
