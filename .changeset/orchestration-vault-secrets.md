---
"@sapiom/orchestration": minor
---

Add optional `secrets` to orchestration definitions and the workflow manifest: an array of bindings `{ ref, keys }`, each pulling the named `keys` (env-var names) from one vault secret-set (`ref`). A workflow can declare several to read from different sets. The engine reads these from the manifest to inject vault-stored secret values into a run's sandbox env at dispatch (SAP-786). Backward-compatible: optional, and the manifest schema defaults it to `[]`, so existing manifests keep parsing.
