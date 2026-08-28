---
"@sapiom/cli": minor
---

`sapiom agents deploy` gains `-m, --message` to label a version in history —
previously every deploy was recorded as the hardcoded `deploy`.

Also adds `--transport archive|git` as an escape hatch. The transport is normally
decided by the server, so this exists for a rollback or for reproducing an issue,
not as a routine choice. An unrecognised value is rejected rather than passed
through, since it would otherwise silently take the default path — the opposite
of pinning one.

`--branch` now documents that it only applies to the git transport.
