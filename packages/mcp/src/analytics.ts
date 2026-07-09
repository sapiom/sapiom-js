/**
 * Process-wide usage-analytics emitter for the MCP server.
 *
 * One instance per process: `main()` constructs it at startup via
 * {@link configureAnalytics}, passing the API key from the resolved
 * environment's cached credentials when one exists (server-side enrichment);
 * everything else reaches the same instance through {@link getAnalytics}.
 *
 * The emitter ships dark: unless a collector endpoint is explicitly
 * configured (the `SAPIOM_ANALYTICS_ENDPOINT` environment variable), it is a
 * silent no-op — zero network calls, zero disk writes. The standard opt-outs
 * (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) are honored by
 * `@sapiom/analytics-core`, and `track()` is a synchronous enqueue that
 * never throws and never blocks a tool call.
 */
import { createRequire } from "node:module";

import { createAnalytics, type SapiomAnalytics } from "@sapiom/analytics-core";

const nodeRequire = createRequire(import.meta.url);

/** This package's own version, for the envelope's `sdk_version` field. */
function packageVersion(): string {
  try {
    const pkg = nodeRequire("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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
