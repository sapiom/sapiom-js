---
"@sapiom/agent": minor
---

Make the agent input contract first-class: `defineAgent({ inputSchema })`.

`defineAgent` now accepts an optional agent-level `inputSchema` — one obvious place to declare "what this agent takes". When the entry step declares no `inputSchema` of its own, `defineAgent` folds the agent-level schema onto it, so the built manifest's entry step carries the JSON Schema (and the dashboard renders its fields) without any downstream change. Declaring a *different* schema at both the agent level and on the entry step is now a build error with a clear message; declaring the identical schema object in both places is allowed.

The schema is typed `ZodType<TInput>`, so the `defineAgent<TInput>` generic (hence the `run(def, input)` call site) is inferred from the same runtime schema that becomes the contract — the TS annotation and the runtime validation can no longer drift apart (SAP-2226).

Existing agents that declare the schema on the entry step keep working unchanged.
