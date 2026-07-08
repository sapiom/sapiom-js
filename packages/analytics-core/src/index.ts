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
 *   analytics.track("cli_command", { command: "dev" });
 *   await analytics.shutdown();
 *
 * Opt out with `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or
 * `disabled: true`. Analytics never throws and never blocks the host.
 */
export { createAnalytics, FIRST_RUN_NOTICE } from "./analytics.js";
export { FLUSH_INTERVAL_MS, MAX_BATCH_SIZE } from "./batch-queue.js";
export { MAX_FIELD_LENGTH } from "./data.js";
export { SCHEMA_VERSION } from "./envelope.js";
export { DEFAULT_ENDPOINT } from "./http-sender.js";
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
