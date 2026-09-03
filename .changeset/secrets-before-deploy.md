---
"@sapiom/harness": minor
---

Add the right pane's Secrets tab: the credentials one agent's runs receive, with add, replace, delete, and .env import, all write-only.

A secret no longer waits on a deploy. Sapiom stores secrets per cloud definition, so previously a value could not be set until the agent was linked — the deploy you needed the credential for. Values authored before linking are now held on this machine in `pending-secrets.json` (mode 0600, under the harness state root so no project directory ever holds a credential), merged into the run-local child's environment, and uploaded to the vault when the agent is deployed. Each row states which of the two it is, `pending` or `synced`, and an agent deployed from the terminal — which the server never observes — gets a banner naming the values that have not shipped and a control to upload them.

No value is ever returned to the browser: the platform's read is names-only by design, and `GET /api/workflows/:id/secrets` carries names and states alone.
