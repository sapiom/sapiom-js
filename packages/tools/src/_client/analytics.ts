/**
 * Usage analytics for `@sapiom/tools` — the Transport (this package's single
 * HTTP choke point) enqueues ONE `capability.call` event per capability HTTP
 * call through `@sapiom/analytics-core`.
 *
 * Non-negotiables, guaranteed regardless of configuration:
 * - Ships dark: without a collector endpoint (`SAPIOM_ANALYTICS_ENDPOINT`) the
 *   emitter is a silent no-op — zero network calls, zero disk writes.
 * - Enqueue-only on the call path: `track()` is synchronous, delivery is
 *   batched off the call path, and no failure here can surface to a caller.
 * - Opt out with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAnalytics,
  type SapiomAnalytics,
} from "@sapiom/analytics-core";

import type { Attribution } from "./index.js";

/** The one event this package emits: one per capability HTTP call. Dot-form is canonical. */
export const CAPABILITY_CALL_EVENT = "capability.call";

/**
 * Lazily-created emitter shared by a Transport and every transport derived
 * from it via `withAttribution` — one emitter (one batch queue, one exit
 * hook) per client, no matter how many attributed views are derived.
 */
export interface AnalyticsHolder {
  instance?: SapiomAnalytics;
}

/** Get (creating on first use) the holder's emitter. Never throws — `createAnalytics` can't. */
export function analyticsFor(
  holder: AnalyticsHolder,
  apiKey: string | undefined,
): SapiomAnalytics {
  return (holder.instance ??= createAnalytics({
    source: "tools",
    sdkName: "@sapiom/tools",
    sdkVersion: resolveSdkVersion(),
    // Sent as `x-sapiom-api-key` on collector batches so the server can
    // enrich events with the tenant — never placed in event payloads.
    apiKey,
  }));
}

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/** Everything the Transport knows about one finished (or failed) capability HTTP call. */
export interface CapabilityCallInfo {
  url: string;
  /** `RequestInit.method`; absent means GET (fetch semantics). */
  method: string | undefined;
  /** `RequestInit.body` — only its SIZE is recorded, never its content. */
  requestBody: unknown;
  durationMs: number;
  /** HTTP status; absent when the fetch itself threw (network-level failure). */
  status?: number;
  ok: boolean;
  /** The thrown value when the fetch failed before producing a response. */
  error?: unknown;
  /** The transport's attribution — execution context, recorded as-is. */
  attribution: Attribution;
}

/**
 * Build the `capability.call` event `data`. All requests are Sapiom-bound, so
 * full request metadata (URL incl. query, sizes, attribution) is captured;
 * per-field size caps are enforced downstream by the emitter (~16 KB).
 * Request/response BODIES are never captured — only the request body size.
 */
export function capabilityCallData(
  info: CapabilityCallInfo,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    capability: capabilityFromUrl(info.url),
    method: (info.method ?? "GET").toUpperCase(),
    url: info.url,
    ok: info.ok,
    duration_ms: info.durationMs,
  };
  if (info.status !== undefined) data.status = info.status;
  const requestBytes = bodySize(info.requestBody);
  if (requestBytes !== undefined) data.request_bytes = requestBytes;
  if (info.error !== undefined) {
    data.error = errorLabel(info.error);
    const message = errorMessage(info.error);
    if (message !== undefined) data.error_message = message;
  }
  const a = info.attribution;
  if (a.agentId) data.agent_id = a.agentId;
  if (a.agentName) data.agent_name = a.agentName;
  if (a.traceId) data.trace_id = a.traceId;
  if (a.traceExternalId) data.trace_external_id = a.traceExternalId;
  if (a.metadata) data.attribution_metadata = a.metadata;
  return data;
}

/** Matches the routed-capability seam's path shape: `/v1/capabilities/<id>`. */
const ROUTED_CAPABILITY_PATH = /^\/v1\/capabilities\/([^/]+)\/?$/;

/**
 * Derive the capability name from the request URL:
 * - a routed call (`POST <core>/v1/capabilities/<id>`) → the capability id
 *   (`web.scrape`, `email.verify`, …);
 * - anything else (service-gateway capabilities) → the URL path, which is the
 *   stable per-operation identifier on those hosts (`/v1/sandboxes`, …);
 * - an unparseable URL → the raw string (capped downstream).
 */
export function capabilityFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const routed = ROUTED_CAPABILITY_PATH.exec(parsed.pathname);
    if (routed) return safeDecode(routed[1]);
    return parsed.pathname || url;
  } catch {
    return url;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Size in bytes of a request body when cheaply knowable (string / Blob / buffer views). */
function bodySize(body: unknown): number | undefined {
  try {
    if (typeof body === "string") return Buffer.byteLength(body);
    if (body !== null && typeof body === "object") {
      const { size, byteLength } = body as {
        size?: unknown; // Blob / File
        byteLength?: unknown; // ArrayBuffer / TypedArray views
      };
      if (typeof size === "number") return size;
      if (typeof byteLength === "number") return byteLength;
    }
  } catch {
    // Analytics never throws; an unknown body simply has no recorded size.
  }
  return undefined;
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

// ---------------------------------------------------------------------------
// SDK version
// ---------------------------------------------------------------------------

let cachedSdkVersion: string | null = null;

/**
 * This package's own version, read from its package.json at first use (so the
 * emitted `sdk_version` always matches the published version, with no
 * build-step or constant to keep in sync). Walks up from the compiled module —
 * which works from `src/` (tests), `dist/cjs/`, and `dist/esm/` alike — and
 * falls back to `"unknown"` rather than ever throwing.
 */
export function resolveSdkVersion(): string {
  return (cachedSdkVersion ??= readOwnPackageVersion());
}

function readOwnPackageVersion(): string {
  try {
    let dir = resolveModuleDir();
    for (let hops = 0; dir !== ""; hops++) {
      if (hops >= 8) break;
      const version = versionIfOwnPackage(path.join(dir, "package.json"));
      if (version !== undefined) return version;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Version resolution must never break a capability call.
  }
  return "unknown";
}

/** The `version` of the manifest at `manifestPath` iff it is this package's own. */
function versionIfOwnPackage(manifestPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (
      manifest.name === "@sapiom/tools" &&
      typeof manifest.version === "string"
    ) {
      return manifest.version;
    }
  } catch {
    // Missing or unparseable manifest at this level — keep walking up.
  }
  return undefined;
}

/**
 * Directory of this compiled module, resolved for BOTH build formats:
 *   - CommonJS build (and ts-jest) → `__dirname` (a real global);
 *   - ESM build → recovered from a stack trace, where V8 reports this module
 *     as a `file://` URL.
 *
 * The stack route is used because a literal `import.meta` is a hard compile
 * error (TS1343) in this single source file's CommonJS compilation, and
 * `eval("import.meta.url")` throws at runtime — eval'd code is parsed as a
 * script, where `import.meta` is invalid. A stack frame is the one anchor
 * available to both formats; any failure degrades to `"unknown"`, never throws.
 */
function resolveModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  try {
    const file = ownFileFromStack();
    if (file !== undefined) {
      return path.dirname(
        file.startsWith("file:") ? fileURLToPath(file) : file,
      );
    }
  } catch {
    // No usable anchor — version resolution degrades to "unknown".
  }
  return "";
}

/**
 * This module's own file (path or `file://` URL), read from the top-most
 * user frame of a fresh stack — which is this function itself, i.e. this file.
 */
function ownFileFromStack(): string | undefined {
  const stack = new Error().stack;
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n").slice(1)) {
    // V8 frames: "    at fn (file:///p/analytics.js:1:2)" / "    at /p/analytics.js:1:2"
    const match = /(?:\(|at )((?:file:\/\/)?[^\s()]+):\d+:\d+\)?\s*$/.exec(
      line,
    );
    const file = match?.[1];
    if (!file || file.startsWith("node:") || file === "<anonymous>") continue;
    return file;
  }
  return undefined;
}
