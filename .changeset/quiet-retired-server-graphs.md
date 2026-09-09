---
"@sapiom/harness": minor
---

Remove the retired project graph server runtime and HTTP handlers. Authenticated requests to the old graph, refresh, and navigation URLs now return the generic API 404; unauthenticated requests still return 401. Use durable project IDs and the Agent Map APIs. Shared agent discovery, ordinary sessions, and per-agent Canvas remain available.
