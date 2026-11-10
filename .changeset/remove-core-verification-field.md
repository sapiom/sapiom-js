---
"@sapiom/core": minor
---

Remove the `verification` field from `TransactionResponse`. The API never returned it. `version`, `nextAction` and the bounded `transactions.get(id, { since, maxWaitSeconds })` read are unchanged.
