/**
 * `@sapiom/analytics-core` — zero-dependency usage analytics emitter shared
 * by Sapiom SDK packages.
 *
 *   import { createAnalytics } from "@sapiom/analytics-core";
 *
 *   const analytics = createAnalytics({
 *     source: "cli",
 *     sdkName: "@sapiom/cli",
 *     sdkVersion: "1.0.0",
 *   });
 *   analytics.track("command.run", { command: "dev" });
 *   await analytics.shutdown();
 *
 * The emitter delivers to the hosted Sapiom collector
 * (`SAPIOM_COLLECTOR_ENDPOINT`) by default; a configured `endpoint`
 * overrides it.
 *
 * Opt out with `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or
 * `disabled: true` — an opted-out emitter is a silent no-op: zero network
 * calls, zero disk writes. Analytics never throws and never blocks the host.
 *
 * Test utilities (an in-process mock collector) live in the
 * `@sapiom/analytics-core/testing` subpath export.
 */
export { createAnalytics, FIRST_RUN_NOTICE } from "./analytics.js";
export { FLUSH_INTERVAL_MS, MAX_BATCH_SIZE } from "./batch-queue.js";
export { MAX_FIELD_LENGTH } from "./data.js";
export { SCHEMA_VERSION } from "./envelope.js";
export { SAPIOM_COLLECTOR_ENDPOINT } from "./http-sender.js";
export type {
  AnalyticsConfig,
  DebugHook,
  Envelope,
  EnvelopeFields,
  EventSource,
  FetchLike,
  FetchRequestInit,
  FetchResponseLike,
  SapiomAnalytics,
} from "./types.js";
