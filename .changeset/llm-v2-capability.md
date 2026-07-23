---
"@sapiom/tools": minor
---

New `llm` capability — routed LLM calls through the gateway's `/v2` routing front-end: `llm.run` (synchronous `POST /v2/anthropic/v1/messages`; `model` names a Sapiom routing label (omit for the account's `default_label`), capacity-aware with per-label never-fail fallback, billed against the caller's Sapiom API key at the edge), `llm.submit` (deferred-start `POST /v2/route/async`; returns a pausable `DispatchHandle` that grants a single-use link when capacity frees), and `llm.redeem` (spend the granted link). Exported on the client (`ctx.sapiom.llm`), the barrel, a `./llm` subpath, and the stub client.

Sessions (Surface B, `/v2/sessions`) — the REST resource replacing the async+grant lane: `llm.createSession` (reserve deferred capacity from a plain JSON body: `label`|`model`, `deadlineMinutes`, `budget{maxTokens, ttlMinutes}`, optional webhook; returns a pausable `LlmSessionHandle` firing `LLM_SESSION_READY_SIGNAL`), `llm.getSession` (poll `pending → ready → active → expired|exhausted|failed`), `llm.callSession` (REPEATABLE drop-in calls against the session-scoped Anthropic/OpenAI paths with the normal Sapiom credential — no single-use token; ends with clean `session_expired`/`session_exhausted` terminals), and `llm.releaseSession` (early release). `submit`/`redeem` keep working until the migration completes. Stubbed in the stub client.
