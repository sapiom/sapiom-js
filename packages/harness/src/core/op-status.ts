/**
 * op-status — fetches and stitches an agent's four EXISTING operational signals
 * (runs+failing, scheduled, deployment, open alerts) into one per-agent
 * {@link OperationalStatus} the Studio rail + focused health strip render.
 *
 * WHY this exists: there is no single per-agent operational-summary endpoint
 * upstream (plans/sapiom-studio §9). The Studio knows only *build* state; it has
 * no idea what an agent is doing in production. This layer fans out to the four
 * signals and stitches them so the Studio can answer "is it alive / failing /
 * scheduled / deployed / alerting" and act as the triage entry point.
 *
 * WHY the CORE surface: all four live under the tenant-scoped API on the core
 * host (`api.<env>`) — `/v1/workflows/*` (metrics, definition detail, triggers)
 * and `/v1/alerts` — the same host run-spend.ts / run-transactions.ts read, with
 * the same `x-api-key` header. So we reuse {@link resolveCoreBaseUrl}.
 *
 * WHY the key stays server-side: identical rationale to run-state / run-spend /
 * run-transactions — the Sapiom API key is a harness credential that must never
 * reach the browser. The harness server fetches on behalf of the SPA, which
 * polls a local `/api/agents/:definitionId/op-status` endpoint (no key in the
 * request) rather than calling the upstream surface directly.
 *
 * WHY honest absence: each signal is fetched independently and folds to ABSENT
 * (not a faked zero / `unknown`) when its upstream call fails, so a single dead
 * signal never blanks the whole strip and a present-but-empty signal
 * (`runCount: 0`) is distinguishable from a missing one. See
 * {@link stitchOperationalStatus}.
 *
 * WHY the id-space split matters: metrics + detail + alerts key on the engine
 * `definitionId` (a bigint string), but triggers key on the `slug`. The rail
 * carries both, so the common path fans out all four in parallel; when only the
 * id is known, {@link resolveTriggerSlug} recovers the slug from the definition
 * detail before the triggers call. See the two-phase fan-out below.
 */

import type {
  OperationalAlertSeverity,
  OperationalDeployStatus,
  OperationalHealthVerdict,
  OperationalStatus,
} from "../shared/types.js";
import { resolveCoreBaseUrl } from "./run-spend.js";

// ---------------------------------------------------------------------------
// Pure decode helpers — one per raw upstream signal. Each is total: any shape
// it can't read folds to `null` (the signal's honest-absence value) rather
// than throwing, so a malformed body degrades one signal, not the whole fetch.
// ---------------------------------------------------------------------------

/** The runs signal, decoded from the metrics endpoint's `DefinitionMetricsDto`. */
export interface RunsSignal {
  runCount: number;
  failedCount: number;
  /** completed/(completed+failed); null when there were no finished runs. */
  successRate: number | null;
  health: OperationalHealthVerdict;
}

/** The scheduled signal, decoded from the active-triggers list. */
export interface ScheduledSignal {
  /** True when at least one active trigger exists. */
  active: boolean;
  /** Soonest upcoming fire across the active triggers; null when none carries one. */
  nextFireAt: string | null;
}

/** The open-alerts signal, decoded from the alerts list page. */
export interface AlertsSignal {
  openCount: number;
  /** True when the count hit the fetch page cap — `openCount` is then a floor. */
  truncated: boolean;
  highestSeverity: OperationalAlertSeverity | null;
}

const HEALTH_VERDICTS: ReadonlySet<string> = new Set<OperationalHealthVerdict>([
  "healthy",
  "degraded",
  "at_risk",
  "unknown",
]);

const DEPLOY_STATUSES: ReadonlySet<string> = new Set<OperationalDeployStatus>([
  "pending",
  "queued",
  "building",
  "ready",
  "failed",
  "cancelled",
  "superseded",
  "stale",
]);

/** Severity ordering (low→high) for picking the worst open alert. */
const SEVERITY_RANK: Record<OperationalAlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** Decode the metrics endpoint body into a {@link RunsSignal}; null when the
 *  required counts are absent/non-numeric (an unreadable metrics payload is
 *  honest-absent, not a zeroed signal). */
export function decodeRunsSignal(raw: unknown): RunsSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;

  const runCount = body.runCount;
  const failedCount = body.failedCount;
  if (typeof runCount !== "number" || typeof failedCount !== "number") {
    return null;
  }

  // successRate is legitimately null (no finished runs) — preserve that; only a
  // wrong TYPE (not null, not number) collapses it to null too.
  const rawRate = body.successRate;
  const successRate = typeof rawRate === "number" ? rawRate : null;

  const rawHealth = (body.health as Record<string, unknown> | undefined)
    ?.verdict;
  const health: OperationalHealthVerdict =
    typeof rawHealth === "string" && HEALTH_VERDICTS.has(rawHealth)
      ? (rawHealth as OperationalHealthVerdict)
      : "unknown";

  return { runCount, failedCount, successRate, health };
}

/** Decode the active-triggers list into a {@link ScheduledSignal}. Accepts both
 *  the bare array the core endpoint returns and a `{ data: [] }` envelope (some
 *  list surfaces wrap), so the reader is robust to either. Null when the body is
 *  neither. */
export function decodeScheduledSignal(raw: unknown): ScheduledSignal | null {
  let rows: unknown[] | null = null;
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) rows = data;
  }
  if (rows === null) return null;

  // The list is already status=active-filtered upstream, but re-check defensively
  // so a caller that drops the filter still gets an honest "active" count.
  const active = rows.filter((r) => {
    if (typeof r !== "object" || r === null) return false;
    const status = (r as Record<string, unknown>).status;
    // Treat a missing status as active — the endpoint was asked for actives.
    return status === undefined || status === "active";
  });

  let nextFireAt: string | null = null;
  for (const r of active) {
    const at = (r as Record<string, unknown>).nextFireAt;
    if (typeof at !== "string" || at === "") continue;
    // Soonest wins. String compare is safe for same-format ISO-8601 UTC stamps;
    // fall back to lexical order if a timestamp is unparseable.
    if (nextFireAt === null || at < nextFireAt) nextFireAt = at;
  }

  return { active: active.length > 0, nextFireAt };
}

/** Decode the definition detail body's `activeBuildRunStatus` into an
 *  {@link OperationalDeployStatus}. Returns `null` when the definition has no
 *  active build (the field is present-but-null) OR when the value is an
 *  unrecognized status — both fold to "no deploy status to show". Callers
 *  distinguish this from a failed detail fetch by whether the fetch resolved. */
export function decodeDeployStatus(raw: unknown): OperationalDeployStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).activeBuildRunStatus;
  if (typeof value === "string" && DEPLOY_STATUSES.has(value)) {
    return value as OperationalDeployStatus;
  }
  return null;
}

/** Extract the authoritative slug from a definition detail body; null when
 *  absent. Used by {@link resolveTriggerSlug} to key the triggers call when the
 *  caller passed only a definitionId. */
export function decodeDefinitionSlug(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const slug = (raw as Record<string, unknown>).slug;
  return typeof slug === "string" && slug !== "" ? slug : null;
}

/** Decode the alerts list page into an {@link AlertsSignal}. `pageLimit` is the
 *  `page[limit]` the fetch used — when the returned page fills it, the count is
 *  a floor and `truncated` is set. Null when the body carries no `data` array. */
export function decodeAlertsSignal(
  raw: unknown,
  pageLimit: number,
): AlertsSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  let highestRank = -1;
  let highestSeverity: OperationalAlertSeverity | null = null;
  for (const a of data) {
    if (typeof a !== "object" || a === null) continue;
    const sev = (a as Record<string, unknown>).severity;
    if (
      sev === "info" ||
      sev === "warning" ||
      sev === "error"
    ) {
      const rank = SEVERITY_RANK[sev];
      if (rank > highestRank) {
        highestRank = rank;
        highestSeverity = sev;
      }
    }
  }

  return {
    openCount: data.length,
    truncated: data.length >= pageLimit,
    highestSeverity,
  };
}

// ---------------------------------------------------------------------------
// Pure id-space resolution + stitch. Separated from I/O so the aggregation is
// unit-testable without a network (the ticket's acceptance criterion).
// ---------------------------------------------------------------------------

/**
 * Resolve the slug the triggers call keys on. The caller hint (the slug the rail
 * already carries) wins; otherwise fall back to the slug recovered from the
 * definition detail. Null when neither is available — the triggers signal is
 * then honestly absent, since it cannot be keyed.
 */
export function resolveTriggerSlug(
  hint: string | null | undefined,
  detailSlug: string | null,
): string | null {
  if (typeof hint === "string" && hint !== "") return hint;
  return detailSlug;
}

/** Inputs to {@link stitchOperationalStatus}: one decoded signal per source, or
 *  `null` where that source's fetch failed (→ honest absence). `deploy` is
 *  wrapped so a successful detail fetch with no active build (`status: null`) is
 *  distinguishable from a failed detail fetch (`null`). */
export interface OpStatusStitchInput {
  definitionId: string;
  slug: string | null;
  runs: RunsSignal | null;
  scheduled: ScheduledSignal | null;
  /** `{ status }` when the detail fetch succeeded (status may be null = no
   *  active build); `null` when the detail fetch failed. */
  deploy: { status: OperationalDeployStatus | null } | null;
  alerts: AlertsSignal | null;
}

/**
 * Stitch the four decoded signals into an {@link OperationalStatus}, honouring
 * honest absence: a `null` input omits that signal's field(s) entirely, while a
 * present signal maps its (possibly empty/zero) value through. Pure — no I/O.
 */
export function stitchOperationalStatus(
  input: OpStatusStitchInput,
): OperationalStatus {
  const status: OperationalStatus = {
    definitionId: input.definitionId,
    slug: input.slug,
  };

  if (input.runs !== null) {
    status.runCount = input.runs.runCount;
    status.failedCount = input.runs.failedCount;
    status.successRate = input.runs.successRate;
    status.health = input.runs.health;
  }

  if (input.scheduled !== null) {
    status.scheduled = input.scheduled.active;
    status.nextFireAt = input.scheduled.nextFireAt;
  }

  if (input.deploy !== null) {
    status.deployStatus = input.deploy.status;
  }

  if (input.alerts !== null) {
    status.openAlerts = input.alerts.openCount;
    status.openAlertsTruncated = input.alerts.truncated;
    status.highestAlertSeverity = input.alerts.highestSeverity;
  }

  return status;
}

// ---------------------------------------------------------------------------
// Fetcher — the I/O shell around the pure functions above.
// ---------------------------------------------------------------------------

/** Max open alerts fetched per agent — the alerts endpoint's `page[limit]`
 *  ceiling. A definition at this many open alerts reads as "≥N" (truncated);
 *  the triage rail only needs "has open alerts / how bad", not an exact tail. */
const ALERTS_PAGE_LIMIT = 100;

export type OpStatusResult =
  | { ok: true; status: OperationalStatus }
  | { ok: false; status: number; error: string };

export interface OpStatusFetcherOpts {
  apiKey: string | null;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

/** The identifiers a per-agent status is fetched by. `slug` is optional: the
 *  rail carries both, but when only the id is known the fetcher recovers the
 *  slug from the definition detail (see {@link resolveTriggerSlug}). */
export interface OpStatusTarget {
  definitionId: string;
  slug?: string | null;
}

export interface OpStatusFetcher {
  fetch(target: OpStatusTarget): Promise<OpStatusResult>;
}

/**
 * Create a fetcher that fans out to the four operational signals and stitches
 * them. Like the sibling fetchers it is intentionally non-throwing at the
 * REQUEST level: a missing key (503) or empty id (400) returns `ok: false`, but
 * an individual signal's failure does NOT — it folds to honest absence inside a
 * still-`ok: true` {@link OperationalStatus}, so a single dead upstream never
 * blanks the whole strip.
 */
export function createOpStatusFetcher(
  opts: OpStatusFetcherOpts,
): OpStatusFetcher {
  const { apiKey, baseUrl = resolveCoreBaseUrl(), fetchImpl = fetch } = opts;

  /** GET a core-surface path with the held key; null on any non-2xx / network /
   *  decode failure. Each signal degrades independently to honest absence. */
  async function getJson(path: string): Promise<unknown | null> {
    if (!apiKey) return null;
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchRuns(definitionId: string): Promise<RunsSignal | null> {
    // 24h is the triage default (design §9's primary window). The status object
    // intentionally carries no window knob — the deep multi-window view is the
    // webapp's job; the rail/strip only need "is it alive / failing" right now.
    const raw = await getJson(
      `/v1/workflows/definitions/${encodeURIComponent(definitionId)}/metrics?range=24h`,
    );
    return raw === null ? null : decodeRunsSignal(raw);
  }

  /** Fetch the definition detail once and derive BOTH the deploy signal and the
   *  authoritative slug from it. Returns `deploy: null` when the fetch failed
   *  (honest absence), vs `{ status: null }` when it succeeded with no active
   *  build. */
  async function fetchDetail(definitionId: string): Promise<{
    deploy: { status: OperationalDeployStatus | null } | null;
    slug: string | null;
  }> {
    const raw = await getJson(
      `/v1/workflows/definitions/${encodeURIComponent(definitionId)}`,
    );
    if (raw === null) return { deploy: null, slug: null };
    return {
      deploy: { status: decodeDeployStatus(raw) },
      slug: decodeDefinitionSlug(raw),
    };
  }

  async function fetchScheduled(
    slug: string,
  ): Promise<ScheduledSignal | null> {
    const raw = await getJson(
      `/v1/workflows/definitions/${encodeURIComponent(slug)}/triggers?status=active`,
    );
    return raw === null ? null : decodeScheduledSignal(raw);
  }

  async function fetchAlerts(
    definitionId: string,
  ): Promise<AlertsSignal | null> {
    const raw = await getJson(
      `/v1/alerts?filter[subject_type]=workflow` +
        `&filter[subject_id]=${encodeURIComponent(definitionId)}` +
        `&filter[status]=open&page[limit]=${ALERTS_PAGE_LIMIT}`,
    );
    return raw === null ? null : decodeAlertsSignal(raw, ALERTS_PAGE_LIMIT);
  }

  return {
    async fetch(target: OpStatusTarget): Promise<OpStatusResult> {
      const { definitionId, slug } = target;

      // No API key — do not touch the network; the harness is not signed in.
      if (!apiKey) {
        return {
          ok: false,
          status: 503,
          error: "harness is not signed in to Sapiom",
        };
      }

      // Fan out the three definitionId-keyed signals immediately. When the slug
      // is already known (the rail carries it), fan out triggers concurrently
      // too — the common, fully-parallel path.
      const runsP = fetchRuns(definitionId);
      const detailP = fetchDetail(definitionId);
      const alertsP = fetchAlerts(definitionId);
      const hintedScheduledP =
        typeof slug === "string" && slug !== ""
          ? fetchScheduled(slug)
          : null;

      const [runs, detail, alerts] = await Promise.all([
        runsP,
        detailP,
        alertsP,
      ]);

      // Resolve the slug the triggers call keys on: caller hint wins, else the
      // slug recovered from the detail we just fetched (the id-space bridge).
      const resolvedSlug = resolveTriggerSlug(slug, detail.slug);

      // Scheduled: use the concurrent hinted fetch if we had a slug up front;
      // otherwise fetch it now that the detail resolved one. Absent when no slug
      // could be resolved (triggers cannot be keyed).
      let scheduled: ScheduledSignal | null = null;
      if (hintedScheduledP !== null) {
        scheduled = await hintedScheduledP;
      } else if (resolvedSlug !== null) {
        scheduled = await fetchScheduled(resolvedSlug);
      }

      const status = stitchOperationalStatus({
        definitionId,
        slug: resolvedSlug,
        runs,
        scheduled,
        deploy: detail.deploy,
        alerts,
      });

      return { ok: true, status };
    },
  };
}
