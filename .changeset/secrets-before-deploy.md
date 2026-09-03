---
"@sapiom/harness": minor
---

Add the right pane's Secrets tab: the credentials one agent's runs receive, with add, replace, delete, and .env import, all write-only against Sapiom.

A secret no longer waits on a deploy. Sapiom stores secrets per cloud definition, so previously a value could not be set until the agent was linked — the deploy you needed the credential for. Values are now accepted at any point: before linking they are held locally and uploaded when the agent is deployed, and each row states which of the two it is, `pending` or `synced`. An agent deployed from the terminal, which the Studio server never observes, gets a banner naming the values that have not shipped and a control to upload them.

**Studio keeps a plaintext copy of every secret you enter, on every path — not only before linking.** The copy is what lets a local run receive the same values its deployed counterpart gets, since Sapiom has no read path for a stored secret. It lives in `~/.sapiom/harness/pending-secrets.json` at mode 0600, outside every project directory so it cannot be committed, and honours `--state-root`. Deleting a secret removes the local copy with it, and a secret that is also stored on Sapiom can have just its local copy removed.

No value is ever returned to the browser: `GET /api/workflows/:id/secrets` carries names and states alone, matching the platform's own names-only read.
