---
"@sapiom/agent": minor
---

Steps can declare the platform capability they call: `defineStep({ capability: "web.search", ... })`. The build emits it as `capabilityId` on each manifest step (null when undeclared), and `agentManifestSchema` accepts and preserves the field — absent keys (manifests built before the field existed) parse to null, empty-string ids are rejected. The platform indexes the binding for per-step attribution.
