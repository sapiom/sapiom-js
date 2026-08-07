import {
  defineAgent,
  defineStep,
  goto,
  resolveResourceHandle,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { EmailHttpError, fileStorage } from "@sapiom/tools";
import postgres from "postgres";
import { z } from "zod/v4";

/**
 * Scheduled DB Snapshot to Insight Report — on a cron cadence, take a snapshot of
 * a database, have an LLM spot what's anomalous in it, write the narrative, run a
 * second query informed by that anomaly, render the numbers into charts in a
 * sandbox, and email the finished report.
 *
 * In one legible graph:
 *   snapshot (database) ──▶ detectAnomalies (models.run) ──▶ narrate (models.run)
 *     ──▶ followUp (database) ──▶ chart (sandbox + fileStorage) ──▶ deliver (email)
 *
 *   - **snapshot** runs a set of read-only SQL queries against a Postgres database
 *     and normalizes each result into a metric — a labeled series (for a bar chart)
 *     or a single scalar (a KPI). The default queries introspect the database's own
 *     catalog (rows per table, table count, database size), so it produces a real
 *     snapshot on any database with zero configuration; pass your own `queries` to
 *     report on your actual data.
 *   - **detectAnomalies** hands those metrics to an LLM (`ctx.sapiom.models.run`) to
 *     pick out the single most notable outlier or change — the number most worth a
 *     human's attention — and cite the actual figures. A deterministic fallback
 *     (the largest series point vs. the runner-up) covers an empty snapshot or an
 *     unusable model response, so this step never has nothing to say.
 *   - **narrate** reads the metrics AND the flagged anomaly and writes a short
 *     markdown insight report that leads with it: an executive summary, a few
 *     bullet insights that cite the numbers, and a line on what to watch.
 *   - **followUp** recommends and runs a SECOND, data-driven query targeted at
 *     whatever table the anomaly named — Postgres's own activity counters
 *     (inserts/updates/deletes, scans) for that one table, from `pg_stat_user_tables`.
 *     It's a system-catalog read, so it's safe and meaningful on any Postgres
 *     database, not just the seeded demo. No named table (a scalar-only snapshot,
 *     or a model response with nothing usable) skips it and says so.
 *   - **chart** spins up a sandbox, writes a tiny dependency-free Node renderer plus
 *     the metrics (and the follow-up read, when there is one) as JSON, runs it to
 *     produce an SVG bar chart, then uploads that SVG to file storage and takes a
 *     shareable download URL. The sandbox is torn down when the step ends. The
 *     rendered SVG is the only large payload here — it dies at the chart boundary;
 *     only the URL crosses into the report.
 *   - **deliver** assembles the report (narrative + anomaly + follow-up + chart link
 *     + a compact metrics table) and emails it. A `dryRun` (or a run with no
 *     recipient) returns the report as a preview without sending, so `run_local`
 *     traces the whole graph for free (capabilities stubbed, the real DB query and
 *     the send skipped).
 *
 * Side-effect discipline (copied from `error-triage-digest` / `scheduled-research-brief`):
 *   - The real SQL is gated behind `dryRun`: a dry run reports on sample metrics so
 *     the graph traces offline without connecting to a database. The two LLM steps
 *     (`detectAnomalies`, `narrate`) run for real either way — they are the world's
 *     response to whatever metrics are on hand, sample or not.
 *   - The recipient — and an optional external database URL — are read from the
 *     injected environment for a DSN, and ordinary run input for the recipient.
 *   - Non-deterministic values (the snapshot timestamp) are captured once at the DB
 *     boundary via Postgres `now()`, not recomputed per step.
 */

// ─────────────────────────────────────────────────────────────── config ──
/**
 * Postgres handle the report reads from. Declared in `template.json` as a
 * `resources[]` entry with `seed: "seed.sql"`, so deploy provisions it and loads
 * demo rows before the first run — a freshly-provisioned database is empty, and a
 * report over an empty database is a successful run that says nothing.
 */
const DEFAULT_DB_HANDLE = "db-insight-demo";
/**
 * Env key holding a connection string for YOUR OWN database. A DSN is a real
 * third-party credential, so it is declared as a required secret in
 * `template.json` and the platform injects it into this step's environment.
 */
const DATABASE_URL_KEY = "REPORT_DATABASE_URL";
/** Default cadence documented for the cron trigger: 08:00 every day. */
const DEFAULT_SCHEDULE = "0 8 * * *";
/** Cap the queries a single run will execute — bounds cost + latency. */
const MAX_QUERIES = 12;
/** Cap the rows charted per series — a bar chart past this is unreadable anyway. */
const MAX_POINTS = 12;
/** Per-query statement timeout so one slow query can't stall the run. */
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Default queries: catalog introspection that works on ANY Postgres database and
 * needs no knowledge of the schema. Override with your own `queries` to report on
 * real data. Each query returns `label` / `value` columns (a single `value` row is
 * read as a scalar KPI).
 */
const DEFAULT_QUERIES: MetricQuery[] = [
  {
    name: "Rows per table (top 10)",
    sql: `select relname as label, n_live_tup as value
            from pg_stat_user_tables
            order by n_live_tup desc
            limit 10`,
  },
  {
    name: "User tables",
    sql: `select count(*)::int as value from pg_stat_user_tables`,
  },
  {
    name: "Database size (MB)",
    sql: `select round(pg_database_size(current_database()) / 1048576.0, 2) as value`,
  },
];

/** Sample metrics used on a dry run so the graph traces without a real database. */
const SAMPLE_METRICS: Metric[] = [
  {
    name: "Rows per table (top 10)",
    kind: "series",
    points: [
      { label: "events", value: 81_300 },
      { label: "users", value: 12_840 },
      { label: "orders", value: 9_420 },
      { label: "sessions", value: 6_110 },
      { label: "invoices", value: 2_305 },
    ],
  },
  { name: "User tables", kind: "scalar", value: 14 },
  { name: "Database size (MB)", kind: "scalar", value: 48.2 },
];

/**
 * Sample follow-up read used on a dry run so `followUp` traces without a query.
 * Named after whichever table the (real, model-driven) anomaly step actually
 * flagged, so a dry run never shows an activity read for a table the anomaly
 * above it didn't name.
 */
function sampleFollowUp(table: string): SeriesMetric {
  return {
    name: `Activity on \`${table}\``,
    kind: "series",
    points: [
      { label: "inserts", value: 4_210 },
      { label: "updates", value: 128 },
      { label: "deletes", value: 0 },
      { label: "sequential scans", value: 3 },
      { label: "index scans", value: 512 },
    ],
  };
}

// ─────────────────────────────────────────────────────────────── shapes ──
/** A named read-only query. `sql` should return `label` / `value` columns. */
interface MetricQuery {
  name: string;
  sql: string;
}

interface EntryInput {
  /** Queries to snapshot; defaults to catalog introspection when omitted. */
  queries?: MetricQuery[];
  /** Cron cadence this report is meant to run on (documentation only). */
  schedule?: string;
  /** Postgres handle to snapshot; defaults to the template handle. */
  dbHandle?: string;
  /** Recipient email. Omit it and the report is returned inline instead of emailed. */
  deliverTo?: string;
  /** Report on sample metrics and skip the DB query and the real send. */
  dryRun?: boolean;
}

/** A metric: either a labeled series (charted) or a single scalar (a KPI). */
type Metric =
  | {
      name: string;
      kind: "series";
      points: Array<{ label: string; value: number }>;
    }
  | { name: string; kind: "scalar"; value: number };

/** The series-shaped half of `Metric` — what a follow-up read always produces. */
type SeriesMetric = Extract<Metric, { kind: "series" }>;

/**
 * What `detectAnomalies` flags as the single most notable outlier or change.
 * `table` is the seam `followUp` reads to target its drill-down query — only
 * ever a label the snapshot itself returned (see `coerceAnomaly`), so a model's
 * free text can't become an arbitrary lookup.
 */
interface Anomaly {
  table: string | null;
  metric: string;
  description: string;
  severity: "low" | "medium" | "high";
}

interface Shared extends Record<string, unknown> {
  dbHandle: string;
  schedule: string;
  deliverTo: string | null;
  dryRun: boolean;
  generatedAt: string;
  narrative: string;
  /** One plain sentence on what the follow-up query found (or why it didn't run). */
  followUpNote?: string;
  /** True when the snapshot came from the caller's own database. */
  external?: boolean;
  /** True when this run had to provision the managed Postgres itself. */
  provisioned?: boolean;
  /** One plain sentence about which database was read and what was defaulted. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

// ─────────────────────────────────────────────────────────────── helpers ──
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Coerce a pg value to a finite number, defaulting to 0. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Bound + validate the caller's queries; fall back to the defaults. */
function resolveQueries(raw: unknown): MetricQuery[] {
  if (!Array.isArray(raw)) return DEFAULT_QUERIES;
  const queries = raw
    .filter((q): q is MetricQuery => Boolean(q) && typeof q === "object")
    .map((q) => ({
      name: String((q as MetricQuery).name ?? "").trim() || "Metric",
      sql: String((q as MetricQuery).sql ?? "").trim(),
    }))
    .filter((q) => q.sql.length > 0)
    .slice(0, MAX_QUERIES);
  return queries.length > 0 ? queries : DEFAULT_QUERIES;
}

/**
 * Normalize a query result into a metric. A single row with only a `value` column
 * is a scalar KPI; anything else is a labeled series (first/`label` column as the
 * label, `value`/second column as the number).
 */
function toMetric(name: string, rows: Record<string, unknown>[]): Metric {
  if (rows.length === 0) return { name, kind: "series", points: [] };
  const cols = Object.keys(rows[0]);
  const labelCol = cols.find((c) => c.toLowerCase() === "label") ?? cols[0];
  const valueCol =
    cols.find((c) => c.toLowerCase() === "value") ??
    cols.find((c) => c !== labelCol) ??
    cols[0];

  if (rows.length === 1 && (cols.length === 1 || labelCol === valueCol)) {
    return { name, kind: "scalar", value: num(rows[0][valueCol]) };
  }
  const points = rows.slice(0, MAX_POINTS).map((row) => ({
    label: String(row[labelCol] ?? ""),
    value: num(row[valueCol]),
  }));
  return { name, kind: "series", points };
}

/** Render metrics as plain text for a model prompt. Shared by both LLM steps. */
function renderMetrics(metrics: Metric[]): string {
  return metrics
    .map((m) =>
      m.kind === "scalar"
        ? `${m.name}: ${m.value}`
        : `${m.name}:\n${m.points
            .map((p) => `  - ${p.label}: ${p.value}`)
            .join("\n")}`,
    )
    .join("\n");
}

/** Best-effort extraction of a single JSON object from model output. */
function extractJson(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Deterministic anomaly fallback: the largest point across every series metric,
 * compared to the runner-up in its own series. Covers an empty snapshot and an
 * unusable model response, so `detectAnomalies` never has nothing to say.
 */
function deterministicAnomaly(metrics: Metric[]): Anomaly {
  const series = metrics.filter(
    (m): m is Extract<Metric, { kind: "series" }> =>
      m.kind === "series" && m.points.length > 0,
  );
  if (series.length === 0) {
    return {
      table: null,
      metric: metrics[0]?.name ?? "",
      description:
        "No labeled series in this snapshot to compare, so nothing stands out as an outlier.",
      severity: "low",
    };
  }
  let best: {
    seriesName: string;
    label: string;
    value: number;
    runnerUp: number;
  } | null = null;
  for (const s of series) {
    const sorted = [...s.points].sort((a, b) => b.value - a.value);
    const top = sorted[0];
    const runnerUp = sorted[1]?.value ?? 0;
    if (!best || top.value > best.value) {
      best = {
        seriesName: s.name,
        label: top.label,
        value: top.value,
        runnerUp,
      };
    }
  }
  if (!best) {
    return {
      table: null,
      metric: series[0].name,
      description: "Nothing stands out as an outlier in this snapshot.",
      severity: "low",
    };
  }
  const ratio = best.runnerUp > 0 ? best.value / best.runnerUp : best.value;
  return {
    table: best.label,
    metric: best.seriesName,
    description: `\`${best.label}\` leads \`${best.seriesName}\` at ${best.value}${
      best.runnerUp > 0
        ? `, ${ratio.toFixed(1)}x the runner-up (${best.runnerUp})`
        : ""
    }.`,
    severity: ratio >= 3 ? "high" : ratio >= 1.5 ? "medium" : "low",
  };
}

/**
 * Coerce the anomaly-step model output into an `Anomaly`, falling back field by
 * field. `table` is only ever trusted when it names a label the snapshot ACTUALLY
 * returned — the model's free text never becomes a query parameter otherwise.
 */
function coerceAnomaly(
  output: string | null,
  metrics: Metric[],
  fallback: Anomaly,
): Anomaly {
  const obj = extractJson(output);
  if (!obj) return fallback;
  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : fallback.description;
  const severity: Anomaly["severity"] =
    obj.severity === "low" ||
    obj.severity === "medium" ||
    obj.severity === "high"
      ? obj.severity
      : fallback.severity;
  const metric =
    typeof obj.metric === "string" && obj.metric.trim()
      ? obj.metric.trim()
      : fallback.metric;
  const knownLabels = new Set(
    metrics.flatMap((m) =>
      m.kind === "series" ? m.points.map((p) => p.label) : [],
    ),
  );
  const table =
    typeof obj.table === "string" && knownLabels.has(obj.table)
      ? obj.table
      : fallback.table;
  return { table, metric, description, severity };
}

/** What `resolveConnectionString` connected to, so the report can say so. */
interface Target {
  connectionString: string;
  /** True when the DSN came from the injected env — i.e. your own database. */
  external: boolean;
  /** True when this run had to provision the managed Postgres itself. */
  provisioned: boolean;
}

/**
 * Resolve the connection string at runtime. An injected DSN wins (report on your
 * own database, value never persisted); otherwise the declared Sapiom-managed
 * Postgres is looked up by handle, and provisioned here if deploy did not.
 */
async function resolveConnectionString(
  ctx: Ctx,
  handle: string,
): Promise<Target | null> {
  const external = process.env[DATABASE_URL_KEY]?.trim();
  if (external) {
    return { connectionString: external, external: true, provisioned: false };
  }
  let db;
  let provisioned = false;
  try {
    db = await ctx.sapiom.database.get(handle);
  } catch {
    // Two ways to land here and the API cannot tell them apart: the handle has
    // never existed, or it expired. A managed Postgres caps at 7d with no renew
    // verb, so on a schedule the second case is the likely one — which is why the
    // run reports that it provisioned rather than silently starting over.
    provisioned = true;
    db = await ctx.sapiom.database.create({
      handle,
      duration: "7d",
      name: "DB Insight Report demo",
      description: "Demo dataset the scheduled insight report snapshots",
    });
  }
  const connectionString = db.connection?.connectionString ?? null;
  if (!connectionString) return null;
  return { connectionString, external: false, provisioned };
}

/** Open a connection to `handle` with the same bounds every step reuses. */
function connect(connectionString: string): Sql {
  return postgres(connectionString, {
    ssl: "require",
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    // Bound every query on this connection so one slow statement can't stall
    // the run.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
  });
}

/**
 * Create and populate the demo tables when they are missing or empty. Deploy runs
 * `seed.sql` for the declared resource, so this only fires when it did not (a
 * local run, or a handle this run had to provision itself). Idempotent by
 * construction: it inserts only into an empty table.
 *
 * Read-side only. These tables are what the report READS; nothing here writes the
 * template's own output, which must never be seeded.
 */
async function ensureSeeded(ctx: Ctx, sql: Sql): Promise<boolean> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS demo_orders (
      id bigserial PRIMARY KEY,
      placed_on date NOT NULL,
      region text NOT NULL,
      amount_usd numeric(10,2) NOT NULL,
      status text NOT NULL
    )`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS demo_signups (
      id bigserial PRIMARY KEY,
      signed_up_on date NOT NULL,
      plan text NOT NULL,
      source text NOT NULL
    )`);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from demo_orders`;
  if (count > 0) return false;
  ctx.logger.info("seeding the demo dataset");
  await sql.unsafe(`
    INSERT INTO demo_orders (placed_on, region, amount_usd, status)
    SELECT (CURRENT_DATE - (n % 28))::date,
           (ARRAY['us-east','us-west','eu-central','apac'])[1 + (n % 4)],
           ROUND((45 + (n * 37) % 900)::numeric, 2),
           (ARRAY['paid','paid','paid','refunded','pending'])[1 + (n % 5)]
    FROM generate_series(1, 240) AS s(n)`);
  await sql.unsafe(`
    INSERT INTO demo_signups (signed_up_on, plan, source)
    SELECT (CURRENT_DATE - (n % 28))::date,
           (ARRAY['free','free','pro','enterprise'])[1 + (n % 4)],
           (ARRAY['organic','referral','paid-search','partner'])[1 + (n % 4)]
    FROM generate_series(1, 130) AS s(n)`);
  return true;
}

/**
 * Reuse an existing inbox to send from, else provision one.
 *
 * We deliberately omit `username`. AgentMail addresses are globally unique, so a
 * fixed local part can only ever be owned by ONE account across the whole
 * platform — every other tenant's `create` 409s with "Email address is already
 * taken", which fails the step. Omitting it lets AgentMail auto-generate a
 * globally-unique address, so a fresh tenant's first run succeeds and two
 * tenants never collide. `create` still isn't atomic against the `list`, so a
 * 409 is treated as "someone already provisioned one" — re-list and reuse.
 */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({
      displayName: "DB Insight Report",
    });
    return inbox.inboxId;
  } catch (err) {
    if (err instanceof EmailHttpError && err.status === 409) {
      const retry = await ctx.sapiom.email.inboxes.list({ limit: 1 });
      if (retry.inboxes.length > 0) return retry.inboxes[0].inboxId;
    }
    throw err;
  }
}

/**
 * `followUp`'s drill-down: activity counters for ONE flagged table, straight from
 * Postgres's own stats catalog. This is a system-catalog read — it never touches
 * user schema, so it's safe and meaningful on ANY Postgres database, not just the
 * seeded demo — and it's parameterized, so a stray table name can't become SQL.
 */
const FOLLOW_UP_SQL = `
  select n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes,
         seq_scan as sequential_scans, coalesce(idx_scan, 0) as index_scans
    from pg_stat_user_tables
   where relname = $1`;

async function runFollowUpQuery(
  sql: Sql,
  table: string,
): Promise<SeriesMetric | null> {
  const rows = await sql.unsafe(FOLLOW_UP_SQL, [table]);
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const points = Object.entries(row).map(([label, value]) => ({
    label: label.replace(/_/g, " "),
    value: num(value),
  }));
  return { name: `Activity on \`${table}\``, kind: "series", points };
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. Every field is optional: a
 * zero-input run reports on sample metrics (see `dryRun`) and the template
 * handle backs `dbHandle`.
 */
const entryInput = z.object({
  queries: z
    .array(z.object({ name: z.string(), sql: z.string() }))
    .optional()
    .describe(
      "Advanced: read-only queries to snapshot, each `{ name, sql }` where `sql` returns `label`/`value` columns. Optional — defaults to catalog introspection when omitted.",
    ),
  schedule: z
    .string()
    .optional()
    .describe("Cron cadence this report runs on (documentation only)."),
  dbHandle: z
    .string()
    .optional()
    .describe("Postgres handle to snapshot; defaults to the template handle."),
  deliverTo: z
    .string()
    .optional()
    .describe(
      "Recipient email. Omit it and the report is returned inline instead of emailed.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Report on sample metrics and skip the DB query and the real send.",
    ),
});

const snapshot = defineStep({
  name: "snapshot",
  inputSchema: entryInput,
  next: ["detectAnomalies"],
  async run(input: EntryInput, ctx: Ctx) {
    const dryRun = truthy(input.dryRun);
    const handle = resolveResourceHandle(input, {
      fallback: DEFAULT_DB_HANDLE,
    });
    ctx.shared.set("dbHandle", handle);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", dryRun);

    // Dry run (and run_local's stubbed DB): report on sample metrics so the graph
    // traces end to end without connecting to a real database.
    if (dryRun) {
      ctx.shared.set("generatedAt", "2099-01-01T00:00:00.000Z");
      ctx.logger.info("dry run — using sample metrics");
      return goto("detectAnomalies", { metrics: SAMPLE_METRICS });
    }

    const queries = resolveQueries(input.queries);
    const target = await resolveConnectionString(ctx, handle);
    if (!target) {
      ctx.logger.warn("no database connection; snapshotting nothing", {
        handle,
      });
      ctx.shared.set("generatedAt", "");
      ctx.shared.set(
        "note",
        `Could not open a connection to \`${handle}\`, so the report has no metrics in it.`,
      );
      return goto("detectAnomalies", { metrics: [] as Metric[] });
    }
    ctx.shared.set("external", target.external);
    ctx.shared.set("provisioned", target.provisioned);

    const sql = connect(target.connectionString);
    const metrics: Metric[] = [];
    try {
      // Only the managed demo database gets seeded — never the caller's own.
      let seeded = false;
      if (!target.external) {
        try {
          seeded = await ensureSeeded(ctx, sql);
        } catch (err) {
          ctx.logger.warn("could not seed the demo dataset", {
            err: String(err),
          });
        }
      }
      ctx.shared.set(
        "note",
        target.external
          ? undefined
          : [
              `Reported on the managed demo database \`${handle}\`, not your data.`,
              target.provisioned
                ? "This run provisioned it: a Sapiom Postgres caps at 7 days with no renew verb, so on a schedule an earlier run's data may have expired."
                : null,
              seeded ? "Demo rows were loaded before the snapshot." : null,
              `Set \`${DATABASE_URL_KEY}\` or point \`dbHandle\` at your own database to report on real data.`,
            ]
              .filter(Boolean)
              .join(" "),
      );

      // Capture the snapshot time server-side so it stays deterministic on retry.
      const nowRow = await sql<{ now: unknown }[]>`select now() as now`;
      ctx.shared.set(
        "generatedAt",
        nowRow[0]?.now instanceof Date
          ? (nowRow[0].now as Date).toISOString()
          : String(nowRow[0]?.now ?? ""),
      );

      for (const q of queries) {
        try {
          const rows = await sql.unsafe(q.sql);
          metrics.push(
            toMetric(q.name, rows as unknown as Record<string, unknown>[]),
          );
        } catch (err) {
          // A failing query (bad SQL, missing table) degrades per-item — the
          // report still goes out with the metrics that succeeded.
          ctx.logger.warn("query failed; skipping", {
            name: q.name,
            err: String(err),
          });
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }

    ctx.logger.info("snapshot complete", { metrics: metrics.length });
    return goto("detectAnomalies", { metrics });
  },
});

const detectAnomalies = defineStep({
  name: "detectAnomalies",
  next: ["narrate"],
  async run(input: { metrics: Metric[] }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const fallback = deterministicAnomaly(metrics);

    if (metrics.length === 0) {
      ctx.logger.info(
        "no metrics to inspect; using the deterministic fallback",
      );
      return goto("narrate", { metrics, anomaly: fallback });
    }

    // The live, x402-served model spots the outlier — same call the dry-run path
    // takes too (a model call is the world's RESPONSE to the numbers on hand,
    // sample or real; only the DB query and the send are gated behind `dryRun`).
    const res = await ctx.sapiom.models.run({
      system:
        "You are a data analyst spotting anomalies in a database snapshot. Given " +
        "METRICS (named series of label/value points, and scalar KPIs), find the " +
        "SINGLE most notable outlier or change — the number most worth a human's " +
        "attention — and cite the actual figures. Respond with ONLY a JSON object: " +
        '{"table": string|null, "metric": string, "description": string, ' +
        '"severity": "low"|"medium"|"high"}. Set `table` to the exact label from a ' +
        'series point when the anomaly names one (e.g. a table name from "Rows per ' +
        'table"), else null. No preamble, no code fences.',
      prompt: `METRICS:\n${renderMetrics(metrics)}`,
      maxTokens: 300,
    });
    const anomaly = coerceAnomaly(res.output ?? null, metrics, fallback);
    ctx.logger.info("anomaly detected", {
      table: anomaly.table,
      severity: anomaly.severity,
    });
    return goto("narrate", { metrics, anomaly });
  },
});

const narrate = defineStep({
  name: "narrate",
  next: ["followUp"],
  async run(input: { metrics: Metric[]; anomaly: Anomaly }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const anomaly = input?.anomaly ?? deterministicAnomaly(metrics);

    let narrative: string;
    if (metrics.length === 0) {
      narrative =
        "# Database insight report\n\n_No metrics were collected for this snapshot._";
    } else {
      // The live, x402-served model writes the narrative from the numbers,
      // leading with whatever `detectAnomalies` already flagged.
      const res = await ctx.sapiom.models.run({
        system:
          "You are a data analyst writing a short insight report from a database " +
          "snapshot. Given METRICS and a flagged ANOMALY (the one outlier already " +
          "identified upstream), write markdown with: a 2-3 sentence executive " +
          "summary that leads with the anomaly, then 3-5 bullet insights that each " +
          "cite the actual numbers, then a one-line 'What to watch'. Be concrete and " +
          "quantitative. Do not invent metrics that aren't given. Output ONLY the " +
          "markdown report — no preamble, no code fences.",
        prompt: `METRICS:\n${renderMetrics(metrics)}\n\nANOMALY: ${anomaly.description} (severity: ${anomaly.severity})`,
        maxTokens: 700,
      });
      narrative =
        (res.output ?? "").trim() ||
        "# Database insight report\n\n_The model returned no content._";
    }

    ctx.logger.info("narrated report", { chars: narrative.length });
    // Metrics + anomaly continue to `followUp`; the narrative rides in shared for
    // `deliver`.
    ctx.shared.set("narrative", narrative);
    return goto("followUp", { metrics, anomaly });
  },
});

const followUp = defineStep({
  name: "followUp",
  next: ["chart"],
  async run(input: { metrics: Metric[]; anomaly: Anomaly }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const anomaly = input?.anomaly ?? deterministicAnomaly(metrics);
    const dryRun = truthy(ctx.shared.get("dryRun"));
    const handle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;

    // The anomaly didn't name a table (a scalar-only snapshot, or a model
    // response with nothing usable) — nothing to drill into.
    if (!anomaly.table) {
      ctx.shared.set(
        "followUpNote",
        "The flagged anomaly didn't name a table, so no follow-up query ran.",
      );
      return goto("chart", { metrics, anomaly, followUp: null });
    }

    if (dryRun) {
      ctx.logger.info("dry run — using a sample follow-up read");
      ctx.shared.set(
        "followUpNote",
        `Dry run: skipped a real follow-up query and used a sample activity read for \`${anomaly.table}\`.`,
      );
      return goto("chart", {
        metrics,
        anomaly,
        followUp: sampleFollowUp(anomaly.table),
      });
    }

    const target = await resolveConnectionString(ctx, handle);
    if (!target) {
      ctx.shared.set(
        "followUpNote",
        `Recommends drilling into \`${anomaly.table}\`'s write activity, but the follow-up query couldn't open a connection.`,
      );
      return goto("chart", { metrics, anomaly, followUp: null });
    }

    const sql = connect(target.connectionString);
    let followUpMetric: SeriesMetric | null = null;
    try {
      followUpMetric = await runFollowUpQuery(sql, anomaly.table);
    } catch (err) {
      ctx.logger.warn("follow-up query failed", {
        table: anomaly.table,
        err: String(err),
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    ctx.shared.set(
      "followUpNote",
      followUpMetric
        ? `Recommends watching \`${anomaly.table}\` — its activity since the last snapshot: ${followUpMetric.points.map((p) => `${p.label} ${p.value}`).join(", ")}.`
        : `Recommends drilling into \`${anomaly.table}\`, but the follow-up query returned nothing.`,
    );
    return goto("chart", { metrics, anomaly, followUp: followUpMetric });
  },
});

/**
 * A tiny, dependency-free SVG bar-chart renderer, run inside the sandbox. Reads a
 * `{ charts: [{ title, points: [{ label, value }] }] }` JSON file and writes a
 * single SVG stacking one bar chart per series. Kept self-contained on purpose —
 * no npm install, so the render is fast and can't fail on a dependency.
 */
const CHART_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const [, , dataPath, outPath] = process.argv;
const { charts } = JSON.parse(readFileSync(dataPath, "utf8"));
const W = 760, pad = 32, barH = 22, gap = 10, titleH = 34, labelW = 190;
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const blocks = [];
let y = 0;
for (const chart of charts) {
  const pts = (chart.points || []).slice(0, 12);
  const max = Math.max(1, ...pts.map((p) => Number(p.value) || 0));
  const rows = pts
    .map((p, i) => {
      const bw = Math.round(((Number(p.value) || 0) / max) * (W - pad * 2 - labelW - 60));
      const by = titleH + i * (barH + gap);
      return (
        \`<text x="0" y="\${by + 15}" font-size="12" fill="#334155">\${esc(p.label).slice(0, 26)}</text>\` +
        \`<rect x="\${labelW}" y="\${by}" width="\${bw}" height="\${barH}" rx="3" fill="#4f46e5"/>\` +
        \`<text x="\${labelW + bw + 8}" y="\${by + 15}" font-size="12" fill="#334155">\${esc(p.value)}</text>\`
      );
    })
    .join("");
  const h = titleH + pts.length * (barH + gap) + gap;
  blocks.push(
    \`<g transform="translate(\${pad},\${y + pad})"><text x="0" y="18" font-size="16" font-weight="600" fill="#0f172a">\${esc(chart.title)}</text>\${rows}</g>\`,
  );
  y += h + pad;
}
const height = Math.max(y + pad, 80);
const svg =
  \`<svg xmlns="http://www.w3.org/2000/svg" width="\${W}" height="\${height}" viewBox="0 0 \${W} \${height}" font-family="system-ui,-apple-system,sans-serif">\` +
  \`<rect width="100%" height="100%" fill="#ffffff"/>\${blocks.join("")}</svg>\`;
writeFileSync(outPath, svg);
process.stdout.write(String(svg.length));
`;

/** base64-encode UTF-8 text so it survives a shell command line intact. */
function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const chart = defineStep({
  name: "chart",
  next: ["deliver"],
  async run(
    input: {
      metrics: Metric[];
      anomaly: Anomaly;
      followUp: SeriesMetric | null;
    },
    ctx: Ctx,
  ) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const anomaly = input?.anomaly ?? deterministicAnomaly(metrics);
    const followUpMetric = input?.followUp ?? null;
    // The follow-up read charts alongside the snapshot's own series metrics —
    // it's the same shape, just one more bar chart in the sandbox render.
    const chartable = followUpMetric ? [...metrics, followUpMetric] : metrics;
    const charts = chartable
      .filter(
        (m): m is Extract<Metric, { kind: "series" }> =>
          m.kind === "series" && m.points.length > 0,
      )
      .map((m) => ({ title: m.name, points: m.points }));

    // Nothing chartable — hand the report on without a chart.
    if (charts.length === 0) {
      ctx.logger.info("no series metrics; skipping chart render");
      return goto("deliver", {
        chartUrl: null,
        metrics,
        anomaly,
        followUp: followUpMetric,
      });
    }

    const sandboxName = `db-insight-${ctx.executionId}`;
    let chartUrl: string | null = null;
    let box: Awaited<ReturnType<typeof ctx.sapiom.sandboxes.create>> | null =
      null;
    try {
      box = await ctx.sapiom.sandboxes.create({
        name: sandboxName,
        ttl: "15m",
      });
      // Materialize the renderer + data and run it in ONE exec. `writeFile` and
      // `exec` root paths differently in the sandbox runtime (SAP-2209: the
      // filesystem API and the SDK both prepend the workspace root, so a
      // `writeFile`d file double-nests to `/blaxel/blaxel/...` while `exec` runs
      // at `/blaxel`) — a written file is never where `node` reads it. Decoding
      // from base64 inside the same command keeps one shell and one cwd, so the
      // renderer sees the files we just wrote; base64 also keeps the chart data
      // off the raw command line safely.
      const res = await box.exec(
        [
          `printf %s '${toBase64(CHART_SCRIPT)}' | base64 -d > render.mjs`,
          `printf %s '${toBase64(JSON.stringify({ charts }))}' | base64 -d > data.json`,
          "node render.mjs data.json chart.svg",
        ].join(" && "),
      );
      if (res.exitCode !== 0) {
        throw new Error(`renderer exited ${res.exitCode}: ${res.stderr}`);
      }

      // Read the SVG back over the exec channel too — `readFile` would double-nest
      // exactly like the writes did. base64 keeps bytes intact across the text-only
      // channel (`-w0` disables wrapping where supported, plain `base64` fallback).
      const read = await box.exec("(base64 -w0 chart.svg || base64 chart.svg)");
      const svg =
        read.exitCode === 0
          ? Buffer.from(read.stdout.replace(/\s+/g, ""), "base64").toString(
              "utf8",
            )
          : "";
      // An empty read is the stubbed (`run_local`) path — no bytes to host.
      if (svg.trim().length > 0) {
        const bytes = new TextEncoder().encode(svg);
        const up = await ctx.sapiom.fileStorage.upload({
          contentType: "image/svg+xml",
          fileName: `${sandboxName}.svg`,
          fileSize: bytes.byteLength,
          visibility: "public",
        });
        await fetch(up.uploadUrl, {
          method: "PUT",
          headers: up.requiredHeaders,
          body: bytes,
        });
        // Durable permalink, not a presigned URL — the chart is embedded in the
        // emailed report below, which can sit in an inbox well past a ~15min TTL.
        chartUrl = fileStorage.getPublicUrl(up.fileId);
        ctx.logger.info("chart rendered + hosted", {
          fileId: up.fileId,
          bytes: bytes.byteLength,
        });
      }
    } catch (err) {
      // A render/upload failure degrades to a chart-less report rather than
      // aborting the run — the narrative and metrics table still go out.
      ctx.logger.warn("chart render failed; continuing without a chart", {
        err: String(err),
      });
    } finally {
      if (box) await box.destroy().catch(() => {});
    }

    return goto("deliver", {
      chartUrl,
      metrics,
      anomaly,
      followUp: followUpMetric,
    });
  },
});

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(
    input: {
      chartUrl: string | null;
      metrics: Metric[];
      anomaly: Anomaly;
      followUp: SeriesMetric | null;
    },
    ctx: Ctx,
  ) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const chartUrl = input?.chartUrl ?? null;
    const anomaly = input?.anomaly ?? deterministicAnomaly(metrics);
    const followUpMetric = input?.followUp ?? null;
    const narrative = ctx.shared.get("narrative") || "";
    const generatedAt = ctx.shared.get("generatedAt") || "";
    const schedule = ctx.shared.get("schedule") || DEFAULT_SCHEDULE;
    const dryRun = ctx.shared.get("dryRun") ?? true;

    const report = renderReport(
      narrative,
      metrics,
      anomaly,
      followUpMetric,
      chartUrl,
      generatedAt,
    );
    const subject = "Database insight report";

    // A recipient is ordinary configuration, so it arrives as run input (declared
    // as a `deliverTo` setting in template.json) rather than from a write-only
    // secret store nothing in the product can populate.
    const deliverTo = ctx.shared.get("deliverTo");

    // Safe path: a dry run, or a live run with no recipient, returns the report
    // without sending anything.
    if (dryRun || !deliverTo) {
      ctx.logger.info("skipping delivery", {
        dryRun,
        hasRecipient: Boolean(deliverTo),
      });
      return terminate({
        delivered: false,
        dryRun,
        reason: dryRun ? "dry-run" : "no-recipient",
        to: deliverTo ?? null,
        subject,
        schedule,
        generatedAt,
        chartUrl,
        metricCount: metrics.length,
        anomaly,
        followUp: followUpMetric,
        report,
        ...(dryRun ? {} : { unmet: ["deliverTo"] }),
        note: [
          dryRun
            ? "`dryRun` was set, so no database was read and nothing was emailed."
            : "Nothing was emailed: no `deliverTo` address is set, so the report is returned inline below.",
          ctx.shared.get("note"),
          ctx.shared.get("followUpNote"),
        ]
          .filter(Boolean)
          .join(" "),
      });
    }

    const inboxId = await resolveSenderInbox(ctx);
    const sent = await ctx.sapiom.email.messages.send(inboxId, {
      to: deliverTo,
      subject,
      text: report,
    });
    ctx.logger.info("report delivered", {
      to: deliverTo,
      messageId: sent.messageId,
    });
    return terminate({
      delivered: true,
      dryRun: false,
      to: deliverTo,
      subject,
      schedule,
      generatedAt,
      chartUrl,
      metricCount: metrics.length,
      anomaly,
      followUp: followUpMetric,
      messageId: sent.messageId,
      ...(ctx.shared.get("note") || ctx.shared.get("followUpNote")
        ? {
            note: [ctx.shared.get("note"), ctx.shared.get("followUpNote")]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    });
  },
});

// ─────────────────────────────────────────────────────────────── render ──
/** Assemble the emailed report: narrative, anomaly, follow-up, chart, appendix. */
function renderReport(
  narrative: string,
  metrics: Metric[],
  anomaly: Anomaly,
  followUp: SeriesMetric | null,
  chartUrl: string | null,
  generatedAt: string,
): string {
  const parts = [narrative.trim()];
  if (generatedAt) parts.push(`\n_Snapshot taken ${generatedAt}._`);
  parts.push(
    `\n## Anomaly flagged\n\n${anomaly.description} (**${anomaly.severity}**)`,
  );
  if (followUp) {
    parts.push(
      `\n## Follow-up: ${followUp.name}\n\n${followUp.points
        .map((p) => `- ${p.label}: ${p.value}`)
        .join("\n")}`,
    );
  }
  if (chartUrl) parts.push(`\n## Chart\n\n[View chart](${chartUrl})`);

  if (metrics.length > 0) {
    const lines = ["\n## Metrics"];
    for (const m of metrics) {
      if (m.kind === "scalar") {
        lines.push(`- **${m.name}:** ${m.value}`);
      } else if (m.points.length > 0) {
        lines.push(`- **${m.name}:**`);
        for (const p of m.points) lines.push(`  - ${p.label}: ${p.value}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n");
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "scheduled-db-insight-report",
  entry: "snapshot",
  steps: { snapshot, detectAnomalies, narrate, followUp, chart, deliver },
});
