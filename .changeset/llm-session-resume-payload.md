---
"@sapiom/tools": minor
---

`llm`: the session deferred lane now exports its resume-boundary contract from the package root, matching the async lane (SAP-3184).

A step paused on `llm.createSession(...)` and resumed on `LLM_SESSION_READY_SIGNAL` receives an `LlmSessionReadyPayload` as input — an `LlmSession` narrowed to the two terminal shapes the engine delivers: `state: "ready"` with the session-scoped `baseUrls`, or `state: "failed"` with the gateway's structured reason (`deadline_exhausted`, `grant_mint_failed`, `session_ready_failed`, `session_unsupported`). Validate it at the resume boundary with `llmSessionReadySchema.parse(...)`, which throws `LlmSessionReadySchemaError` on a malformed payload — the same shape of API as `llmRouteResultSchema` / `LlmRouteResultSchemaError`. All three are importable from `@sapiom/tools` with no subpath.

Also re-exported from the root while closing the same gap: the `LlmSession` and `LlmSessionState` types, `RoutingLabel` and `ModelLabel`, and the serving-disclosure reader `readDisclosure` with its `LlmDisclosure` / `LlmDisclosureResult` types. Purely additive — no existing export changes shape or name.
