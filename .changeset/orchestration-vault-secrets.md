---
"@sapiom/orchestration": minor
---

Add optional `secrets` and `secretsRef` to orchestration definitions and the workflow manifest. An orchestration can declare the names of the vault secrets it needs (and, optionally, the secret-set ref to read them from); the engine reads these from the manifest to inject vault-stored secrets into a run's sandbox env at dispatch (SAP-786). Backward-compatible: both fields are optional, and the manifest schema defaults `secrets` to `[]`, so existing manifests keep parsing.
