import {
  defineAgent,
  defineStep,
  goto,
  resolveResourceHandle,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import postgres from "postgres";
import { z } from "zod/v4";

/**
 * Natural-Language DB Query Endpoint — an agent run translates a plain-English
 * question into a read-only SQL query, vets it, and deploys a live HTTP endpoint
 * that executes read-only SQL against your database.
 *
 * The NL→SQL translation happens ONCE, during the run (where `llm.run` has a
 * real per-run engine token). The DEPLOYED endpoint never calls an LLM — it only
 * executes SQL it is given, so it needs no Sapiom credential at all, just
 * `DATABASE_URL`. `GET /` on the deployed endpoint shows the vetted sample
 * (question, SQL, and the real rows it returned) as a demo of the translation.
 *
 *   validate ─▶ resolve ─▶ plan ─▶ guard ─┬─▶ execute ─┬─▶ deploy ─┬─▶ deployed       (terminal)
 *              (database   (models  (read- │            │          └─▶ deploy_failed (terminal)
 *               .get)       .run)   only    │            └─▶ query_failed            (terminal)
 *                                   check)  └─▶ rejected                             (terminal)
 *
 *   1. validate — check the input (a database handle or connection string) and
 *      resolve config (sample question, port, row cap, model).
 *   2. resolve  — read the target Postgres connection string from a Sapiom-managed
 *      database handle (`database.get`) so it can be injected into the endpoint,
 *      and — for the managed demo database — seed it (`customers`/`invoices`) if
 *      deploy's own `seed.sql` has not already run. Idempotent, so a repeat run
 *      is a no-op.
 *   3. plan     — translate the sample question into SQL. On the seeded demo
 *      database with the unmodified default question, this is a fixed, known-safe
 *      SELECT written once by us, so the zero-setup path never depends on an LLM
 *      returning valid SQL. Any other question or database still asks an LLM
 *      (`llm.run`), system-prompted to emit a single read-only SELECT.
 *   4. guard    — apply the read-only guardrail to that sample SQL, whichever
 *      source produced it. Anything that isn't a single read-only statement routes
 *      to `rejected`.
 *   5. execute  — run the guarded SQL for real against the resolved database,
 *      inside `BEGIN ... READ ONLY` with a statement timeout and the same row cap
 *      the deployed endpoint enforces. The returned rows ARE the zero-setup
 *      artifact — a connection or query failure routes honestly to `query_failed`
 *      rather than fabricating rows.
 *   6. deploy   — write a small server into a sandbox and expose it at a stable
 *      URL (`sandboxes.deployPreview`). Only `DATABASE_URL` and the vetted sample
 *      (`SEED_QUESTION`/`SEED_SQL`/`SEED_COLUMNS`/`SEED_ROWS`) are passed as env —
 *      no Sapiom credential, since the deployed server never calls `llm.run`.
 *      After the sandbox reports a URL, this step PROBES it for real — POSTs the
 *      vetted sample SQL to `/query` and requires a 200 with rows back — before
 *      calling the run `deployed`. A URL that can't answer its own vetted query is
 *      worse than no URL, so an unverified endpoint routes to `deploy_failed`.
 *   7. deployed / deploy_failed / query_failed / rejected — terminal.
 *
 * The read-only guardrail is defense-in-depth: the SQL source is *told* (an LLM
 * system prompt) or *known* (the built-in zero-setup query) to be a SELECT, the
 * SQL is *checked* (single statement, starts with SELECT/WITH, no DDL/DML
 * keywords) at `guard`, and both `execute` and the deployed endpoint *run* it
 * inside `BEGIN ... READ ONLY` with a statement timeout and a row cap — the last
 * of which Postgres enforces at the engine level, so a write can't slip through
 * even if the earlier layers are wrong. The deployed endpoint re-applies the same
 * guard to any SQL a caller posts to it, since it, too, only ever executes SQL —
 * never natural language — at request time.
 *
 * `run_local` stubs `database.get`, so on defaults the built-in sample SQL passes
 * `guard` (it never called the model) but `execute`'s real query against the
 * stubbed, unreachable connection fails — a legible trace of the query-execution
 * boundary at `query_failed`. Pass a stub override for `database.get` returning a
 * reachable connection string to trace `execute`/`deploy` succeeding, or add
 * `{ "dryRun": true }` to trace the whole graph offline over fixed sample rows
 * (see AGENTS.md).
 */

// ────────────────────────────────────────────────────────────────── config ──

interface EntryInput {
  /** Sapiom-managed Postgres handle; its connection string is injected as DATABASE_URL. */
  dbHandle?: string;
  /** Explicit Postgres connection string (overrides `dbHandle`). */
  connectionString?: string;
  /** Sandbox name to host the endpoint (default `nl-db-query-endpoint`). */
  sandboxName?: string;
  /** A question used to preview the translate → guard path before deploying. */
  sampleQuestion?: string;
  /** LLM model / routing alias override for the translation. */
  model?: string;
  /** Max rows the endpoint returns per query (default 100). */
  maxRows?: number;
  /** Port the endpoint listens on (default 3000). */
  port?: number;
  /**
   * Assemble everything but skip the real `deployPreview` — so `run_local` traces
   * the full graph offline, with no sandbox and no real deploy.
   */
  dryRun?: boolean;
}

interface Config {
  dbHandle: string;
  connectionString: string;
  sandboxName: string;
  sampleQuestion: string;
  model: string;
  maxRows: number;
  port: number;
  dryRun: boolean;
  /** True when the run defaulted to the managed demo database. */
  usingDemoDatabase: boolean;
}

interface Shared extends Record<string, unknown> {
  config: Config;
  connectionString: string;
  sampleSql: string;
  /** Column names from the real (or, under `dryRun`, fixed) sample execution. */
  sampleColumns?: string[];
  /** Rows the sample SQL actually returned — the zero-setup artifact. */
  sampleRows?: Record<string, unknown>[];
  sampleRowCount?: number;
  /** True when the row cap (`maxRows`) truncated the result. */
  sampleTruncated?: boolean;
  /** One plain sentence about which database was used and what was skipped. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

const DEFAULT_SANDBOX = "nl-db-query-endpoint";
const DEFAULT_QUESTION = "How many rows are in each table?";
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_PORT = 3000;
/**
 * Postgres handle used when the caller names no target. Declared in
 * `template.json` as a `resources[]` entry with `seed: "seed.sql"`, so deploy
 * provisions it and loads a small read-only dataset — a translation against a
 * schema that does not exist is not a demonstration of anything.
 */
const DEFAULT_DB_HANDLE = "nl-db-query-demo";

/** Per-query statement timeout for `execute`'s real sample-query run. Mirrors the
 * deployed endpoint's own default (see `SERVER_SOURCE`'s `STATEMENT_TIMEOUT_MS`). */
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Known-safe SELECT that answers `DEFAULT_QUESTION` against the seeded demo
 * schema (`customers`, `invoices` — see `seed.sql`). Used only on the zero-setup
 * path (the demo database, the unmodified default question), so the sample query
 * never depends on an LLM translating it correctly.
 */
const DEFAULT_SAMPLE_SQL = [
  "SELECT 'customers' AS table_name, count(*)::int AS row_count FROM customers",
  "UNION ALL",
  "SELECT 'invoices' AS table_name, count(*)::int AS row_count FROM invoices",
  "ORDER BY table_name",
].join("\n");

/**
 * Fixed rows `execute` reports under `dryRun`, instead of opening a connection.
 * Matches what the seeded demo data actually contains (6 customers, 60 invoices),
 * so the offline trace looks like the real thing without touching a database.
 */
const SAMPLE_COLUMNS = ["table_name", "row_count"];
const SAMPLE_ROWS: Record<string, unknown>[] = [
  { table_name: "customers", row_count: 6 },
  { table_name: "invoices", row_count: 60 },
];

function resolveConfig(input: EntryInput | undefined): Config {
  // Read the target handle through the canonical injection seam so a deploy-time
  // reuse picker (declared as `resources[].reuse.key: "dbHandle"`) can repoint the
  // endpoint at a database the caller already owns. The fallback is `""`, not
  // DEFAULT_DB_HANDLE: "no handle named" is a real state here — it selects the
  // seeded demo DB below only when no `connectionString` was given either, and a
  // user-named handle that 404s is rejected rather than silently reprovisioned.
  const dbHandle = resolveResourceHandle(input ?? {}, { fallback: "" });
  const connectionString = input?.connectionString?.trim() ?? "";
  const usingDemoDatabase = !dbHandle && !connectionString;
  return {
    // Naming a plausible-looking handle (`analytics`) would 404 for every real
    // user; the declared demo resource is one this template actually provisions.
    dbHandle: usingDemoDatabase ? DEFAULT_DB_HANDLE : dbHandle,
    connectionString,
    usingDemoDatabase,
    sandboxName: input?.sandboxName?.trim() || DEFAULT_SANDBOX,
    sampleQuestion: input?.sampleQuestion?.trim() || DEFAULT_QUESTION,
    model: input?.model?.trim() ?? "",
    maxRows: input?.maxRows ?? DEFAULT_MAX_ROWS,
    port: input?.port ?? DEFAULT_PORT,
    dryRun: input?.dryRun === true,
  };
}

// ─────────────────────────────────────────────── the read-only guardrail ──
// Mirrors the guard embedded in the deployed server (see SERVER_SOURCE). Both
// are belt-and-suspenders in front of the real boundary — the endpoint runs
// every query inside `BEGIN TRANSACTION READ ONLY`, which Postgres enforces.

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|do|copy|vacuum|analyze|reindex|refresh|lock|comment|attach|detach|set|reset|begin|commit|rollback|savepoint|prepare|execute|listen|notify|discard|cluster|reassign|security|import)\b/i;

/** Strip markdown fences and trailing semicolons from an LLM SQL reply. */
function cleanSql(raw: string): string {
  let sql = (raw ?? "").trim();
  // Remove a ```sql ... ``` (or bare ```) fence if the model wrapped its reply.
  const fence = sql.match(/^```(?:sql)?\s*([\s\S]*?)\s*```$/i);
  if (fence) sql = fence[1].trim();
  // Drop a single trailing semicolon (a lone statement terminator is fine).
  return sql.replace(/;\s*$/, "").trim();
}

interface GuardResult {
  ok: boolean;
  sql: string;
  reason?: string;
}

/** True only for a single read-only SELECT/WITH statement. */
function guardReadOnly(raw: string): GuardResult {
  const sql = cleanSql(raw);
  if (!sql) return { ok: false, sql, reason: "empty query" };
  // No stacked statements — a stray `;` splitting into two is rejected outright.
  if (sql.split(";").filter((s) => s.trim().length > 0).length > 1) {
    return { ok: false, sql, reason: "multiple statements are not allowed" };
  }
  const first = sql
    .replace(/^\(+/, "")
    .trimStart()
    .split(/\s+/)[0]
    ?.toLowerCase();
  if (first !== "select" && first !== "with") {
    return { ok: false, sql, reason: "only SELECT / WITH queries are allowed" };
  }
  const write = sql.match(WRITE_KEYWORDS);
  if (write) {
    return {
      ok: false,
      sql,
      reason: `disallowed keyword: ${write[0].toUpperCase()}`,
    };
  }
  return { ok: true, sql };
}

/**
 * Append a LIMIT clause when the query doesn't already cap its own rows. Kept in
 * sync with the identical helper embedded in `SERVER_SOURCE` — see AGENTS.md.
 */
function ensureLimit(sql: string, max: number): string {
  return /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${max}`;
}

// ─────────────────────────────────────────────────────── the endpoint app ──
// Uploaded verbatim to the sandbox. Reads all config from env (injected at
// deploy time). It never calls an LLM — the natural-language translation
// happened once, in the run, at `plan`. It only EXECUTES read-only SQL: on
// POST /query it re-checks the given SQL with the same guardrail, then runs it
// in a READ ONLY transaction with a statement timeout and a row cap. GET /
// serves the vetted sample (question/SQL/rows) the run produced, seeded in as
// env. No backticks / no ${} here so it embeds cleanly as a template-literal
// string above.

const SERVER_SOURCE = `import http from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = Number(process.env.MAX_ROWS || 100);
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS || 10000);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

function parseJsonEnv(name) {
  try {
    const parsed = JSON.parse(process.env[name] || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

const SEED_QUESTION = process.env.SEED_QUESTION || "";
const SEED_SQL = process.env.SEED_SQL || "";
const SEED_COLUMNS = parseJsonEnv("SEED_COLUMNS");
const SEED_ROWS = parseJsonEnv("SEED_ROWS");

const WRITE_KEYWORDS =
  /\\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|do|copy|vacuum|analyze|reindex|refresh|lock|comment|attach|detach|set|reset|begin|commit|rollback|savepoint|prepare|execute|listen|notify|discard|cluster|reassign|security|import)\\b/i;

function cleanSql(raw) {
  let sql = (raw || "").trim();
  const fence = sql.match(/^\`\`\`(?:sql)?\\s*([\\s\\S]*?)\\s*\`\`\`$/i);
  if (fence) sql = fence[1].trim();
  return sql.replace(/;\\s*$/, "").trim();
}

function guardReadOnly(raw) {
  const sql = cleanSql(raw);
  if (!sql) return { ok: false, sql, reason: "empty query" };
  if (sql.split(";").filter((s) => s.trim().length > 0).length > 1)
    return { ok: false, sql, reason: "multiple statements are not allowed" };
  const first = sql.replace(/^\\(+/, "").trimStart().split(/\\s+/)[0];
  const kw = (first || "").toLowerCase();
  if (kw !== "select" && kw !== "with")
    return { ok: false, sql, reason: "only SELECT / WITH queries are allowed" };
  const write = sql.match(WRITE_KEYWORDS);
  if (write)
    return { ok: false, sql, reason: "disallowed keyword: " + write[0].toUpperCase() };
  return { ok: true, sql };
}

function ensureLimit(sql, max) {
  return /\\blimit\\b/i.test(sql) ? sql : sql + " LIMIT " + max;
}

async function runSql(rawSql) {
  const guard = guardReadOnly(rawSql || "");
  if (!guard.ok) {
    const err = new Error(guard.reason);
    err.statusCode = 400;
    err.sql = guard.sql;
    throw err;
  }
  const sql = ensureLimit(guard.sql, MAX_ROWS);
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = " + STATEMENT_TIMEOUT_MS);
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(sql);
    await client.query("ROLLBACK");
    return {
      sql,
      columns: result.fields.map((f) => f.name),
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.rowCount >= MAX_ROWS,
    };
  } finally {
    client.release();
  }
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(json);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/") {
    return send(res, 200, {
      question: SEED_QUESTION,
      sql: SEED_SQL,
      columns: SEED_COLUMNS,
      rows: SEED_ROWS,
      note:
        "This endpoint runs read-only SQL against your database. The sample above was translated from a plain-English question by the agent during setup. POST /query { sql } to run your own read-only SELECT.",
    });
  }

  if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/query")
    return send(res, 404, { error: "POST /query, GET /, GET /health" });

  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", async () => {
    try {
      const body = JSON.parse(raw || "{}");
      const sql = typeof body.sql === "string" ? body.sql.trim() : "";
      const question = typeof body.question === "string" ? body.question.trim() : "";

      if (sql) return send(res, 200, await runSql(sql));

      if (question) {
        if (question === SEED_QUESTION) {
          return send(res, 200, {
            question: SEED_QUESTION,
            sql: SEED_SQL,
            columns: SEED_COLUMNS,
            rows: SEED_ROWS,
          });
        }
        return send(res, 400, {
          error:
            "This endpoint executes read-only SQL, not live natural language. See GET / for the agent's vetted sample; POST { sql: <SELECT> } to run your own.",
        });
      }

      return send(res, 400, {
        error:
          "POST /query { sql } (a read-only SELECT), or { question } for the seeded sample. GET /health, GET / for the sample.",
      });
    } catch (err) {
      send(res, err && err.statusCode ? err.statusCode : 500, {
        error: String(err && err.message ? err.message : err),
        sql: err && err.sql ? err.sql : undefined,
      });
    }
  });
});

server.listen(PORT, () => console.log("nl-db-query-endpoint listening on " + PORT));
`;

const SERVER_PACKAGE_JSON = JSON.stringify(
  {
    name: "nl-db-query-endpoint-server",
    private: true,
    type: "module",
    dependencies: { pg: "^8.11.0" },
  },
  null,
  2,
);

/**
 * Create and populate the demo tables (`customers`, `invoices`) when they are
 * missing or empty. Deploy runs `seed.sql` for the declared resource, so this
 * only fires when it did not (a local run, or a handle this run had to provision
 * itself). Idempotent by construction: it inserts only into an empty table, and
 * mirrors `seed.sql` exactly.
 *
 * Read-side only — these are the tables the endpoint ANSWERS QUESTIONS about;
 * nothing here is the template's own output.
 */
async function ensureSeeded(ctx: Ctx, sql: Sql): Promise<boolean> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS customers (
      id      bigserial PRIMARY KEY,
      name    text NOT NULL,
      country text NOT NULL,
      plan    text NOT NULL
    )`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS invoices (
      id          bigserial PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES customers (id),
      issued_on   date   NOT NULL,
      amount_usd  numeric(10, 2) NOT NULL,
      paid        boolean NOT NULL
    )`);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from customers`;
  if (count > 0) return false;
  ctx.logger.info("seeding the demo dataset");
  await sql.unsafe(`
    INSERT INTO customers (name, country, plan)
    SELECT * FROM (VALUES
      ('Northwind Traders', 'US', 'enterprise'),
      ('Contoso Ltd',       'US', 'pro'),
      ('Fabrikam GmbH',     'DE', 'pro'),
      ('Tailspin Toys',     'GB', 'free'),
      ('Adventure Works',   'AU', 'enterprise'),
      ('Wingtip Cycles',    'CA', 'free')
    ) AS demo(name, country, plan)`);
  await sql.unsafe(`
    INSERT INTO invoices (customer_id, issued_on, amount_usd, paid)
    SELECT
      1 + (n % 6),
      (CURRENT_DATE - (n * 3))::date,
      ROUND((120 + (n * 91) % 4200)::numeric, 2),
      (n % 4) <> 0
    FROM generate_series(0, 59) AS s(n)`);
  return true;
}

// ──────────────────────────────────────────────────────────────── steps ──

/** Validate the input and resolve config. Missing DB target → rejected. */
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. Every field is optional: with no
 * `dbHandle`/`connectionString` the run uses the managed demo database and its
 * seeded read-only dataset.
 */
const entryInput = z.object({
  dbHandle: z
    .string()
    .optional()
    .describe(
      "Sapiom-managed Postgres handle; its connection string is injected as DATABASE_URL.",
    ),
  connectionString: z
    .string()
    .optional()
    .describe("Explicit Postgres connection string (overrides dbHandle)."),
  sandboxName: z
    .string()
    .optional()
    .describe(
      "Sandbox name to host the endpoint (default nl-db-query-endpoint).",
    ),
  sampleQuestion: z
    .string()
    .optional()
    .describe(
      "A question used to preview the translate → guard path before deploying.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Optional routing label for the translation. Omit it to use the platform default.",
    ),
  maxRows: z
    .number()
    .optional()
    .describe("Max rows the endpoint returns per query (default 100)."),
  port: z
    .number()
    .optional()
    .describe("Port the endpoint listens on (default 3000)."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Assemble everything but skip the real deployPreview."),
});

const validate = defineStep({
  name: "validate",
  inputSchema: entryInput,
  next: ["resolve", "rejected"],
  async run(input: EntryInput, ctx: Ctx) {
    const config = resolveConfig(input);
    ctx.shared.set("config", config);
    if (config.usingDemoDatabase) {
      ctx.shared.set(
        "note",
        `No \`dbHandle\` or \`connectionString\` was given, so the run used the managed demo database \`${DEFAULT_DB_HANDLE}\` and its seeded read-only dataset. Point \`dbHandle\` at your own database to query yours.`,
      );
    }
    ctx.logger.info("input validated", {
      sandbox: config.sandboxName,
      hasHandle: Boolean(config.dbHandle),
      dryRun: config.dryRun,
    });
    return goto("resolve", {});
  },
});

/** Read the Postgres connection string to inject into the endpoint. */
const resolve = defineStep({
  name: "resolve",
  next: ["plan", "rejected"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    let connectionString = config.connectionString;
    if (!connectionString && config.dbHandle) {
      try {
        const db = await ctx.sapiom.database.get(config.dbHandle);
        connectionString = db.connection?.connectionString ?? "";
      } catch (err) {
        if (!config.usingDemoDatabase) {
          // The caller named a handle that does not exist. Say so plainly rather
          // than throw — and never fall back to a database they did not ask for.
          return goto("rejected", {
            reason: `no database named \`${config.dbHandle}\` was found (${String(err)})`,
          });
        }
        // A resource-shaped need PROVISIONS rather than rejects. Deploy normally
        // creates and seeds the declared demo database; this covers the case where
        // it did not.
        ctx.logger.info("provisioning the demo database", {
          handle: config.dbHandle,
        });
        const created = await ctx.sapiom.database.create({
          handle: config.dbHandle,
          duration: "7d",
          name: "NL DB Query demo",
          description:
            "Read-only demo dataset the endpoint answers questions over",
        });
        connectionString = created.connection?.connectionString ?? "";
      }
    }
    if (!connectionString && config.dryRun) {
      // No live handle needed to trace the graph offline.
      connectionString = "postgres://user:pass@localhost:5432/db";
    }

    // The managed demo database needs its customers/invoices tables loaded.
    // Deploy normally runs `seed.sql` for the declared resource before the first
    // run; this covers the case where it did not (a self-provision just above, or
    // a handle deploy never seeded). Idempotent, and skipped under `dryRun` — no
    // live connection exists to seed.
    if (config.usingDemoDatabase && !config.dryRun && connectionString) {
      const sql = postgres(connectionString, {
        ssl: "require",
        max: 1,
        idle_timeout: 5,
        connect_timeout: 10,
      });
      try {
        const seeded = await ensureSeeded(ctx, sql);
        if (seeded) ctx.logger.info("seeded the demo dataset");
      } catch (err) {
        // A seed failure degrades the DEMO ONLY, not the run: `execute` still
        // runs the sample query for real and, if the tables truly are missing,
        // fails honestly at `query_failed` rather than here.
        ctx.logger.warn("could not seed the demo database", {
          err: String(err),
        });
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }

    ctx.shared.set("connectionString", connectionString);
    ctx.logger.info("resolved connection string", {
      resolved: Boolean(connectionString),
    });
    return goto("plan", {});
  },
});

/**
 * Translate the sample question into SQL. On the seeded demo database with the
 * unmodified default question — the zero-setup path — this is a fixed,
 * known-safe SELECT written once by us, so it never depends on an LLM returning
 * valid SQL. Any other question or database still asks an LLM.
 */
const plan = defineStep({
  name: "plan",
  next: ["guard"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;

    if (
      config.usingDemoDatabase &&
      config.sampleQuestion === DEFAULT_QUESTION
    ) {
      ctx.logger.info("using the built-in deterministic sample query", {
        question: config.sampleQuestion,
      });
      return goto("guard", { sql: DEFAULT_SAMPLE_SQL });
    }

    const system = [
      "You translate a natural-language question into ONE read-only SQL query for PostgreSQL.",
      "Output ONLY the SQL: no prose, no markdown fences, no trailing semicolon.",
      "It MUST be a single SELECT (a leading WITH/CTE is fine). Never write or modify data.",
    ].join("\n");
    const res = await ctx.sapiom.llm.run({
      request: {
        system,
        messages: [
          { role: "user", content: `Question: ${config.sampleQuestion}` },
        ],
        max_tokens: 500,
      },
      model: config.model || undefined,
    });
    ctx.logger.info("sample translated", { question: config.sampleQuestion });
    return goto("guard", { sql: ctx.sapiom.llm.textOf(res) ?? "" });
  },
});

/** Apply the read-only guardrail to the sample SQL. Unsafe → rejected. */
const guard = defineStep({
  name: "guard",
  next: ["execute", "rejected"],
  async run(input: { sql: string }, ctx: Ctx) {
    const result = guardReadOnly(input?.sql ?? "");
    if (!result.ok) {
      ctx.logger.warn("guardrail rejected sample sql", {
        reason: result.reason,
      });
      return goto("rejected", { reason: result.reason, sql: result.sql });
    }
    ctx.shared.set("sampleSql", result.sql);
    ctx.logger.info("sample sql passed guardrail", { sql: result.sql });
    return goto("execute", {});
  },
});

/**
 * Run the guarded sample SQL for real against the resolved database, inside a
 * READ ONLY transaction with a statement timeout and the same row cap the
 * deployed endpoint enforces — the returned rows ARE the zero-setup artifact.
 * `dryRun` reports fixed sample rows instead of opening a connection; a real
 * connection or query failure routes to `query_failed` rather than faking rows.
 */
const execute = defineStep({
  name: "execute",
  next: ["deploy", "query_failed"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    const sampleSql = ctx.shared.get("sampleSql") ?? "";

    if (config.dryRun) {
      ctx.shared.set("sampleColumns", SAMPLE_COLUMNS);
      ctx.shared.set("sampleRows", SAMPLE_ROWS);
      ctx.shared.set("sampleRowCount", SAMPLE_ROWS.length);
      ctx.shared.set("sampleTruncated", false);
      ctx.logger.info(
        "dry run — reporting fixed sample rows instead of a live query",
      );
      return goto("deploy", {});
    }

    const connectionString = ctx.shared.get("connectionString") ?? "";
    if (!connectionString) {
      return goto("query_failed", {
        reason: "no database connection to query",
        sql: sampleSql,
      });
    }

    const sql = postgres(connectionString, {
      ssl: "require",
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    });
    try {
      const limited = ensureLimit(sampleSql, config.maxRows);
      const rows = await sql.begin("read only", (tx) => tx.unsafe(limited));
      const columns =
        rows.columns?.map((c) => c.name) ??
        (rows.length > 0 ? Object.keys(rows[0]) : []);
      ctx.shared.set("sampleColumns", columns);
      ctx.shared.set(
        "sampleRows",
        rows as unknown as Record<string, unknown>[],
      );
      ctx.shared.set("sampleRowCount", rows.length);
      ctx.shared.set("sampleTruncated", rows.length >= config.maxRows);
      ctx.logger.info("sample query executed", { rows: rows.length });
      return goto("deploy", {});
    } catch (err) {
      ctx.logger.error("sample query failed", { err: String(err) });
      return goto("query_failed", { reason: String(err), sql: sampleSql });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  },
});

/**
 * POST the vetted sample SQL to the freshly deployed `/query` and require a real
 * 200 with a rows array back. `deployPreview` returning a URL only means the
 * process started listening — it says nothing about whether the endpoint can
 * actually execute a query, which is the one thing this template promises.
 */
async function probeQueryEndpoint(
  url: string,
  sql: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, detail: `non-JSON response: ${text.slice(0, 500)}` };
    }
    if (!body || !Array.isArray((body as { rows?: unknown }).rows)) {
      return {
        ok: false,
        detail: `no rows array in response: ${text.slice(0, 500)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Write the endpoint server into a sandbox and expose it at a stable URL. */
const deploy = defineStep({
  name: "deploy",
  next: ["deployed", "deploy_failed"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    const connectionString = ctx.shared.get("connectionString") ?? "";
    const sampleSql = ctx.shared.get("sampleSql") ?? "";
    // The rows `execute` actually fetched (or, under dryRun, the fixed sample
    // rows) — the zero-setup artifact, carried through regardless of how the
    // endpoint deploy itself turns out. They're also seeded into the deployed
    // server's env as its `GET /` demo — the endpoint itself never re-derives
    // them, since it never calls an LLM.
    const sampleColumns = ctx.shared.get("sampleColumns") ?? [];
    const sampleRows = ctx.shared.get("sampleRows") ?? [];
    const sampleRowCount =
      ctx.shared.get("sampleRowCount") ?? sampleRows.length;
    const sampleTruncated = ctx.shared.get("sampleTruncated") ?? false;

    // No Sapiom credential of any kind: the deployed server only executes SQL it
    // is given, so DATABASE_URL is the only thing it needs to do its job.
    const env: Record<string, string> = {
      PORT: String(config.port),
      DATABASE_URL: connectionString,
      MAX_ROWS: String(config.maxRows),
      STATEMENT_TIMEOUT_MS: String(STATEMENT_TIMEOUT_MS),
      SEED_QUESTION: config.sampleQuestion,
      SEED_SQL: sampleSql,
      SEED_COLUMNS: JSON.stringify(sampleColumns),
      SEED_ROWS: JSON.stringify(sampleRows),
    };

    // Unique per run: `sandboxes.create` is not idempotent, so a fixed name
    // 409s (SANDBOX_ALREADY_EXISTS) on the second run against the same tenant.
    // Suffix the execution id so every run gets its own sandbox.
    const sandboxName = `${config.sandboxName}-${ctx.executionId}`;

    const queryEndpoint = (url: string) => `${url.replace(/\/$/, "")}/query`;
    const healthEndpoint = (url: string) => `${url.replace(/\/$/, "")}/health`;

    // Dry run: report the assembled env keys (names only, never values) and the
    // generated server, then stop before any real actuation — no sandbox, no
    // deployPreview, no probe.
    if (config.dryRun) {
      ctx.logger.info("dry run — skipping deployPreview", {
        sandbox: config.sandboxName,
        envKeys: Object.keys(env),
      });
      return goto("deployed", {
        dryRun: true,
        url: null,
        queryEndpoint: null,
        healthEndpoint: null,
        sampleQuestion: config.sampleQuestion,
        sampleSql,
        sampleColumns,
        sampleRows,
        sampleRowCount,
        sampleTruncated,
        envKeys: Object.keys(env),
        serverBytes: SERVER_SOURCE.length,
      });
    }

    try {
      const box = await ctx.sapiom.sandboxes.create({
        name: sandboxName,
        port: config.port,
      });
      // Write the server into an explicit absolute directory via `exec`, NOT
      // `box.writeFile`: a relative `writeFile("server.js")` resolves against
      // the sandbox's file root, which is one level below where the `fs` deploy
      // actually runs `npm install` — so the files land outside the build's cwd
      // and `npm install` fails with "no package.json". Anchoring the write AND
      // the build/start to the same absolute `APP_DIR` (base64-piped so the
      // source survives shell quoting) removes that mismatch entirely.
      const appDir = "/blaxel/nl-db-app";
      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      await box.exec(`mkdir -p "${appDir}"`, { timeout: 30_000 });
      await box.exec(
        `printf %s '${b64(SERVER_SOURCE)}' | base64 -d > "${appDir}/server.js"`,
        { timeout: 30_000 },
      );
      await box.exec(
        `printf %s '${b64(SERVER_PACKAGE_JSON)}' | base64 -d > "${appDir}/package.json"`,
        { timeout: 30_000 },
      );
      const res = await box.deployPreview({
        source: { kind: "fs" },
        build: `cd "${appDir}" && npm install`,
        start: `cd "${appDir}" && node server.js`,
        port: config.port,
        env,
      });
      ctx.logger.info("deployPreview result", {
        sandbox: sandboxName,
        status: res.status,
        url: res.url,
      });
      if (res.status === "failed" || !res.url) {
        return goto("deploy_failed", {
          status: res.status,
          logs: res.logs,
          sampleSql,
          sampleColumns,
          sampleRows,
          sampleRowCount,
          sampleTruncated,
        });
      }

      // A URL is not proof the endpoint works — POST its own vetted sample SQL
      // and require real rows back before calling the run `deployed`. A route
      // that can't answer its own query is worse than no route.
      const endpoint = queryEndpoint(res.url);
      const probe = await probeQueryEndpoint(endpoint, sampleSql);
      if (!probe.ok) {
        ctx.logger.warn("deployed endpoint failed its own vetted-query probe", {
          endpoint,
          detail: probe.detail,
        });
        return goto("deploy_failed", {
          status: "endpoint-unverified",
          detail: probe.detail,
          sampleSql,
          sampleColumns,
          sampleRows,
          sampleRowCount,
          sampleTruncated,
        });
      }

      return goto("deployed", {
        dryRun: false,
        url: res.url,
        queryEndpoint: endpoint,
        healthEndpoint: healthEndpoint(res.url),
        sampleQuestion: config.sampleQuestion,
        sampleSql,
        sampleColumns,
        sampleRows,
        sampleRowCount,
        sampleTruncated,
        envKeys: Object.keys(env),
        serverBytes: SERVER_SOURCE.length,
      });
    } catch (err) {
      ctx.logger.error("deploy threw", {
        sandbox: sandboxName,
        err: String(err),
      });
      return goto("deploy_failed", {
        status: "error",
        logs: String(err),
        sampleSql,
        sampleColumns,
        sampleRows,
        sampleRowCount,
        sampleTruncated,
      });
    }
  },
});

/** The endpoint is live (or, under dryRun, assembled). Terminal. */
const deployed = defineStep({
  name: "deployed",
  next: [],
  terminal: true,
  async run(
    input: {
      dryRun: boolean;
      url: string | null;
      queryEndpoint: string | null;
      healthEndpoint: string | null;
      sampleQuestion: string;
      sampleSql: string;
      sampleColumns: string[];
      sampleRows: Record<string, unknown>[];
      sampleRowCount: number;
      sampleTruncated: boolean;
      envKeys: string[];
      serverBytes: number;
    },
    ctx: Ctx,
  ) {
    return terminate({
      deployed: !input?.dryRun,
      dryRun: input?.dryRun ?? false,
      url: input?.url ?? null,
      queryEndpoint: input?.queryEndpoint ?? null,
      healthEndpoint: input?.healthEndpoint ?? null,
      sampleQuestion: input?.sampleQuestion ?? null,
      sampleSql: input?.sampleSql ?? null,
      sampleColumns: input?.sampleColumns ?? [],
      sampleRows: input?.sampleRows ?? [],
      sampleRowCount: input?.sampleRowCount ?? 0,
      sampleTruncated: input?.sampleTruncated ?? false,
      envKeys: input?.envKeys ?? null,
      serverBytes: input?.serverBytes ?? null,
      ...(ctx.shared.get("note") ? { note: ctx.shared.get("note") } : {}),
    });
  },
});

/**
 * The deploy failed — either `deployPreview` itself failed, or it returned a URL
 * that failed the post-deploy probe (its own vetted sample query didn't come
 * back with real rows). Terminal.
 */
const deploy_failed = defineStep({
  name: "deploy_failed",
  next: [],
  terminal: true,
  async run(input: {
    status: string;
    logs?: string | null;
    detail?: string;
    sampleSql?: string;
    sampleColumns?: string[];
    sampleRows?: Record<string, unknown>[];
    sampleRowCount?: number;
    sampleTruncated?: boolean;
  }) {
    return terminate({
      deployed: false,
      failed: true,
      status: input?.status ?? null,
      logs: input?.logs ?? null,
      // Set only for the post-deploy probe failure path (`endpoint-unverified`):
      // the probe's HTTP status / response-body tail, not deployPreview logs.
      detail: input?.detail ?? null,
      // The sample query genuinely ran even though the sandbox deploy failed —
      // report it rather than discarding a real result on a partial failure.
      sampleSql: input?.sampleSql ?? null,
      sampleColumns: input?.sampleColumns ?? [],
      sampleRows: input?.sampleRows ?? [],
      sampleRowCount: input?.sampleRowCount ?? 0,
      sampleTruncated: input?.sampleTruncated ?? false,
    });
  },
});

/**
 * The guarded sample SQL could not be executed for real against the resolved
 * database (no connection, or the query itself errored). Terminal, and honest:
 * no rows are reported because none were fetched.
 */
const query_failed = defineStep({
  name: "query_failed",
  next: [],
  terminal: true,
  async run(input: { reason: string; sql?: string }) {
    return terminate({
      deployed: false,
      queryFailed: true,
      reason: input?.reason ?? "the sample query could not be executed",
      sql: input?.sql ?? null,
    });
  },
});

/** Input or the sample SQL failed the guardrail — nothing was deployed. Terminal. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason: string; sql?: string }) {
    return terminate({
      deployed: false,
      rejected: true,
      reason: input?.reason ?? "rejected",
      sql: input?.sql ?? null,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "nl-db-query-endpoint",
  entry: "validate",
  steps: {
    validate,
    resolve,
    plan,
    guard,
    execute,
    deploy,
    deployed,
    deploy_failed,
    query_failed,
    rejected,
  },
});
