---
"@sapiom/harness": patch
---

Make the deployed-agent trigger snippet resilient when the agent's slug can't be resolved from the deployment. The panel now falls back to the project name (and flags it as inferred so you can verify) instead of showing a fill-in placeholder in the read-only slug field, and it targets the configured Agents API host so the copy-paste call reaches the same environment the agent was deployed to.
