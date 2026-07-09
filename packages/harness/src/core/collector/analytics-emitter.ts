/**
 * Harness remote telemetry emitter — a thin adapter that bridges the
 * harness-internal `AnalyticsEvent` shape into `@sapiom/analytics-core`'s
 * `track()` API, forwarding events to the hosted collector at
 * `POST /v1/analytics/collector`.
 *
 * Design contract:
 * - ONE analytics-core instance per harness server process. Multiple
 *   concurrent harness sessions are multiplexed onto it via per-event
 *   `session_id` overrides — no timer/listener multiplication.
 * - Consent is wired via the `disabled` flag on the analytics instance.
 *   When the settings toggle changes, the current instance is shut down and
 *   a new one is created with the updated flag.
 * - The local ndjson store (store.ts) is written ALWAYS, independent of
 *   consent; this emitter gates only the remote collector path.
 * - `SAPIOM_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` are honored by
 *   analytics-core's own consent resolution, at highest precedence.
 * - Event shape follows the harness convergence additions in the collector
 *   contract: `data.seq`, `data.context`, `data.harness_session_id`,
 *   `data.agent_session_id`, `data.harness_kind`, `source: "harness"`.
 */

import {
  createAnalytics,
  SAPIOM_COLLECTOR_ENDPOINT,
  type AnalyticsConfig,
  type FetchLike,
  type SapiomAnalytics,
} from "@sapiom/analytics-core";

import type { AnalyticsEvent, CollectorContext } from "../../shared/types.js";

export interface HarnessAnalyticsEmitterOptions {
  /** Whether remote telemetry is currently opted in. Mutable via setOptIn(). */
  telemetryOptIn: boolean;
  /** Harness package version and runtime context stamped on every event. */
  context: CollectorContext;
  /** Harness package name, e.g. "@sapiom/harness". */
  sdkName: string;
  /** Harness package version string. */
  sdkVersion: string;
  /** Optional API key for server-side org enrichment (x-sapiom-api-key header). */
  apiKey?: string | null;
  /**
   * Collector endpoint. Defaults to SAPIOM_COLLECTOR_ENDPOINT (the hosted
   * collector). When SAPIOM_ANALYTICS_ENDPOINT is set in the environment,
   * analytics-core uses that instead (allows tests to redirect to a mock).
   */
  endpoint?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
  onDebug?: (message: string) => void;
}

/**
 * The interface the ingest pipeline sees — mirrors the old CollectorBatcher
 * surface so server/ingest.ts and server/index.ts need only minimal edits.
 */
export interface HarnessEmitter {
  enqueue(event: AnalyticsEvent): void;
  setTelemetryOptIn(optIn: boolean): void;
  setApiKey(apiKey: string | null): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Build the `data` payload that analytics-core will send for a harness
 * analytics event. The harness contract adds:
 *   - `seq`               — monotonic per session, producer-assigned
 *   - `context`           — {app_version, os, arch, node} per event
 *   - `harness_session_id` — first-class analysis dimension
 *   - `agent_session_id`  — first-class analysis dimension (null if unknown)
 *   - `harness_kind`      — first-class analysis dimension
 * Plus the event's own free-form `payload` is merged in.
 */
function buildEventData(
  event: AnalyticsEvent,
  context: CollectorContext,
): Record<string, unknown> {
  return {
    ...event.payload,
    seq: event.seq,
    harness_session_id: event.harnessSessionId,
    agent_session_id: event.agentSessionId ?? null,
    harness_kind: event.harness,
    ...(event.tenantId !== null ? { tenant_id: event.tenantId } : {}),
    context: {
      app_version: context.harnessVersion,
      os: context.os,
      arch: context.arch,
      node: context.nodeVersion,
    },
  };
}

function buildConfig(
  options: HarnessAnalyticsEmitterOptions,
  telemetryOptIn: boolean,
  apiKey: string | null,
): AnalyticsConfig {
  return {
    source: "harness",
    sdkName: options.sdkName,
    sdkVersion: options.sdkVersion,
    // Point at the live collector; SAPIOM_ANALYTICS_ENDPOINT env override
    // (used in tests) takes precedence inside analytics-core's resolveEndpoint.
    endpoint: options.endpoint ?? SAPIOM_COLLECTOR_ENDPOINT,
    apiKey: apiKey ?? undefined,
    fetchImpl: options.fetchImpl,
    debug: options.onDebug
      ? (message, detail) => {
          const msg = detail !== undefined ? `${message}: ${String(detail)}` : message;
          options.onDebug!(msg);
        }
      : undefined,
    // Consent: the `disabled` flag gates the entire instance. When the
    // harness settings toggle changes, setTelemetryOptIn() shuts down the
    // current instance and creates a new one. Env flags (SAPIOM_TELEMETRY_DISABLED /
    // DO_NOT_TRACK) are checked by analytics-core at highest precedence, so
    // they always override the stored consent state.
    disabled: !telemetryOptIn,
  };
}

export function createHarnessEmitter(
  options: HarnessAnalyticsEmitterOptions,
): HarnessEmitter {
  let telemetryOptIn = options.telemetryOptIn;
  let apiKey = options.apiKey ?? null;
  let analytics: SapiomAnalytics = createAnalytics(
    buildConfig(options, telemetryOptIn, apiKey),
  );

  function recreate(discardPrevQueue = false): void {
    // Install the new instance synchronously so enqueue() calls that arrive
    // during the async shutdown drain land on the correct new instance.
    const prev = analytics;
    analytics = createAnalytics(buildConfig(options, telemetryOptIn, apiKey));
    if (discardPrevQueue) {
      // Privacy-sensitive direction (opt-OUT): the user revoked consent —
      // discard buffered events before shutdown so they are not delivered.
      // In-flight sends (already on the wire) still complete normally;
      // only the in-memory buffer is dropped.
      prev.discard();
    }
    // The void is intentional: callers don't await this path and
    // analytics-core guarantees shutdown() never rejects.
    void prev.shutdown();
  }

  return {
    enqueue(event: AnalyticsEvent): void {
      analytics.track(
        event.type,
        buildEventData(event, options.context),
        {
          // Per-event session override: the harness server hosts multiple
          // concurrent sessions; each event carries its own session_id so
          // the single analytics instance can multiplex them correctly.
          session_id: event.harnessSessionId,
          event_id: event.eventId,
        },
      );
    },

    setTelemetryOptIn(optIn: boolean): void {
      if (telemetryOptIn === optIn) return;
      const wasOptedIn = telemetryOptIn;
      telemetryOptIn = optIn;
      // Recreate the instance with the updated consent state. The new
      // instance is installed synchronously so subsequent enqueue() calls
      // see it immediately.
      // Opting OUT: discard any buffered events — the user revoked consent,
      // so delivering them would violate their intent. Opting IN (or rotating
      // the apiKey): drain gracefully; those aren't privacy-sensitive.
      recreate(wasOptedIn && !optIn);
    },

    setApiKey(key: string | null): void {
      if (apiKey === key) return;
      apiKey = key;
      // Recreate with the new key. Drain gracefully (not a consent change).
      recreate(false);
    },

    async flush(): Promise<void> {
      await analytics.flush();
    },

    async close(): Promise<void> {
      await analytics.shutdown();
    },
  };
}
