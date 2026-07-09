/**
 * Usage-analytics plumbing for the orchestration operations (deploy / run /
 * link / run-local). Events are emitted through `@sapiom/analytics-core`,
 * which ships dark by default: unless a collector endpoint is explicitly
 * configured (the `SAPIOM_ANALYTICS_ENDPOINT` environment variable), every
 * `track` call is a silent no-op — zero network calls, zero disk writes.
 * Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
 *
 * This module is the package's ONLY exception to the "no process.env reads /
 * no global state" design contract (see index.ts), and it is scoped tightly:
 * the env reads happen inside `createAnalytics` (consent + endpoint), the
 * emitter is constructed lazily at the operation call boundary — never inside
 * `GatewayClient`, which stays env-free — and telemetry can never change an
 * operation's behavior, results, or errors (`track` is synchronous,
 * enqueue-only, and never throws).
 *
 * Not re-exported from the package index; the published `exports` map only
 * exposes `.`, so nothing here is public API.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createAnalytics, type SapiomAnalytics } from "@sapiom/analytics-core";

import { AgentOperationError } from "./errors.js";

/**
 * Directory of THIS compiled module, resolved for both build outputs (same
 * trick as scaffold.ts): CommonJS → `__dirname`; ESM → `import.meta.url`,
 * read via `eval` because this source file is also compiled under
 * `module: commonjs`, where a literal `import.meta` is a hard compile error
 * (TS1343). Node-targeted only.
 */
function resolveModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  try {
    // eslint-disable-next-line no-eval
    const metaUrl = eval("import.meta.url") as string | undefined;
    if (typeof metaUrl === "string")
      return path.dirname(fileURLToPath(metaUrl));
  } catch {
    // Not an ESM runtime — fall through to the empty default.
  }
  return "";
}

/**
 * This package's own version, for the envelope's `sdk_version` field. The
 * module sits at `src/` (tests) or `dist/{cjs,esm}/` (published), so the
 * package.json is one or two levels up; the name check skips impostors
 * (e.g. the `{"type":"module"}` marker at `dist/esm/package.json`).
 * Telemetry metadata only — any failure degrades to "0.0.0".
 */
function readOwnVersion(): string {
  try {
    const moduleDir = resolveModuleDir();
    for (const levelsUp of ["..", path.join("..", "..")]) {
      const candidate = path.join(moduleDir, levelsUp, "package.json");
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (
        parsed.name === "@sapiom/agent-core" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    }
  } catch {
    // Never fail an operation over a version string.
  }
  return "0.0.0";
}

let instance: SapiomAnalytics | null = null;

/**
 * The process-shared orchestration analytics emitter, constructed lazily on
 * first use. One instance per process (batching, the identity file, and the
 * `beforeExit` flush hook are all per-instance, so per-call construction
 * would leak listeners in long-lived hosts like the MCP server).
 */
export function getOrchestrationAnalytics(): SapiomAnalytics {
  if (instance === null) {
    instance = createAnalytics({
      source: "orchestration",
      sdkName: "@sapiom/agent-core",
      sdkVersion: readOwnVersion(),
    });
  }
  return instance;
}

/**
 * Test-only: shut down and drop the memoized emitter so the next
 * `getOrchestrationAnalytics()` re-reads the environment (endpoint/consent
 * are resolved once, at construction).
 */
export function resetOrchestrationAnalyticsForTesting(): void {
  const previous = instance;
  instance = null;
  if (previous) void previous.shutdown();
}

/**
 * Machine-readable code for a failed operation's analytics payload.
 * Codes/class names only (`HTTP_401`, `NETWORK`, `BUILD_FAILED`, ...) —
 * never error messages, which can carry user content.
 */
export function telemetryErrorCode(err: unknown): string {
  if (err instanceof AgentOperationError) return err.code;
  if (err instanceof Error) return err.name;
  return "UnknownError";
}
