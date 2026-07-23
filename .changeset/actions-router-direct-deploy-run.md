---
"@sapiom/harness": patch
---

Add a server-side actions router with direct Deploy and Prod-run routes:

- `POST /api/workflows/:id/deploy` deploys a linked agent and streams build status as NDJSON (a `building` line up front, then a terminal `ready`/`error` line).
- `POST /api/runs` `{ definitionId, input }` starts an execution and returns `{ executionId }`.

Both run entirely server-side with the held API key (never exposed to the browser) and require no coding-agent session, so an action consumes no LLM credits.
