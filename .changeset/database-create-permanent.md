---
"@sapiom/tools": minor
---

`database.create` no longer requires `duration`: a Sapiom Postgres is permanent (SAP-3100,
SAP-3580). The backend made the database contract lifetime-free — `duration` is optional and
ignored on receipt, the gateway no longer sells duration tiers or returns an `expiresAt`, and the
served authoring primer tells every session "there is no lifetime to pick and no `duration` to
pass" — but this client still declared `duration` as required and rejected a call without one
before the request left the process, so an agent written to the served text failed to typecheck
and to run.

- `CreateDatabaseInput.duration` is optional and `@deprecated`; `create({})` and `create()` both
  work. A `duration` that is still passed is accepted for source compatibility and dropped rather
  than forwarded, since the platform ignores it. Nothing else about the request changes.
- `DATABASE_DURATIONS` and `DatabaseDuration` stay exported, `@deprecated`, so existing callers
  compile.
- `Database.expiresAt` and `Database.duration` are optional. Both are absent on a database created
  after SAP-3100 and are only echoed when the gateway still returns them for an older database.
  `DatabaseStatus` keeps `"expired"`, documented as never emitted for a new database.
- The stub client accepts `database.create({})` and no longer synthesizes an `expiresAt`.
- JSDoc and the `database` README describe a permanent, count-metered resource: a database holds one
  slot of the plan's database limit from `create` until `delete`.
