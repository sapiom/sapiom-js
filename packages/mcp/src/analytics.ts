/**
 * Process-wide usage-analytics emitter for the MCP server.
 *
 * One instance per process: `main()` constructs it at startup via
 * {@link configureAnalytics}, passing the API key from the resolved
 * environment's cached credentials when one exists (server-side enrichment);
 * everything else reaches the same instance through {@link getAnalytics}.
 *
 * The emitter is live by default: it delivers to the hosted Sapiom collector
 * unless opted out. `SAPIOM_ANALYTICS_ENDPOINT` overrides the destination
 * (useful in tests). The standard opt-outs (`SAPIOM_TELEMETRY_DISABLED=1`,
 * `DO_NOT_TRACK=1`) are honored by `@sapiom/analytics-core` and produce a
 * complete no-op (zero network calls, zero disk writes). `track()` is a
 * synchronous enqueue that never throws and never blocks a tool call.
 */
import { createAnalytics, type SapiomAnalytics } from "@sapiom/analytics-core";

import { packageVersion } from "./version.js";

let instance: SapiomAnalytics | null = null;

/**
 * Construct the process-wide emitter once. Later calls return the existing
 * instance unchanged, so the API key must be supplied by the first caller
 * (in practice `main()`, right after the environment is resolved).
 */
export function configureAnalytics(
  options: { apiKey?: string } = {},
): SapiomAnalytics {
  if (instance === null) {
    instance = createAnalytics({
      source: "mcp",
      sdkName: "@sapiom/mcp",
      sdkVersion: packageVersion(),
      apiKey: options.apiKey,
    });
  }
  return instance;
}

/** The emitter, lazily constructed (keyless) if `configureAnalytics` hasn't run. */
export function getAnalytics(): SapiomAnalytics {
  return instance ?? configureAnalytics();
}

/** Test seam: replace (or, with `null`, reset) the process-wide instance. */
export function setAnalyticsForTesting(next: SapiomAnalytics | null): void {
  instance = next;
}
