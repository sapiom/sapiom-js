---
"@sapiom/tools": minor
---

Add a private v1 runtime-provenance carrier for agent invocations. Instrumented
calls send opaque callsite evidence out of band, terminal results retain an
SDK-only server receipt, and only exact direct result-to-input handoffs forward
that receipt through a trusted, one-shot build callsite. Private receipt state is
not package-exported; reflected values are redacted from errors. Request/result
JSON and calls without metadata remain unchanged. CJS and ESM imports share one
bundled lexical store, including mixed-format direct handoffs, without exposing
private extraction or rebinding helpers through the module cache. Build tooling
uses the unsupported implementation subpath
`@sapiom/tools/_internal/agent-runtime-provenance`; that subpath may change in
any release.
