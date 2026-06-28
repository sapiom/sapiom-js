---
"@sapiom/tools": minor
---

Add `deploy` and `createPreview` to the `sandboxes` capability so a workflow step can release an app and get its URL. `deploy(input)` uploads a file map to an existing sandbox, installs dependencies, and starts the entrypoint (`POST /v1/sandboxes/:name/deploy`); `createPreview(input)` exposes a sandbox port as a public URL (`POST /v1/sandboxes/:name/previews`). Both are available as methods on the `Sandbox` handle (`sandbox.deploy({ files, entrypoint })`, `sandbox.createPreview({ port })`), on `createClient().sandboxes` / the ambient `sandboxes` namespace (pass `name`), and via the `@sapiom/tools/stub` client so a deploy workflow runs under `run_local`. PREVIEW-grade: node-only, sandbox-TTL-bound (~4h), and the public URL requires `COMPUTE_PREVIEWS_ENABLED` gateway-side.
