import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import postgres from "postgres";

/**
 * Scheduled DB Snapshot to Insight Report — on a cron cadence, take a snapshot of
 * a database, have an LLM write the narrative, render the numbers into charts in a
 * sandbox, and email the finished report.
 *
 * In one legible graph:
 *   snapshot (database) ──▶ narrate (models.run) ──▶ chart (sandbox + fileStorage) ──▶ deliver (email)
 *
 *   - **snapshot** runs a set of read-only SQL queries against a Postgres database
 *     and normalizes each result into a metric — a labeled series (for a bar chart)
 *     or a single scalar (a KPI). The default queries introspect the database's own
 *     catalog (rows per table, table count, database size), so it produces a real
 *     snapshot on any database with zero configuration; pass your own `queries` to
 *     report on your actual data.
 *   - **narrate** hands those metrics to an LLM (`ctx.sapiom.models.run` — the live
 *     x402-served model, not a hardcoded formatter) to write a short markdown
 *     insight report: an executive summary, a few bullet insights that cite the
 *     numbers, and a line on what to watch.
 *   - **chart** spins up a sandbox, writes a tiny dependency-free Node renderer plus
 *     the metrics as JSON, runs it to produce an SVG bar chart, then uploads that
 *     SVG to file storage and takes a shareable download URL. The sandbox is torn
 *     down when the step ends. The rendered SVG is the only large payload here — it
 *     dies at the chart boundary; only the URL crosses into the report.
 *   - **deliver** assembles the report (narrative + chart link + a compact metrics
 *     table) and emails it. A `dryRun` (or a run with no recipient) returns the
 *     report as a preview without sending, so `run_local` traces the whole graph
 *     for free (capabilities stubbed, the real DB query and the send skipped).
 *
 * Side-effect discipline (copied from `error-triage-digest` / `scheduled-research-brief`):
 *   - The real SQL is gated behind `dryRun`: a dry run reports on sample metrics so
 *     the graph traces offline without connecting to a database.
 *   - The recipient — and an optional external database URL — are read from the
 *     Sapiom vault at runtime and never persisted in execution state.
 *   - Non-deterministic values (the snapshot timestamp) are captured once at the DB
 *     boundary via Postgres `now()`, not recomputed per step.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Postgres handle the report reads from — created on first run, reused after. */
const DEFAULT_DB_HANDLE = "scheduled-db-insight-report";
/** Vault ref holding delivery + connection config. Read at runtime. */
const VAULT_REF = "scheduled-db-insight-report";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "db-insight-report";
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
  /** Recipient email; falls back to the vault-configured default when omitted. */
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

interface Shared extends Record<string, unknown> {
  dbHandle: string;
  schedule: string;
  deliverTo: string | null;
  dryRun: boolean;
  generatedAt: string;
  narrative: string;
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

/**
 * Resolve the connection string at runtime. An external `DATABASE_URL` in the
 * vault wins (report on your own database, secret never persisted); otherwise a
 * Sapiom-managed Postgres is looked up by handle, provisioned on first run.
 */
async function resolveConnectionString(
  ctx: Ctx,
  handle: string,
): Promise<string | null> {
  try {
    const external = await ctx.sapiom.vault.get(VAULT_REF, "DATABASE_URL");
    if (external) return external;
  } catch (err) {
    ctx.logger.warn("vault: no DATABASE_URL configured", { err: String(err) });
  }
  let db;
  try {
    db = await ctx.sapiom.database.get(handle);
  } catch {
    db = await ctx.sapiom.database.create({
      handle,
      duration: "7d",
      name: "DB Insight Report",
      description: "Database the scheduled insight report snapshots",
    });
  }
  return db.connection?.connectionString ?? null;
}

/**
 * Resolve the recipient from the vault at runtime. A missing ref/key is an
 * expected outcome (returns null), not an error — the caller then falls back to a
 * preview. Never persisted in execution state.
 */
async function recipientFromVault(ctx: Ctx): Promise<string | null> {
  try {
    return await ctx.sapiom.vault.get(VAULT_REF, "RECIPIENT");
  } catch (err) {
    ctx.logger.warn("vault: no recipient configured", { err: String(err) });
    return null;
  }
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "DB Insight Report",
  });
  return inbox.inboxId;
}

// ─────────────────────────────────────────────────────────────── steps ──
const snapshot = defineStep({
  name: "snapshot",
  next: ["narrate"],
  async run(input: EntryInput, ctx: Ctx) {
    const dryRun = truthy(input.dryRun);
    const handle = input.dbHandle?.trim() || DEFAULT_DB_HANDLE;
    ctx.shared.set("dbHandle", handle);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", dryRun);

    // Dry run (and run_local's stubbed DB): report on sample metrics so the graph
    // traces end to end without connecting to a real database.
    if (dryRun) {
      ctx.shared.set("generatedAt", "2099-01-01T00:00:00.000Z");
      ctx.logger.info("dry run — using sample metrics");
      return goto("narrate", { metrics: SAMPLE_METRICS });
    }

    const queries = resolveQueries(input.queries);
    const conn = await resolveConnectionString(ctx, handle);
    if (!conn) {
      ctx.logger.warn("no database connection; snapshotting nothing", {
        handle,
      });
      ctx.shared.set("generatedAt", "");
      return goto("narrate", { metrics: [] as Metric[] });
    }

    const sql = postgres(conn, {
      ssl: "require",
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      // Bound every query on this connection so one slow statement can't stall
      // the run.
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    });
    const metrics: Metric[] = [];
    try {
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
    return goto("narrate", { metrics });
  },
});

const narrate = defineStep({
  name: "narrate",
  next: ["chart"],
  async run(input: { metrics: Metric[] }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];

    let narrative: string;
    if (metrics.length === 0) {
      narrative =
        "# Database insight report\n\n_No metrics were collected for this snapshot._";
    } else {
      const rendered = metrics
        .map((m) =>
          m.kind === "scalar"
            ? `${m.name}: ${m.value}`
            : `${m.name}:\n${m.points
                .map((p) => `  - ${p.label}: ${p.value}`)
                .join("\n")}`,
        )
        .join("\n");
      // The live, x402-served model writes the narrative from the numbers.
      const res = await ctx.sapiom.models.run({
        system:
          "You are a data analyst writing a short insight report from a database " +
          "snapshot. Given a set of METRICS (named series of label/value pairs, and " +
          "scalar KPIs), write markdown with: a 2-3 sentence executive summary, then " +
          "3-5 bullet insights that each cite the actual numbers, then a one-line " +
          "'What to watch'. Be concrete and quantitative. Do not invent metrics that " +
          "aren't given. Output ONLY the markdown report — no preamble, no code fences.",
        prompt: `METRICS:\n${rendered}`,
        maxTokens: 700,
      });
      narrative =
        (res.output ?? "").trim() ||
        "# Database insight report\n\n_The model returned no content._";
    }

    ctx.logger.info("narrated report", { chars: narrative.length });
    // Metrics continue to `chart`; the narrative rides in shared for `deliver`.
    ctx.shared.set("narrative", narrative);
    return goto("chart", { metrics });
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

const chart = defineStep({
  name: "chart",
  next: ["deliver"],
  async run(input: { metrics: Metric[] }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const charts = metrics
      .filter(
        (m): m is Extract<Metric, { kind: "series" }> =>
          m.kind === "series" && m.points.length > 0,
      )
      .map((m) => ({ title: m.name, points: m.points }));

    // Nothing chartable — hand the report on without a chart.
    if (charts.length === 0) {
      ctx.logger.info("no series metrics; skipping chart render");
      return goto("deliver", { chartUrl: null, metrics });
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
      await box.writeFile("render.mjs", CHART_SCRIPT);
      await box.writeFile("data.json", JSON.stringify({ charts }));

      const res = await box.exec("node render.mjs data.json chart.svg");
      if (res.exitCode !== 0) {
        throw new Error(`renderer exited ${res.exitCode}: ${res.stderr}`);
      }

      const svg = await box.readFile("chart.svg");
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
        const dl = await ctx.sapiom.fileStorage.getDownloadUrl(up.fileId);
        chartUrl = dl.downloadUrl;
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

    return goto("deliver", { chartUrl, metrics });
  },
});

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(input: { chartUrl: string | null; metrics: Metric[] }, ctx: Ctx) {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const chartUrl = input?.chartUrl ?? null;
    const narrative = ctx.shared.get("narrative") || "";
    const generatedAt = ctx.shared.get("generatedAt") || "";
    const schedule = ctx.shared.get("schedule") || DEFAULT_SCHEDULE;
    const dryRun = ctx.shared.get("dryRun") ?? true;

    const report = renderReport(narrative, metrics, chartUrl, generatedAt);
    const subject = "Database insight report";

    // Explicit input wins; otherwise resolve the default from the vault at
    // runtime (never carried through state).
    const deliverTo =
      ctx.shared.get("deliverTo") || (await recipientFromVault(ctx));

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
        report,
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
      messageId: sent.messageId,
    });
  },
});

// ─────────────────────────────────────────────────────────────── render ──
/** Assemble the emailed report: narrative, chart link, and a metrics appendix. */
function renderReport(
  narrative: string,
  metrics: Metric[],
  chartUrl: string | null,
  generatedAt: string,
): string {
  const parts = [narrative.trim()];
  if (generatedAt) parts.push(`\n_Snapshot taken ${generatedAt}._`);
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
  steps: { snapshot, narrate, chart, deliver },
});
