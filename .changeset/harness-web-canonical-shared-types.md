---
"@sapiom/harness": patch
---

Point the harness web UI's `@shared/types` alias at the package's own shared contract instead of a vendored copy, so the web and server always build against a single source of truth. The snippet panel now reads the real deployed-agent slug and executions base URL when the server provides them, falling back cleanly when it does not. No behavioral or API changes to the harness server.
