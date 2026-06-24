---
"@sapiom/orchestration": minor
---

Let a workflow step declare the capability it calls.

`defineStep` accepts an optional `capability` — the canonical dotted capability id the step invokes (`web.search`, `agent.coding.run`). A step's `run` calls capabilities dynamically via `ctx.sapiom.*`, so the binding can't be inferred; declaring it lets `buildManifest` emit it into the step manifest as `capabilityId`. Steps that declare nothing emit `capabilityId: null` (the step runs in-process). The manifest schema (`workflowManifestSchema`) carries `capabilityId` as an optional, non-empty string or null, so manifests built before this field existed still validate.
