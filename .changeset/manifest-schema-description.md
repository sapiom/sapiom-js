---
"@sapiom/agent": patch
---

Fix: authored `description` (on `defineStep` and `defineAgent`) and step `capabilities` were silently dropped during manifest validation.

`agentManifestSchema` is a `z.object()`, which strips keys it doesn't declare. The previous release added `description`/`capabilities` to the TS types and to `buildManifest`'s output, but not to the runtime schema — so `agentManifestSchema.parse()` (which `@sapiom/agent-core`'s `check()` runs on every manifest) discarded them. The result: tooling that reads the validated manifest — the harness canvas — always saw empty descriptions, no matter what the source authored.

Adds `description` (step + workflow) and `capabilities` (step) to the schema as optional fields, so they survive validation and reach consumers. No behavior change for manifests that don't use them.
