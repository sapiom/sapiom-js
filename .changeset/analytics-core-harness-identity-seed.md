---
"@sapiom/analytics-core": patch
---

Add `seedAnalyticsIdentity` export and `harness` to the `EventSource` union.

`seedAnalyticsIdentity(anonymousId)` seeds `~/.sapiom/analytics.json` with a known id if the file does not yet exist — idempotent, 0600-preserving, and degrades silently on unwritable HOME. Intended for one-way migration of a prior-version per-install id into the canonical identity file.

`EventSource` now includes `"harness"` for events emitted by the harness server.

`SapiomAnalytics` gains `discard()`: drop all buffered events without sending them. Complements `flush()`/`shutdown()` for hosts that must guarantee zero deliveries after a user opts out mid-process. Optional on the type (existing structural fakes keep compiling); every emitter `createAnalytics` returns implements it.

All changes are additive; no existing API signatures are modified.
