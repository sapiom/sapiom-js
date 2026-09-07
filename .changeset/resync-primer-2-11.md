---
"@sapiom/mcp": patch
---

Re-sync the offline `AUTHORING_INSTRUCTIONS` fallback with primer 2.11, which folds the 2.10
trigger-kinds release (SAP-3174: `schedule_cron` / `schedule_once` / `event` / `webhook`, the
webhook signing recipe, `sapiom_dev_agents_schedule_secret`) together with the SAP-3180
teaching (Vault semantics, `agents.launch`, receipts/replay, App Link webhooks). The two landed
in separate backend releases and the package had only the second; the digest pin moves with the
body.
