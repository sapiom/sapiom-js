import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import postgres from "postgres";

/**
 * Error / Log Triage Digest — turn a noisy stream of errors into one daily
 * digest that separates what's new from what you already know about.
 *
 * It ingests a batch of errors two ways, from the same entry step:
 *   - **Scheduled pull** — a cron-triggered run passes the batch in as `errors`,
 *     or hands it a `pullUrl` to GET the batch from your log store.
 *   - **Webhook push** — with `webhook: true` and no batch yet, the run
 *     **suspends at $0** via `pauseUntilSignal` until your error pipeline pushes
 *     a batch as the `errors.pushed` signal. No polling loop, no billed idle.
 *
 * Then, in one legible graph:
 *   collect ──▶ triage (models.run) ──▶ dedupe (database) ──▶ digest (email)
 *
 *   - **triage** hands the raw errors to an LLM (`ctx.sapiom.models.run` — the
 *     live x402-served model) to cluster them into a handful of issues, each
 *     with a stable `fingerprint`, a title, a severity, and an occurrence count.
 *   - **dedupe** looks each fingerprint up in a Postgres table the digest owns.
 *     Clusters it has never seen are **new**; the rest are **recurring**, and it
 *     updates their running totals and last-seen time. This is what stops the
 *     digest from re-alerting on the same known error every single day.
 *   - **digest** writes a markdown digest — new issues first, recurring below —
 *     and emails it. A `dryRun` (or a run with no recipient) returns the digest
 *     as a preview without sending, so `run_local` traces the whole graph for
 *     free (capabilities stubbed, DB and delivery skipped).
 *
 * Determinism: each step body runs once on the happy path (again only on retry).
 * Non-deterministic values — the dedup timestamp — are captured once at the DB
 * boundary via Postgres `now()`, not recomputed per row.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Postgres handle the digest owns — created on first run, reused after. */
const DEFAULT_DB_HANDLE = "error-triage-digest";
/** Vault ref holding delivery config (e.g. a default RECIPIENT). Read at runtime. */
const DELIVERY_VAULT_REF = "error-triage-digest";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "error-triage";
/** The named signal an external error pipeline fires to push a batch in. */
const SIGNAL = "errors.pushed";
/** Cap the batch handed to the model so cost + latency stay bounded. */
const MAX_ERRORS = 200;
/** Cap each error message the model sees — stacks can be enormous. */
const MAX_MESSAGE_CHARS = 800;
/** Default cadence documented for the cron trigger: 08:00 every day. */
const DEFAULT_SCHEDULE = "0 8 * * *";

// ─────────────────────────────────────────────────────────────── shapes ──
/** A raw error/log entry. Open-ended — a real source returns what it returns. */
interface RawError {
  /** The error message or log line. The only field we require. */
  message: string;
  /** Severity as the source labels it, e.g. "error" / "warning". */
  level?: string;
  /** Which service/component emitted it. */
  service?: string;
  /** Stack trace, if any. Truncated before the model sees it. */
  stack?: string;
  /** When it happened (ISO). */
  timestamp?: string;
  [key: string]: unknown;
}

interface EntryInput {
  /** The error batch to triage (the "scheduled pull" / direct path). */
  errors?: RawError[];
  /** Optional URL to GET the batch from (JSON array, or `{ errors: [] }`). */
  pullUrl?: string;
  /** Wait for a webhook to push the batch instead of pulling one. */
  webhook?: boolean;
  /** Cron cadence this digest is meant to run on (documentation only). */
  schedule?: string;
  /** Postgres handle for the dedup store; defaults to the template handle. */
  dbHandle?: string;
  /** Recipient email; falls back to the vault-configured default when omitted. */
  deliverTo?: string;
  /** Compute the digest but skip the DB writes and the real send. */
  dryRun?: boolean;
}

/** A batch of errors — the shape that crosses collect → triage, either path. */
interface Batch {
  errors: RawError[];
}

/** One clustered issue as the model returns it. */
interface Cluster {
  /** Stable key for dedup — same recurring issue must yield the same value. */
  fingerprint: string;
  title: string;
  summary: string;
  severity: "critical" | "high" | "medium" | "low";
  /** A representative raw message for the issue. */
  sampleMessage: string;
  /** Occurrences of this issue in THIS batch. */
  count: number;
}

/** A recurring cluster enriched with what the DB already knew about it. */
interface RecurringCluster extends Cluster {
  /** When this fingerprint was first seen, across all prior runs (ISO). */
  firstSeen: string;
  /** Total occurrences recorded before this batch. */
  priorTotal: number;
}

interface Shared extends Record<string, unknown> {
  dbHandle: string;
  deliverTo: string | null;
  dryRun: boolean;
  schedule: string;
  batchSize: number;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

// ─────────────────────────────────────────────────────────────── helpers ──
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Normalize + bound a raw batch so downstream cost stays predictable. */
function normalizeErrors(raw: unknown): RawError[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is RawError => Boolean(e) && typeof e === "object")
    .map((e) => {
      const message = String(
        (e as RawError).message ?? (e as { msg?: unknown }).msg ?? "",
      ).trim();
      return { ...(e as RawError), message } as RawError;
    })
    .filter((e) => e.message.length > 0)
    .slice(0, MAX_ERRORS);
}

/** GET a batch from a log store. Accepts a bare array or `{ errors: [] }`. */
async function pullErrors(url: string): Promise<RawError[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`pull failed: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const arr = Array.isArray(body)
    ? body
    : ((body as { errors?: unknown }).errors ?? []);
  return normalizeErrors(arr);
}

/**
 * Resolve the recipient from the vault at runtime. A missing ref/key is an
 * expected outcome (returns null), not an error — the caller then falls back to
 * a preview. Never persisted in execution state.
 */
async function recipientFromVault(ctx: Ctx): Promise<string | null> {
  try {
    return await ctx.sapiom.vault.get(DELIVERY_VAULT_REF, "RECIPIENT");
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
    displayName: "Error Triage Digest",
  });
  return inbox.inboxId;
}

/** Open a Postgres client for a live run, or null in dryRun / when unavailable. */
async function openSql(ctx: Ctx, handle: string): Promise<Sql | null> {
  let db;
  try {
    db = await ctx.sapiom.database.get(handle);
  } catch {
    db = await ctx.sapiom.database.create({
      handle,
      duration: "7d",
      name: "Error Triage Digest",
      description: "Seen-error fingerprints + running counts for the digest",
    });
  }
  // `db` may be a stub (undefined) under run_local — stay null-safe and degrade.
  const conn = db?.connection?.connectionString ?? null;
  if (!conn) {
    ctx.logger.warn("database: no connection string", { handle });
    return null;
  }
  return postgres(conn, { ssl: "require" });
}

async function initSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists error_clusters (
      fingerprint     text primary key,
      title           text,
      severity        text,
      first_seen      timestamptz not null default now(),
      last_seen       timestamptz not null default now(),
      total_count     bigint not null default 0,
      times_reported  bigint not null default 0
    )`;
}

/** ISO-string a value the pg driver may hand back as a Date or a string. */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}

// ─────────────────────────────────────────────────────────────── steps ──
const collect = defineStep({
  name: "collect",
  next: ["triage"],
  // Static graph edge: on SIGNAL, resume at `triage`. Must match the directive.
  pause: { signal: SIGNAL, resumeStep: "triage" },
  async run(input: EntryInput, ctx: Ctx) {
    ctx.shared.set("dbHandle", input.dbHandle?.trim() || DEFAULT_DB_HANDLE);
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", truthy(input.dryRun));
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);

    let errors = normalizeErrors(input.errors);

    // Nothing passed in, but a pull URL is configured: fetch the batch now
    // (the "scheduled pull" path a cron trigger would take).
    if (errors.length === 0 && input.pullUrl && !truthy(input.dryRun)) {
      try {
        errors = await pullErrors(input.pullUrl.trim());
        ctx.logger.info("pulled error batch", { count: errors.length });
      } catch (err) {
        ctx.logger.warn("pull failed; continuing with empty batch", {
          err: String(err),
        });
      }
    }

    // Still nothing and asked to wait: suspend at $0 until the pipeline pushes a
    // batch. The resumed `triage` step's input IS the signal payload.
    if (errors.length === 0 && truthy(input.webhook)) {
      ctx.shared.set("batchSize", 0);
      ctx.logger.info("no batch yet; pausing for the errors.pushed signal", {
        correlationId: ctx.executionId,
      });
      return pauseUntilSignal({
        signal: SIGNAL,
        resumeStep: "triage",
        correlationId: ctx.executionId,
      });
    }

    ctx.shared.set("batchSize", errors.length);
    return goto("triage", { errors });
  },
});

const triage = defineStep({
  name: "triage",
  next: ["dedupe"],
  // `input` is either collect's goto payload or the resumed signal payload.
  async run(input: Batch, ctx: Ctx) {
    const errors = normalizeErrors(input?.errors);
    ctx.shared.set("batchSize", errors.length);

    if (errors.length === 0) {
      ctx.logger.info("empty batch; nothing to cluster");
      return goto("dedupe", { clusters: [] as Cluster[] });
    }

    const rendered = errors
      .map((e, i) => {
        const head = [e.level, e.service].filter(Boolean).join("/");
        const body = `${e.message}${e.stack ? `\n${e.stack}` : ""}`.slice(
          0,
          MAX_MESSAGE_CHARS,
        );
        return `[${i + 1}]${head ? ` (${head})` : ""} ${body}`;
      })
      .join("\n\n");

    const system =
      "You are an on-call engineer triaging a batch of error/log entries. " +
      "Group them into a small set of distinct issues (usually 1-8). For each " +
      "issue produce a STABLE fingerprint: a short lowercase slug derived from " +
      "the error's invariant parts (error type, module, message template) with " +
      "volatile bits — ids, timestamps, hostnames, line numbers — stripped, so " +
      "the same recurring issue always yields the same fingerprint. Rank by " +
      'severity. Reply with ONLY minified JSON: {"clusters":[{"fingerprint":' +
      'string,"title":string,"summary":string,"severity":"critical|high|medium|' +
      'low","sampleMessage":string,"count":number}]}.';
    const prompt = `ERROR BATCH (${errors.length} entries):\n${rendered}`;

    const res = await ctx.sapiom.models.run({ system, prompt, maxTokens: 900 });
    const clusters = parseClusters(res.output, errors);
    ctx.logger.info("triaged batch into clusters", {
      errors: errors.length,
      clusters: clusters.length,
    });
    return goto("dedupe", { clusters });
  },
});

const dedupe = defineStep({
  name: "dedupe",
  next: ["digest"],
  async run(input: { clusters: Cluster[] }, ctx: Ctx) {
    const clusters = Array.isArray(input?.clusters) ? input.clusters : [];
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const handle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;

    // Dry run (or run_local's stubbed DB): treat everything as new so the graph
    // traces end to end without touching a real database.
    if (dryRun || clusters.length === 0) {
      ctx.logger.info("skipping dedup store", {
        dryRun,
        clusters: clusters.length,
      });
      return goto("digest", {
        newClusters: clusters,
        recurringClusters: [] as RecurringCluster[],
      });
    }

    const sql = await openSql(ctx, handle);
    if (!sql) {
      // No DB available — degrade to "everything new" rather than abort.
      return goto("digest", {
        newClusters: clusters,
        recurringClusters: [] as RecurringCluster[],
      });
    }

    try {
      await initSchema(sql);
      const newClusters: Cluster[] = [];
      const recurringClusters: RecurringCluster[] = [];

      for (const c of clusters) {
        const prior = await sql<
          { first_seen: unknown; total_count: string }[]
        >`select first_seen, total_count from error_clusters
            where fingerprint = ${c.fingerprint}`;
        if (prior.length === 0) {
          newClusters.push(c);
        } else {
          recurringClusters.push({
            ...c,
            firstSeen: toIso(prior[0].first_seen),
            priorTotal: Number(prior[0].total_count),
          });
        }
        // Upsert running state — server-side now() keeps last_seen deterministic
        // regardless of retries.
        await sql`
          insert into error_clusters
            (fingerprint, title, severity, total_count, times_reported)
          values
            (${c.fingerprint}, ${c.title}, ${c.severity}, ${c.count}, 1)
          on conflict (fingerprint) do update set
            title          = excluded.title,
            severity       = excluded.severity,
            last_seen      = now(),
            total_count    = error_clusters.total_count + ${c.count},
            times_reported = error_clusters.times_reported + 1`;
      }

      ctx.logger.info("deduped clusters", {
        new: newClusters.length,
        recurring: recurringClusters.length,
      });
      return goto("digest", { newClusters, recurringClusters });
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

const digest = defineStep({
  name: "digest",
  next: [],
  terminal: true,
  async run(
    input: { newClusters: Cluster[]; recurringClusters: RecurringCluster[] },
    ctx: Ctx,
  ) {
    const newClusters = Array.isArray(input?.newClusters)
      ? input.newClusters
      : [];
    const recurringClusters = Array.isArray(input?.recurringClusters)
      ? input.recurringClusters
      : [];
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const batchSize = ctx.shared.get("batchSize") ?? 0;
    const total = newClusters.length + recurringClusters.length;

    const body = renderDigest(newClusters, recurringClusters, batchSize);
    const subject =
      total === 0
        ? "Error triage digest: all clear"
        : `Error triage digest: ${newClusters.length} new, ${recurringClusters.length} recurring`;

    // Explicit input wins; otherwise resolve the default from the vault at
    // runtime (never carried through state).
    const deliverTo =
      ctx.shared.get("deliverTo") || (await recipientFromVault(ctx));

    // Safe path: a dry run, or a live run with no recipient, returns the digest
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
        digest: body,
        newCount: newClusters.length,
        recurringCount: recurringClusters.length,
      });
    }

    const inboxId = await resolveSenderInbox(ctx);
    const sent = await ctx.sapiom.email.messages.send(inboxId, {
      to: deliverTo,
      subject,
      text: body,
    });
    ctx.logger.info("digest delivered", {
      to: deliverTo,
      messageId: sent.messageId,
    });
    return terminate({
      delivered: true,
      dryRun: false,
      to: deliverTo,
      subject,
      messageId: sent.messageId,
      newCount: newClusters.length,
      recurringCount: recurringClusters.length,
    });
  },
});

// ─────────────────────────────────────────────────────────────── render ──
const SEVERITY_ORDER: Record<Cluster["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function bySeverity(a: Cluster, b: Cluster): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

function renderCluster(c: Cluster, extra = ""): string {
  return (
    `- **[${c.severity}] ${c.title}** — ${c.summary} ` +
    `(${c.count} this batch${extra})\n  \`${c.sampleMessage.slice(0, 200)}\``
  );
}

function renderDigest(
  newClusters: Cluster[],
  recurringClusters: RecurringCluster[],
  batchSize: number,
): string {
  if (newClusters.length === 0 && recurringClusters.length === 0) {
    return `# Error triage digest\n\nNo errors in this batch — all clear.`;
  }
  const lines = [
    `# Error triage digest`,
    ``,
    `Triaged **${batchSize}** entries into ` +
      `**${newClusters.length}** new and **${recurringClusters.length}** recurring issue(s).`,
    ``,
  ];
  lines.push(`## 🔴 New issues (${newClusters.length})`);
  lines.push(
    newClusters.length === 0
      ? `_None — nothing here we haven't already seen._`
      : [...newClusters]
          .sort(bySeverity)
          .map((c) => renderCluster(c))
          .join("\n"),
  );
  lines.push(``);
  lines.push(`## 🔁 Recurring issues (${recurringClusters.length})`);
  lines.push(
    recurringClusters.length === 0
      ? `_None._`
      : [...recurringClusters]
          .sort(bySeverity)
          .map((c) =>
            renderCluster(
              c,
              `, ${c.priorTotal + c.count} total, first seen ${c.firstSeen.slice(0, 10)}`,
            ),
          )
          .join("\n"),
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────── parsing ──
/** Extract clusters from the model output; fall back to one catch-all cluster. */
function parseClusters(output: string | null, errors: RawError[]): Cluster[] {
  const fallback = (): Cluster[] => [
    {
      fingerprint: "untriaged-batch",
      title: "Untriaged errors",
      summary: "The model returned no usable clustering for this batch.",
      severity: "medium",
      sampleMessage: errors[0]?.message ?? "",
      count: errors.length,
    },
  ];
  if (!output) return fallback();
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return fallback();
    const parsed = JSON.parse(output.slice(start, end + 1)) as {
      clusters?: unknown;
    };
    if (!Array.isArray(parsed.clusters)) return fallback();
    const clusters = parsed.clusters
      .map(coerceCluster)
      .filter((c): c is Cluster => c !== null);
    return clusters.length > 0 ? clusters : fallback();
  } catch {
    return fallback();
  }
}

function coerceCluster(raw: unknown): Cluster | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fingerprint = String(r.fingerprint ?? "").trim();
  const title = String(r.title ?? "").trim();
  if (!fingerprint || !title) return null;
  const severity = (["critical", "high", "medium", "low"] as const).includes(
    r.severity as Cluster["severity"],
  )
    ? (r.severity as Cluster["severity"])
    : "medium";
  const count = Number(r.count);
  return {
    fingerprint,
    title,
    summary: String(r.summary ?? "").trim(),
    severity,
    sampleMessage: String(r.sampleMessage ?? "").trim(),
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1,
  };
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "error-triage-digest",
  entry: "collect",
  steps: { collect, triage, dedupe, digest },
});
