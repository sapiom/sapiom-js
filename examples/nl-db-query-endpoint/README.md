# Natural-Language DB Query Endpoint

Deploy a live HTTP endpoint that turns a plain-English question into a **read-only**
SQL query and returns the answer. One run stands up the endpoint; the endpoint
answers questions.

## What it does

```
validate ─▶ resolve ─▶ plan ─▶ guard ─┬─▶ deploy ─┬─▶ deployed      (terminal)
           (database   (models  (read- │           └─▶ deploy_failed (terminal)
            .get)       .run)   only    └─▶ rejected                 (terminal)
                                check)
```

1. **validate** — checks the input (a `dbHandle` or `connectionString`) and resolves
   config (sample question, port, row cap, model). No target → `rejected`.
2. **resolve** — reads the target Postgres connection string from a Sapiom-managed
   database handle (`database.get`) to inject into the endpoint.
3. **plan** — previews the pipeline: translates the sample question into SQL with an
   LLM (`models.run`), system-prompted to emit a single read-only `SELECT`.
4. **guard** — applies the read-only guardrail to that sample SQL. Anything that
   isn't a single read-only statement → `rejected`, so the endpoint is only
   deployed once the safe path is proven.
5. **deploy** — writes a small server into a sandbox and exposes it at a stable URL
   (`sandboxes.deployPreview`). `DATABASE_URL` and the server's own
   `SAPIOM_API_KEY` (read from the vault at deploy time, `vault.get`) are injected
   as env — never baked into source.
6. **deployed** / **deploy_failed** / **rejected** — terminal; report the endpoint
   URL, surface the deploy logs, or explain the rejection.

## The endpoint

The deployed server exposes:

- `POST /query` with `{ "question": "…" }` → `{ question, sql, columns, rows, rowCount, truncated }`
- `GET /health` → `{ "ok": true }`

Per request it introspects the schema (cached), asks the LLM for a read-only
`SELECT`, re-checks it with the same guardrail, then runs it inside
`BEGIN TRANSACTION READ ONLY` with a statement timeout and a `LIMIT` cap.

## The read-only guardrail

Defense-in-depth, so a write can't slip through even if one layer is wrong:

1. The LLM is **told** to emit a single `SELECT`.
2. The SQL is **checked** — single statement, starts with `SELECT`/`WITH`, no
   `INSERT`/`UPDATE`/`DELETE`/DDL keywords.
3. The endpoint **executes** it in a `READ ONLY` transaction, which Postgres
   enforces at the engine level, with a statement timeout and a row cap.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit that
   authority to read the DB handle / vault and deploy the sandbox.

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
  "vaultRef": "nl-db-query-endpoint",
  "vaultKey": "sapiom_api_key",
  "dryRun": true
}
```

with the stub override so `plan` returns real SQL and `guard` passes:

```json
{ "version": 1, "steps": { "plan": { "models.run": { "output": "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC" } } } }
```

## Files

- `index.ts` — the agent + the embedded endpoint server (`SERVER_SOURCE`). Edit this.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
