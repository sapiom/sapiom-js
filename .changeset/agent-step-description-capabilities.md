---
"@sapiom/agent": minor
---

Add optional authoring fields to the workflow SDK, surfaced by the harness canvas:

- `defineStep` gains `description` (a one-line summary of what the step does) and `capabilities` (the Sapiom capability ids the step declares it calls).
- `defineAgent` gains `description` (a one-line summary of the whole workflow).

All three are optional and flow through `buildManifest` into `AgentStepManifest` / `AgentManifest` as optional fields, so manifests emitted before this release keep validating unchanged. No runtime behavior change — the fields are read only by tooling (the canvas step inspector and workflow overview).
