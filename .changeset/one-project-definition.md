---
"@sapiom/harness": patch
---

Derive Studio workspace scopes from the same `projectRoots` rule the rail renders, so every project row on a real install has a durable Studio project and its Agent Map owns creation. Launching Studio inside an agent's own folder promoted the rail's row to the folder that holds it, while the server had registered only the agent folder, so the row's join failed and the retired direct-creation UI rendered instead.
