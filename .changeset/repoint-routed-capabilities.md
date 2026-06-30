---
"@sapiom/tools": minor
---

Repoint `scrape`, `emailSearch.*` (find/verify/domainSearch), and `contentGeneration.images.create` onto the Capability Router: each now sends `POST /v1/capabilities/<dotted-id>` on the single Core base URL instead of a provider-gateway subdomain.

A new shared `capabilityCall(id, req, opts)` seam (in `_client/`) is the one place the routed-call contract lives — building the `/v1/capabilities/<id>` request, sending the `x-api-key` credential header, resolving the Core base URL **at call time** (no per-capability URL knob, no module-const import freeze), and mapping non-2xx to the capability's typed error. `web.search` is refactored onto it, and the three migrated verbs route through it too.

Public verb names and signatures are unchanged (non-breaking); request/response shapes are mapped to the router's normalized DTOs internally. The deferred async/stateful capabilities (video, sandboxes, agents, …) keep their existing provider-gateway path.
