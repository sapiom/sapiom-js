---
"@sapiom/tools": minor
---

Emit `capability.call` usage analytics from the capability transport via `@sapiom/analytics-core`.

Every capability HTTP call now enqueues one `capability.call` event at the transport choke point, carrying the capability path/name (the routed capability id, e.g. `web.scrape`, or the request path), the request URL path (query strings and fragments are stripped, never recorded), HTTP status, duration, request size, and the transport's attribution fields (agent, trace, metadata). Request and response bodies are never captured. The emitted `sdk_version` comes from a build-time constant generated from package.json, so it survives bundling.

Analytics ships dark: unless a collector endpoint is configured the emitter is a silent no-op — zero network calls, zero disk writes. Events are enqueued synchronously and delivered in background batches, so nothing is ever awaited, thrown, or slowed on the call path; capability behavior is byte-identical with telemetry on, off, or the collector unreachable. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

Adds `Sapiom.shutdown(): Promise<void>` (additive): flushes buffered events and detaches the emitter's process exit hook. Call it once per client in hosts that construct many clients per process (e.g. an engine worker creating a per-execution client) so exit hooks don't accumulate; it's idempotent, never rejects, resolves immediately when there's nothing to release, and covers clients derived via `withAttribution` (the stub client implements it as an immediate resolve).
