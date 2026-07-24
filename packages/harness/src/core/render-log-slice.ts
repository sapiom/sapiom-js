/**
 * render-log-slice — the shared, dependency-free formatter for a step's executor
 * log buffer. Both run mappers use it so a step's `logSlice` is byte-identical
 * whether it came from a prod {@link import("./render-run-state.js").renderRunState}
 * projection or a local {@link import("./render-local-run.js").renderLocalRun}
 * trace — the inspector can never disagree with itself about how a log renders.
 *
 * Kept in its OWN module (rather than in render-run-state.ts) precisely because
 * it has NO `@sapiom/agent-core` dependency: render-run-state pulls in agent-core
 * runtime helpers (e.g. `isExecutionTerminal`) that reach for `node:fs`, which
 * must never enter the browser bundle. The local-run mapper is imported by the
 * SPA, so it depends on THIS pure module instead — no Node built-ins ride along.
 *
 * Pure and deterministic: no I/O, no clock. Safe in both Node and the browser.
 */

/**
 * Cap on the characters of a step's executor log buffer surfaced in `logSlice`.
 * The TAIL is kept (most recent lines) because failures surface at the end of a
 * log. This is a payload guard on the poll/stream response; the debug-macro
 * context extractor does the final, smaller trim for prompt injection.
 */
export const LOG_SLICE_MAX = 4000;

/** One executor log entry → a compact line. Accepts the `{ ts, level, msg }`
 *  wire shape (or `message`), a bare string, or anything else (stringified).
 *  A local trace's `{ level, msg }` entry is a subset of this same shape. */
export function formatLogEntry(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const e = entry as {
      ts?: unknown;
      level?: unknown;
      msg?: unknown;
      message?: unknown;
    };
    const parts = [e.ts, e.level, e.msg ?? e.message].filter(
      (p): p is string | number =>
        typeof p === "string" || typeof p === "number",
    );
    if (parts.length > 0) return parts.map(String).join(" ");
  }
  return String(entry);
}

/** Format the executor log buffer into a trimmed, tail-preserving slice, or
 *  `undefined` when there are no usable logs. */
export function toLogSlice(logs: unknown): string | undefined {
  if (!Array.isArray(logs) || logs.length === 0) return undefined;
  const text = logs.map(formatLogEntry).join("\n").trim();
  if (text === "") return undefined;
  return text.length > LOG_SLICE_MAX
    ? text.slice(text.length - LOG_SLICE_MAX)
    : text;
}
