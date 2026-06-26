---
"@sapiom/tools": minor
---

Add the `database` namespace for on-demand Postgres databases:

- `database.create` — provision a database for a chosen `duration`, returned with direct connection credentials (`connection.connectionString`, `host`, `port`, `username`, `password`, `databaseName`).
- `database.get` — retrieve a database by its id or handle.
- `database.delete` — delete a database by its id or handle.

Results use normalized camelCase types, and a typed `DatabaseHttpError` (`{ status, body }`) is thrown on non-2xx responses.
