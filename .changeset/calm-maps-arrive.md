---
"@sapiom/harness": minor
---

Add durable, path-free Studio project identities and lazy Agent Map workspace state. The authenticated local server now exposes project workspace and root-binding association endpoints, and stores the new catalog at `studio-projects.json` with per-project records beneath `agent-map/` in the configured harness state root. The legacy System Graph and per-agent Canvas remain unchanged.
