---
"@sapiom/tools": minor
---

Add `database.list()` to the `database` capability — a thin, read-only listing over `GET /v1/databases` that returns every database you own, each with connection credentials. It never creates, mutates, or removes anything. Use it to discover a handle you (or another of your workflows) already provisioned before deciding whether to reuse it. Available on the client (`sapiom.database.list()`) and as an ambient function (`import { database } from "@sapiom/tools"`).
