import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Natural-Language DB Query Endpoint — deploy a live HTTP endpoint that turns a
 * plain-English question into a read-only SQL query and returns the answer.
 *
 * One run stands up the endpoint; the endpoint answers questions.
 *
 *   validate ─▶ resolve ─▶ plan ─▶ guard ─┬─▶ deploy ─┬─▶ deployed      (terminal)
 *              (database   (models  (read-  │          └─▶ deploy_failed (terminal)
 *               .get)       .run)   only    └─▶ rejected                (terminal)
 *                                   check)
 *
 *   1. validate — check the input (a database handle or connection string) and
 *      resolve config (sample question, port, row cap, model).
 *   2. resolve  — read the target Postgres connection string from a Sapiom-managed
 *      database handle (`database.get`) so it can be injected into the endpoint.
 *   3. plan     — preview the pipeline: translate the sample question into SQL with
 *      an LLM (`models.run`), system-prompted to emit a single read-only SELECT.
 *   4. guard    — apply the read-only guardrail to that sample SQL. Anything that
 *      isn't a single read-only statement routes to `rejected` — the endpoint is
 *      only deployed once the safe path is proven.
 *   5. deploy   — write a small server (which re-runs translate → guard → execute
 *      per request) into a sandbox and expose it at a stable URL
 *      (`sandboxes.deployPreview`). DATABASE_URL and the server's own
 *      SAPIOM_API_KEY (read from the vault at deploy time, `vault.get`) are
 *      injected as env — never baked into source.
 *   6. deployed / deploy_failed / rejected — terminal.
 *
 * The read-only guardrail is defense-in-depth: the LLM is *told* to emit a SELECT,
 * the SQL is *checked* (single statement, starts with SELECT/WITH, no DDL/DML
 * keywords), and the endpoint *executes* it inside `BEGIN TRANSACTION READ ONLY`
 * with a statement timeout and a row cap — the last of which Postgres enforces at
 * the engine level, so a write can't slip through even if the first two are wrong.
 *
 * `run_local` stubs `models.run`, so on defaults the `plan` output is a non-SQL
 * placeholder and `guard` routes to `rejected` — a legible demo of the guardrail
 * refusing junk. Pass a stub override that returns a real SELECT (see AGENTS.md)
 * and add `{ "dryRun": true }` to trace the deploy branch offline for free.
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
  /** Vault ref holding the server's SAPIOM_API_KEY (best practice). */
  vaultRef?: string;
  /** Vault key name for the server's API key (default `sapiom_api_key`). */
  vaultKey?: string;
  /** Dev-only fallback: inject the server's SAPIOM_API_KEY directly. Prefer the vault. */
  sapiomApiKey?: string;
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
  vaultRef: string;
  vaultKey: string;
  sapiomApiKey: string;
  dryRun: boolean;
}

interface Shared extends Record<string, unknown> {
  config: Config;
  connectionString: string;
  sampleSql: string;
}

type Ctx = AgentExecutionContext<Shared>;

const DEFAULT_SANDBOX = "nl-db-query-endpoint";
const DEFAULT_QUESTION = "How many rows are in each table?";
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_PORT = 3000;
const DEFAULT_VAULT_KEY = "sapiom_api_key";

function resolveConfig(input: EntryInput | undefined): Config {
  return {
    dbHandle: input?.dbHandle?.trim() ?? "",
    connectionString: input?.connectionString?.trim() ?? "",
    sandboxName: input?.sandboxName?.trim() || DEFAULT_SANDBOX,
    sampleQuestion: input?.sampleQuestion?.trim() || DEFAULT_QUESTION,
    model: input?.model?.trim() ?? "",
    maxRows: input?.maxRows ?? DEFAULT_MAX_ROWS,
    port: input?.port ?? DEFAULT_PORT,
    vaultRef: input?.vaultRef?.trim() ?? "",
    vaultKey: input?.vaultKey?.trim() || DEFAULT_VAULT_KEY,
    sapiomApiKey: input?.sapiomApiKey ?? "",
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

// ─────────────────────────────────────────────────────── the endpoint app ──
// Uploaded verbatim to the sandbox. Reads all config from env (injected at
// deploy time). On POST /query it introspects the schema (cached), asks the LLM
// for a read-only SELECT, re-checks it with the same guardrail, then runs it in a
// READ ONLY transaction with a statement timeout and a row cap. No backticks / no
// ${} here so it embeds cleanly as a template-literal string above.

const SERVER_SOURCE = `import http from "node:http";
import { createClient } from "@sapiom/tools";
import pg from "pg";

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.SAPIOM_MODEL || "";
const MAX_ROWS = Number(process.env.MAX_ROWS || 100);
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS || 10000);

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

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

let schemaCache = null;
async function describeSchema() {
  if (schemaCache) return schemaCache;
  const { rows } = await pool.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns " +
      "WHERE table_schema NOT IN ('pg_catalog','information_schema') " +
      "ORDER BY table_name, ordinal_position",
  );
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r.column_name + " " + r.data_type);
  }
  const lines = [];
  for (const [t, cols] of byTable) lines.push(t + "(" + cols.join(", ") + ")");
  schemaCache = lines.join("\\n") || "(no user tables)";
  return schemaCache;
}

const SYSTEM = [
  "You translate a natural-language question into ONE read-only SQL query for PostgreSQL.",
  "Rules:",
  "- Output ONLY the SQL. No prose, no markdown fences, no trailing semicolon.",
  "- It MUST be a single SELECT (a leading WITH/CTE is fine). Never write or modify data.",
  "- Use only the tables and columns in the provided schema.",
].join("\\n");

async function answer(question) {
  const schema = await describeSchema();
  const res = await sapiom.models.run({
    system: SYSTEM,
    prompt: "Schema:\\n" + schema + "\\n\\nQuestion: " + question,
    model: MODEL || undefined,
    maxTokens: 500,
  });
  const guard = guardReadOnly(res.output || "");
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
      question,
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
  if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/query")
    return send(res, 404, { error: "POST /query { question } or GET /health" });
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", async () => {
    try {
      const question = (JSON.parse(raw || "{}").question || "").trim();
      if (!question) return send(res, 400, { error: "missing 'question'" });
      send(res, 200, await answer(question));
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
    dependencies: { "@sapiom/tools": "^0.20.0", pg: "^8.11.0" },
  },
  null,
  2,
);

// ──────────────────────────────────────────────────────────────── steps ──

/** Validate the input and resolve config. Missing DB target → rejected. */
const validate = defineStep({
  name: "validate",
  next: ["resolve", "rejected"],
  async run(input: EntryInput, ctx: Ctx) {
    const config = resolveConfig(input);
    ctx.shared.set("config", config);
    if (!config.dbHandle && !config.connectionString) {
      return goto("rejected", {
        reason:
          "provide a `dbHandle` or a `connectionString` for the target database",
      });
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
  next: ["plan"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    let connectionString = config.connectionString;
    if (!connectionString && config.dbHandle) {
      const db = await ctx.sapiom.database.get(config.dbHandle);
      connectionString = db.connection?.connectionString ?? "";
    }
    if (!connectionString && config.dryRun) {
      // No live handle needed to trace the graph offline.
      connectionString = "postgres://user:pass@localhost:5432/db";
    }
    ctx.shared.set("connectionString", connectionString);
    ctx.logger.info("resolved connection string", {
      resolved: Boolean(connectionString),
    });
    return goto("plan", {});
  },
});

/** Preview the translate step: sample question → SQL via the LLM. */
const plan = defineStep({
  name: "plan",
  next: ["guard"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    const system = [
      "You translate a natural-language question into ONE read-only SQL query for PostgreSQL.",
      "Output ONLY the SQL: no prose, no markdown fences, no trailing semicolon.",
      "It MUST be a single SELECT (a leading WITH/CTE is fine). Never write or modify data.",
    ].join("\n");
    const res = await ctx.sapiom.models.run({
      system,
      prompt: `Question: ${config.sampleQuestion}`,
      model: config.model || undefined,
      maxTokens: 500,
    });
    ctx.logger.info("sample translated", { question: config.sampleQuestion });
    return goto("guard", { sql: res.output ?? "" });
  },
});

/** Apply the read-only guardrail to the sample SQL. Unsafe → rejected. */
const guard = defineStep({
  name: "guard",
  next: ["deploy", "rejected"],
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
    return goto("deploy", {});
  },
});

/** Write the endpoint server into a sandbox and expose it at a stable URL. */
const deploy = defineStep({
  name: "deploy",
  next: ["deployed", "deploy_failed"],
  async run(_input: unknown, ctx: Ctx) {
    const config = ctx.shared.get("config")!;
    const connectionString = ctx.shared.get("connectionString") ?? "";
    const sampleSql = ctx.shared.get("sampleSql") ?? "";

    // The server's own API key (used to call models.run per request): read from
    // the vault at deploy time, or fall back to the dev-only input.
    let apiKey = config.sapiomApiKey;
    if (!apiKey && config.vaultRef) {
      try {
        apiKey =
          (await ctx.sapiom.vault.get(config.vaultRef, config.vaultKey)) ?? "";
      } catch (err) {
        ctx.logger.warn("vault read failed", {
          ref: config.vaultRef,
          key: config.vaultKey,
          err: String(err),
        });
      }
    }

    const env: Record<string, string> = {
      PORT: String(config.port),
      DATABASE_URL: connectionString,
      SAPIOM_MODEL: config.model,
      MAX_ROWS: String(config.maxRows),
    };
    if (apiKey) env.SAPIOM_API_KEY = apiKey;

    const queryEndpoint = (url: string) => `${url.replace(/\/$/, "")}/query`;
    const healthEndpoint = (url: string) => `${url.replace(/\/$/, "")}/health`;

    // Dry run: report the assembled env keys (names only, never values) and the
    // generated server, then stop before any real actuation.
    if (config.dryRun) {
      ctx.logger.info("dry run — skipping deployPreview", {
        sandbox: config.sandboxName,
        envKeys: Object.keys(env),
        hasApiKey: Boolean(apiKey),
      });
      return goto("deployed", {
        dryRun: true,
        url: null,
        queryEndpoint: null,
        healthEndpoint: null,
        sampleQuestion: config.sampleQuestion,
        sampleSql,
        envKeys: Object.keys(env),
        serverBytes: SERVER_SOURCE.length,
      });
    }

    try {
      const box = await ctx.sapiom.sandboxes.create({
        name: config.sandboxName,
        port: config.port,
      });
      await box.writeFile("server.js", SERVER_SOURCE);
      await box.writeFile("package.json", SERVER_PACKAGE_JSON);
      const res = await box.deployPreview({
        source: { kind: "fs" },
        build: "npm install",
        start: "node server.js",
        port: config.port,
        env,
      });
      ctx.logger.info("deployPreview result", {
        sandbox: config.sandboxName,
        status: res.status,
        url: res.url,
      });
      if (res.status === "failed" || !res.url) {
        return goto("deploy_failed", { status: res.status, logs: res.logs });
      }
      return goto("deployed", {
        dryRun: false,
        url: res.url,
        queryEndpoint: queryEndpoint(res.url),
        healthEndpoint: healthEndpoint(res.url),
        sampleQuestion: config.sampleQuestion,
        sampleSql,
        envKeys: Object.keys(env),
        serverBytes: SERVER_SOURCE.length,
      });
    } catch (err) {
      ctx.logger.error("deploy threw", {
        sandbox: config.sandboxName,
        err: String(err),
      });
      return goto("deploy_failed", { status: "error", logs: String(err) });
    }
  },
});

/** The endpoint is live (or, under dryRun, assembled). Terminal. */
const deployed = defineStep({
  name: "deployed",
  next: [],
  terminal: true,
  async run(input: {
    dryRun: boolean;
    url: string | null;
    queryEndpoint: string | null;
    healthEndpoint: string | null;
    sampleQuestion: string;
    sampleSql: string;
    envKeys: string[];
    serverBytes: number;
  }) {
    return terminate({
      deployed: !input?.dryRun,
      dryRun: input?.dryRun ?? false,
      url: input?.url ?? null,
      queryEndpoint: input?.queryEndpoint ?? null,
      healthEndpoint: input?.healthEndpoint ?? null,
      sampleQuestion: input?.sampleQuestion ?? null,
      sampleSql: input?.sampleSql ?? null,
      envKeys: input?.envKeys ?? null,
      serverBytes: input?.serverBytes ?? null,
    });
  },
});

/** The deploy failed — surface the deployPreview logs. Terminal. */
const deploy_failed = defineStep({
  name: "deploy_failed",
  next: [],
  terminal: true,
  async run(input: { status: string; logs: string | null }) {
    return terminate({
      deployed: false,
      failed: true,
      status: input?.status ?? null,
      logs: input?.logs ?? null,
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
    deploy,
    deployed,
    deploy_failed,
    rejected,
  },
});
