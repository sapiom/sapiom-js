import { describe, it, expect, vi } from "vitest";

import {
  createOpStatusFetcher,
  decodeAlertsSignal,
  decodeDefinitionSlug,
  decodeDeployStatus,
  decodeRunsSignal,
  decodeScheduledSignal,
  resolveTriggerSlug,
  stitchOperationalStatus,
} from "./op-status.js";

// ---------------------------------------------------------------------------
// Realistic upstream fixtures (mirror the backend DTOs the harness reads).
// ---------------------------------------------------------------------------

/** `DefinitionMetricsDto` slice (SAP-982). */
const RAW_METRICS = {
  definitionId: "188",
  runCount: 42,
  succeededCount: 37,
  failedCount: 5,
  runningCount: 1,
  waitingCount: 0,
  successRate: 0.88,
  health: {
    verdict: "degraded",
    signals: [{ key: "success_rate", status: "warn", detail: "success 88%" }],
  },
};

/** The core triggers endpoint returns a BARE array of trigger rows. */
const RAW_TRIGGERS_ACTIVE = [
  {
    id: "trig-2",
    kind: "schedule_cron",
    status: "active",
    definitionSlug: "enrich-lead",
    cron: "0 9 * * 1-5",
    nextFireAt: "2026-07-23T09:00:00.000Z",
  },
  {
    id: "trig-1",
    kind: "schedule_cron",
    status: "active",
    definitionSlug: "enrich-lead",
    cron: "0 6 * * *",
    nextFireAt: "2026-07-23T06:00:00.000Z",
  },
];

/** `DefinitionDetailDto` slice — carries both `slug` and `activeBuildRunStatus`. */
const RAW_DETAIL = {
  id: "188",
  slug: "enrich-lead",
  name: "Enrich Lead",
  activeBuildRunStatus: "ready",
};

/** Alerts JSON:API list page `{ data, links, meta }`. */
const RAW_ALERTS = {
  data: [
    { id: "a1", severity: "warning", status: "open", count: 3 },
    { id: "a2", severity: "error", status: "open", count: 1 },
  ],
  links: { self: "/alerts" },
  meta: { page: { limit: 100, hasNext: false, hasPrev: false } },
};

// ---------------------------------------------------------------------------
// decode helpers
// ---------------------------------------------------------------------------

describe("decodeRunsSignal", () => {
  it("maps the metrics DTO to counts + rate + health verdict", () => {
    expect(decodeRunsSignal(RAW_METRICS)).toEqual({
      runCount: 42,
      failedCount: 5,
      successRate: 0.88,
      health: "degraded",
    });
  });

  it("preserves a null successRate (no finished runs) rather than zeroing it", () => {
    const signal = decodeRunsSignal({
      runCount: 0,
      failedCount: 0,
      successRate: null,
      health: { verdict: "unknown" },
    });
    expect(signal).toEqual({
      runCount: 0,
      failedCount: 0,
      successRate: null,
      health: "unknown",
    });
  });

  it("falls back to 'unknown' when the health verdict is missing or unrecognized", () => {
    expect(decodeRunsSignal({ runCount: 1, failedCount: 0 })?.health).toBe(
      "unknown",
    );
    expect(
      decodeRunsSignal({
        runCount: 1,
        failedCount: 0,
        health: { verdict: "on_fire" },
      })?.health,
    ).toBe("unknown");
  });

  it("returns null (honest absence) when required counts are absent/non-numeric", () => {
    expect(decodeRunsSignal(null)).toBeNull();
    expect(decodeRunsSignal({ runCount: "42", failedCount: 5 })).toBeNull();
    expect(decodeRunsSignal({ runCount: 42 })).toBeNull();
  });
});

describe("decodeScheduledSignal", () => {
  it("reports active + the SOONEST upcoming fire across the active triggers", () => {
    expect(decodeScheduledSignal(RAW_TRIGGERS_ACTIVE)).toEqual({
      active: true,
      nextFireAt: "2026-07-23T06:00:00.000Z",
    });
  });

  it("reports not-scheduled for an empty list", () => {
    expect(decodeScheduledSignal([])).toEqual({
      active: false,
      nextFireAt: null,
    });
  });

  it("accepts a { data: [] } envelope as well as a bare array", () => {
    expect(decodeScheduledSignal({ data: RAW_TRIGGERS_ACTIVE })).toEqual({
      active: true,
      nextFireAt: "2026-07-23T06:00:00.000Z",
    });
  });

  it("is active with a null nextFireAt when triggers carry no upcoming fire", () => {
    expect(
      decodeScheduledSignal([{ id: "t", status: "active", nextFireAt: null }]),
    ).toEqual({ active: true, nextFireAt: null });
  });

  it("excludes paused triggers from the active count", () => {
    expect(
      decodeScheduledSignal([
        { id: "t", status: "paused", nextFireAt: "2026-07-23T06:00:00.000Z" },
      ]),
    ).toEqual({ active: false, nextFireAt: null });
  });

  it("returns null (honest absence) when the body is neither array nor envelope", () => {
    expect(decodeScheduledSignal(null)).toBeNull();
    expect(decodeScheduledSignal({ foo: "bar" })).toBeNull();
  });
});

describe("decodeDeployStatus", () => {
  it("maps a recognized activeBuildRunStatus", () => {
    expect(decodeDeployStatus(RAW_DETAIL)).toBe("ready");
    expect(decodeDeployStatus({ activeBuildRunStatus: "stale" })).toBe("stale");
  });

  it("returns null for a present-but-null build status (no active build)", () => {
    expect(decodeDeployStatus({ activeBuildRunStatus: null })).toBeNull();
  });

  it("returns null for an unrecognized status or missing field", () => {
    expect(decodeDeployStatus({ activeBuildRunStatus: "exploded" })).toBeNull();
    expect(decodeDeployStatus({})).toBeNull();
    expect(decodeDeployStatus(null)).toBeNull();
  });
});

describe("decodeDefinitionSlug", () => {
  it("extracts the slug from the definition detail", () => {
    expect(decodeDefinitionSlug(RAW_DETAIL)).toBe("enrich-lead");
  });

  it("returns null when the slug is absent or empty", () => {
    expect(decodeDefinitionSlug({ id: "188" })).toBeNull();
    expect(decodeDefinitionSlug({ slug: "" })).toBeNull();
    expect(decodeDefinitionSlug(null)).toBeNull();
  });
});

describe("decodeAlertsSignal", () => {
  it("counts open alerts and picks the highest severity", () => {
    expect(decodeAlertsSignal(RAW_ALERTS, 100)).toEqual({
      openCount: 2,
      truncated: false,
      highestSeverity: "error",
    });
  });

  it("reports zero open alerts with a null highest severity", () => {
    expect(decodeAlertsSignal({ data: [] }, 100)).toEqual({
      openCount: 0,
      truncated: false,
      highestSeverity: null,
    });
  });

  it("flags truncation when the page fills the fetch limit", () => {
    const data = Array.from({ length: 5 }, (_v, i) => ({
      id: `a${i}`,
      severity: "info",
    }));
    expect(decodeAlertsSignal({ data }, 5)).toEqual({
      openCount: 5,
      truncated: true,
      highestSeverity: "info",
    });
  });

  it("returns null (honest absence) when there is no data array", () => {
    expect(decodeAlertsSignal({ meta: {} }, 100)).toBeNull();
    expect(decodeAlertsSignal(null, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// id-space resolution (the ticket's explicit acceptance criterion)
// ---------------------------------------------------------------------------

describe("resolveTriggerSlug", () => {
  it("prefers the caller hint (the slug the rail carries)", () => {
    expect(resolveTriggerSlug("from-rail", "from-detail")).toBe("from-rail");
  });

  it("falls back to the detail slug when no hint is given", () => {
    expect(resolveTriggerSlug(undefined, "from-detail")).toBe("from-detail");
    expect(resolveTriggerSlug(null, "from-detail")).toBe("from-detail");
    expect(resolveTriggerSlug("", "from-detail")).toBe("from-detail");
  });

  it("resolves to null when neither a hint nor a detail slug is available", () => {
    expect(resolveTriggerSlug(undefined, null)).toBeNull();
    expect(resolveTriggerSlug("", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stitch — honest absence
// ---------------------------------------------------------------------------

describe("stitchOperationalStatus", () => {
  it("stitches all four present signals into the flat status object", () => {
    const status = stitchOperationalStatus({
      definitionId: "188",
      slug: "enrich-lead",
      runs: { runCount: 42, failedCount: 5, successRate: 0.88, health: "degraded" },
      scheduled: { active: true, nextFireAt: "2026-07-23T06:00:00.000Z" },
      deploy: { status: "ready" },
      alerts: { openCount: 2, truncated: false, highestSeverity: "error" },
    });
    expect(status).toEqual({
      definitionId: "188",
      slug: "enrich-lead",
      runCount: 42,
      failedCount: 5,
      successRate: 0.88,
      health: "degraded",
      scheduled: true,
      nextFireAt: "2026-07-23T06:00:00.000Z",
      deployStatus: "ready",
      openAlerts: 2,
      openAlertsTruncated: false,
      highestAlertSeverity: "error",
    });
  });

  it("OMITS a signal's fields entirely when that signal is absent (honest absence)", () => {
    const status = stitchOperationalStatus({
      definitionId: "188",
      slug: "enrich-lead",
      runs: null,
      scheduled: null,
      deploy: null,
      alerts: null,
    });
    // Only the identity is present — no faked zeros.
    expect(status).toEqual({ definitionId: "188", slug: "enrich-lead" });
    expect(status).not.toHaveProperty("runCount");
    expect(status).not.toHaveProperty("scheduled");
    expect(status).not.toHaveProperty("deployStatus");
    expect(status).not.toHaveProperty("openAlerts");
  });

  it("distinguishes a present-but-empty signal from an absent one", () => {
    const status = stitchOperationalStatus({
      definitionId: "188",
      slug: "enrich-lead",
      runs: { runCount: 0, failedCount: 0, successRate: null, health: "unknown" },
      scheduled: { active: false, nextFireAt: null },
      deploy: { status: null }, // detail OK, no active build
      alerts: { openCount: 0, truncated: false, highestSeverity: null },
    });
    // Present: the fields exist with their honest empty values.
    expect(status.runCount).toBe(0);
    expect(status.successRate).toBeNull();
    expect(status.scheduled).toBe(false);
    expect(status.deployStatus).toBeNull();
    expect(status.openAlerts).toBe(0);
    // "deploy fetch failed" would OMIT deployStatus; "no active build" keeps it null.
    expect(status).toHaveProperty("deployStatus");
  });

  it("carries a null slug through unchanged (triggers unresolvable)", () => {
    const status = stitchOperationalStatus({
      definitionId: "188",
      slug: null,
      runs: null,
      scheduled: null,
      deploy: null,
      alerts: null,
    });
    expect(status.slug).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetcher — fan-out + id-space bridge + honest absence over the network
// ---------------------------------------------------------------------------

/** The four upstream signals, keyed for the fetch mock's per-signal overrides. */
type SignalKind = "metrics" | "triggers" | "alerts" | "detail";

/** Classify a request URL to the signal it belongs to. `/metrics` and
 *  `/triggers` are checked before the generic detail path so the shared
 *  `/definitions/:id` prefix doesn't misclassify them. */
function classify(url: string): SignalKind | null {
  if (url.includes("/metrics")) return "metrics";
  if (url.includes("/triggers")) return "triggers";
  if (url.includes("/alerts")) return "alerts";
  if (url.includes("/definitions/")) return "detail";
  return null;
}

const DEFAULT_BODIES: Record<SignalKind, unknown> = {
  metrics: RAW_METRICS,
  triggers: RAW_TRIGGERS_ACTIVE,
  alerts: RAW_ALERTS,
  detail: RAW_DETAIL,
};

/**
 * A fetch mock that routes each request to its signal's fixture. `overrides`
 * maps a {@link SignalKind} to a `{status, body}` so a test can fail exactly one
 * signal while the others succeed — keyed by signal, not URL substring, so the
 * shared `/definitions/:id` prefix can't shadow a sibling call.
 */
function routedFetch(
  overrides: Partial<Record<SignalKind, { status: number; body: unknown }>> = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const kind = classify(String(input));
    const override = kind ? overrides[kind] : undefined;
    const status = override?.status ?? (kind ? 200 : 404);
    const body =
      override?.body ??
      (kind ? DEFAULT_BODIES[kind] : { error: "not found" });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as Response;
  }) as unknown as typeof fetch;
}

describe("createOpStatusFetcher — no apiKey", () => {
  it("returns 503 without touching the network", async () => {
    const spy = vi.fn();
    const fetcher = createOpStatusFetcher({ apiKey: null, fetchImpl: spy });
    const result = await fetcher.fetch({ definitionId: "188", slug: "enrich-lead" });
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "harness is not signed in to Sapiom",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createOpStatusFetcher — full fan-out (slug supplied)", () => {
  it("stitches all four signals into a 200 status", async () => {
    const fetcher = createOpStatusFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: routedFetch(),
    });
    const result = await fetcher.fetch({ definitionId: "188", slug: "enrich-lead" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toEqual({
      definitionId: "188",
      slug: "enrich-lead",
      runCount: 42,
      failedCount: 5,
      successRate: 0.88,
      health: "degraded",
      scheduled: true,
      nextFireAt: "2026-07-23T06:00:00.000Z",
      deployStatus: "ready",
      openAlerts: 2,
      openAlertsTruncated: false,
      highestAlertSeverity: "error",
    });
  });
});

describe("createOpStatusFetcher — id-space bridge (slug NOT supplied)", () => {
  it("recovers the slug from the definition detail, then fetches triggers by it", async () => {
    const fetchImpl = routedFetch();
    const fetcher = createOpStatusFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl,
    });
    const result = await fetcher.fetch({ definitionId: "188" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Slug resolved from detail → scheduled signal populated + slug echoed.
    expect(result.status.slug).toBe("enrich-lead");
    expect(result.status.scheduled).toBe(true);
    // The triggers call was keyed on the resolved SLUG, not the definitionId.
    const calledTriggersBySlug = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.some((c) =>
      String(c[0]).includes("/definitions/enrich-lead/triggers"),
    );
    expect(calledTriggersBySlug).toBe(true);
  });

  it("leaves the scheduled signal absent when the slug cannot be resolved", async () => {
    // Detail fails → no slug → triggers cannot be keyed → scheduled absent.
    const fetcher = createOpStatusFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: routedFetch({
        detail: { status: 500, body: { error: "boom" } },
      }),
    });
    const result = await fetcher.fetch({ definitionId: "188" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.slug).toBeNull();
    expect(result.status).not.toHaveProperty("scheduled");
    expect(result.status).not.toHaveProperty("deployStatus");
    // The other id-keyed signals still resolved.
    expect(result.status.runCount).toBe(42);
    expect(result.status.openAlerts).toBe(2);
  });
});

describe("createOpStatusFetcher — honest absence on partial failure", () => {
  it("folds a single dead signal to absence but keeps the rest (still 200)", async () => {
    const fetcher = createOpStatusFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: routedFetch({
        alerts: { status: 502, body: { error: "gateway" } },
      }),
    });
    const result = await fetcher.fetch({ definitionId: "188", slug: "enrich-lead" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Alerts absent…
    expect(result.status).not.toHaveProperty("openAlerts");
    // …but runs / scheduled / deploy still present.
    expect(result.status.runCount).toBe(42);
    expect(result.status.scheduled).toBe(true);
    expect(result.status.deployStatus).toBe("ready");
  });
});
