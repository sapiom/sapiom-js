---
"@sapiom/harness": minor
---

Remove the retired project graph server runtime and HTTP handlers. Authenticated requests to the old graph, refresh, and navigation URLs return the generic JSON API 404; requests without the required boot token still return 401. The JSON 404 fallback applies to all unknown `/api` paths, preventing them from falling through to the Studio HTML shell.

Use durable project IDs and the Agent Map APIs. Shared agent discovery, ordinary sessions, and per-agent Canvas remain available.
