---
"@sapiom/harness": patch
---

Allow an explicit first Terminal start in a dormant Studio session, preserving its Studio and Assistant identities. Coalesce duplicate starts, revalidate workspace authority, and prevent End races or project bootstrap from starting unintended work.
