# Natural-Language DB Query Endpoint

Deploy a live HTTP endpoint that turns a plain-English question into a **read-only**
SQL query and returns the answer. One run stands up the endpoint AND proves the
pipeline for real: it runs the sample question against the seeded demo database
and returns the actual rows.

## What it does

```
validate ─▶ resolve ─▶ plan ─▶ guard ─┬─▶ execute ─┬─▶ deploy ─┬─▶ deployed         (terminal)
           (database   (models  (read- │            │          ├─▶ deploy_failed   (terminal)
            .get)       .run)   only    │            │          └─▶ endpoint_skipped(terminal)
                                check)  │            └─▶ query_failed              (terminal)
                                       └─▶ rejected                                (terminal)
```

1. **validate** — checks the input (a `dbHandle` or `connectionString`) and resolves
   config (sample question, port, row cap, model). No target → `rejected`.
2. **resolve** — reads the target Postgres connection string from a Sapiom-managed
   database handle (`database.get`) to inject into the endpoint, and — for the
   managed demo database — seeds it (`customers`/`invoices`) if deploy's own
   `seed.sql` hasn't already run. Idempotent.
3. **plan** — translates the sample question into SQL. On the seeded demo database
   with the unmodified default question (the zero-setup path), this is a fixed,
   known-safe `SELECT` written once by us — no LLM call, no dependency on it
   returning valid SQL. Any other question or database still asks an LLM
   (`models.run`), system-prompted to emit a single read-only `SELECT`.
4. **guard** — applies the read-only guardrail to that sample SQL, whichever
   source produced it. Anything that isn't a single read-only statement →
   `rejected`.
5. **execute** — runs the guarded SQL for real against the resolved database,
   inside a `READ ONLY` transaction with a statement timeout and the same row cap
   the deployed endpoint enforces. The returned rows ARE the zero-setup artifact.
   A connection or query failure → `query_failed`, rather than faking rows.
6. **deploy** — writes a small server into a sandbox and exposes it at a stable URL
   (`sandboxes.deployPreview`). `DATABASE_URL` and the server's own
   `SAPIOM_API_KEY` are passed as env — never baked into source. The key is minted
   for the endpoint (`ctx.sapiom.keys.mintScoped`): a durable, narrowly-scoped
   credential, since the engine's per-run token expires with the step. (Set
   `ENDPOINT_SAPIOM_API_KEY` to override with a key you control.)
7. **deployed** / **deploy_failed** / **endpoint_skipped** / **query_failed** /
   **rejected** — terminal; report the endpoint URL and the real sample rows,
   surface the deploy logs, or explain the failure/rejection.

## The endpoint

The deployed server exposes:

- `POST /query` with `{ "question": "…" }` → `{ question, sql, columns, rows, rowCount, truncated }`
- `GET /health` → `{ "ok": true }`

Per request it introspects the schema (cached), asks the LLM for a read-only
`SELECT`, re-checks it with the same guardrail, then runs it inside
`BEGIN TRANSACTION READ ONLY` with a statement timeout and a `LIMIT` cap.

## The read-only guardrail

Defense-in-depth, so a write can't slip through even if one layer is wrong:

1. The SQL source is **told** (an LLM system prompt) or **known** (the built-in
   zero-setup query) to be a single `SELECT`.
2. The SQL is **checked** — single statement, starts with `SELECT`/`WITH`, no
   `INSERT`/`UPDATE`/`DELETE`/DDL keywords.
3. `execute` and the deployed endpoint both **run** it in a `READ ONLY`
   transaction, which Postgres enforces at the engine level, with a statement
   timeout and a row cap.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit that
   authority to read the DB handle and deploy the sandbox.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (pass a stub override returning a real SELECT plus `{ "dryRun": true }` to trace
   the deploy branch offline, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real deploy that stands
   up the endpoint).

Example `run_local` input:

```json
{
  "dbHandle": "analytics",
  "sampleQuestion": "How many rows are in each table?",
  "dryRun": true
}
```

with the stub override so `plan` returns real SQL and `guard` passes; `execute`
then reports fixed sample rows under `dryRun` rather than opening a connection:

```json
{ "version": 1, "steps": { "plan": { "models.run": { "output": "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC" } } } }
```

## Files

- `index.ts` — the agent + the embedded endpoint server (`SERVER_SOURCE`). Edit this.
- `seed.sql` — the read-side seed for the managed demo database (`customers`, `invoices`); `index.ts`'s `ensureSeeded` mirrors it for a run that has to provision the database itself.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
