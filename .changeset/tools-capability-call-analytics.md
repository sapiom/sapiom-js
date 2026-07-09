---
"@sapiom/tools": minor
---

Emit `capability.call` usage analytics from the capability transport via `@sapiom/analytics-core`.

Every capability HTTP call now enqueues one `capability.call` event at the transport choke point, carrying the capability path/name (the routed capability id, e.g. `web.scrape`, or the request path), HTTP status, duration, request size, and the transport's attribution fields (agent, trace, metadata). Request and response bodies are never captured.

Analytics ships dark: unless a collector endpoint is configured the emitter is a silent no-op — zero network calls, zero disk writes. Events are enqueued synchronously and delivered in background batches, so nothing is ever awaited, thrown, or slowed on the call path; capability behavior is byte-identical with telemetry on, off, or the collector unreachable. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
