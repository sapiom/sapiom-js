---
"@sapiom/tools": minor
---

Add a READ-ONLY `vault` namespace (`vault.list/get/getMany/getAll` + `ctx.sapiom.vault`) against the vault gateway's v2 API. List returns key names only; get maps a 404 to `null`. No set/delete by decision (SAP-1471) — writing secrets stays in the dashboard / `@sapiom/core` `VaultAPI`.
