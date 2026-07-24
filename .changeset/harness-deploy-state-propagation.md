---
"@sapiom/harness": patch
---

After a Deploy that links or changes the agent's definition, the whole UI now updates without a restart. The server re-reads `sapiom.json` and broadcasts the change, so the Deployed/Draft chip, the canvas badge, the sidebar cloud icon, and Prod Run all pick up the new definition id consistently — previously they kept the stale value, so Prod Run failed with "definition not found" and the deploy-state badges disagreed with each other.
