# database

On-demand Postgres databases. The same database capability your agents call over
MCP, callable directly from your code. You get back direct connection credentials,
so you can connect with any standard Postgres client or driver.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// 1. Provision a database. `duration` is required.
const db = await sapiom.database.create({
  duration: "1h", // "15m" | "1h" | "4h" | "24h" | "7d"
  handle: "analytics", // optional, stable key to look it up later
});

// 2. Connect with any Postgres client using the credentials.
db.connection?.connectionString; // a ready-to-use Postgres URI
db.connection?.host;
db.connection?.port;
db.connection?.username;
db.connection?.password;
db.connection?.databaseName;

// 3. Retrieve it later by id or handle, then delete it.
const again = await sapiom.database.get(db.id); // or get("analytics")
await sapiom.database.delete(db.id); // or delete("analytics")
```

Ambient import works too: `import { database } from "@sapiom/tools"`.

## This is a provisioning surface, not a query layer

`database` hands you connection credentials; it does not run SQL for you. You
connect with the Postgres client of your choice (`pg`, `postgres`, an ORM, `psql`,
…) using `connection.connectionString` and run your own queries.

## Lifecycle

- A database is created with a `duration` and is **automatically removed** when it
  expires — there is no long-lived state to clean up by hand. `expiresAt` tells you
  when that happens.
- Right after `create`, `status` is `"active"` and `connection` carries credentials.
- `get` on a database that is still provisioning may return `connection: null` until
  it is ready.

## Looking up a database

`get` and `delete` accept either the database `id` or the `handle` you set at
creation. A `handle` is a stable, human-friendly key (`3–63` chars,
`^[a-z0-9][a-z0-9-]*[a-z0-9]$`) that is unique within your tenant — handy for
passing a database between steps or agents without carrying the id around.

## Gotchas

- **`duration` is required.** Omitting it is rejected before any request is made.
- **`connection` can be `null`** while a database is still provisioning — guard it
  (`db.connection?.connectionString`) before connecting.
- **`connectionString` is always present** on a non-null `connection`, even if the
  individual component fields couldn't be parsed.
- **Failed requests throw `DatabaseHttpError`** (carries `status` + parsed `body`),
  exported from `@sapiom/tools`.
