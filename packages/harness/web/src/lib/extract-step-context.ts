/**
 * Debug-macro context builder for the run-inspector's step detail.
 *
 * The Studio's Debug / Explain / "why is this step slow" macros inject a
 * prompt about the selected step into the active coding-agent session. Left to
 * the step *name* alone, the agent has to re-derive everything ("what did this
 * step actually receive, what did it return, what did it call?"). This module
 * folds the rich per-step evidence the run trace exposes — the step's real
 * input and output, the capability calls it made, and which of those were
 * served by a stub — into a compact, deterministic context block that the
 * macro prepends to its question. So "why did this step do X" carries the real
 * evidence, not just a label.
 *
 * Pure and deterministic: no I/O, no side effects, no timestamps added here —
 * the same inputs always produce the same block, which is what makes it
 * unit- and mutation-testable in isolation. Callers append their own question.
 *
 * Provider rule: this block names **capabilities** (dotted ids like
 * `web.search`, `records.read`), never the upstream provider or model behind a
 * capability. The run trace and the graph are already capability-scoped; this
 * module never reaches for a model name.
 */
import type { StepView } from "@shared/types";

/** Maximum characters of the log slice to include (tail-kept — see below). */
const LOG_CAP = 3000;

/** Maximum characters a single serialized input/output value may contribute.
 *  Step payloads can be large; the agent needs the shape and the leading
 *  content, not a multi-megabyte dump pasted into its prompt. */
const VALUE_CAP = 2000;

/**
 * One capability call a step made during the run, as the debug context reports
 * it. Deliberately capability-scoped and provider-agnostic: `capability` is a
 * dotted capability id (e.g. `web.search`, `models.coding.run`) — never a
 * provider/model name. `stubUsed` records whether this call was served by a
 * supplied stub instead of a real capability call, which is the single most
 * load-bearing fact when explaining a local (offline) run: a step that
 * "succeeded" against a stub did not exercise the real capability.
 */
export interface StepCall {
  /** Dotted capability id this call targeted (provider-agnostic). */
  capability: string;
  /** True when a supplied stub served this call rather than the real capability. */
  stubUsed?: boolean;
}

/**
 * The rich per-step evidence the run trace exposes, in the shape the debug
 * context consumes. A run-trace mapper (local-stub NDJSON → inspector, or the
 * prod run-state read) populates it; every field is optional so the builder
 * degrades honestly when a source carries no value (an offline stub run has
 * input/output/calls; a prod read today may carry none of them).
 *
 * Mirrors the real per-step trace record the local runner emits — `input`,
 * `output`, and the calls made — plus the run-level stub bookkeeping
 * (`unusedStubs`, `stubWarnings`) that only a local (stub) run produces. It is
 * intentionally NOT the agent-core type itself: the browser bundle does not
 * import agent-core, so the mapper adapts that record into this
 * transport-agnostic view.
 */
export interface StepTrace {
  /** The value the step received. Absent when the trace carries no input. */
  input?: unknown;
  /** The value the step returned. Absent while running or when it threw. */
  output?: unknown;
  /** The capability calls the step made, in call order. Absent (not `[]`) when
   *  the trace records no call information for this step. */
  calls?: StepCall[];
  /** Supplied stub keys that matched no capability call in this step — almost
   *  always a typo or the wrong path form, so the mock silently did nothing.
   *  Surfaced so "why did the stub not take effect" is answerable. */
  unusedStubs?: string[];
  /** Warnings about stub values that matched a key but had the wrong shape for
   *  the capability (the silent-wrong-data trap). */
  stubWarnings?: string[];
}

/** The step's declared capabilities, when the caller has the graph node for it
 *  but no runtime call trace — used only as a fallback source for the
 *  "capabilities involved" line so a pre-run or graph-only debug ask is not
 *  silent about what the step is built to call. Provider-agnostic dotted ids. */
export interface StepGraphFacts {
  capabilities?: string[];
}

/**
 * Format latency for display: under 1 000 ms → "716ms", 1 000 ms+ → "1.4s".
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Serialize an arbitrary step input/output value into a compact, readable
 * one-or-more-line string, capped at {@link VALUE_CAP} characters. Objects and
 * arrays are pretty-printed as JSON (2-space) so the agent sees their shape;
 * strings pass through verbatim; anything JSON can't represent (a cycle, a
 * bigint) falls back to `String(value)` so the builder never throws. When the
 * result exceeds the cap it is head-kept (the shape and leading content matter
 * most for a value) with an explicit truncation marker.
 */
function formatValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      // Circular structure, bigint, or any other JSON-hostile value.
      text = String(value);
    }
  }
  if (text.length > VALUE_CAP) {
    return `${text.slice(0, VALUE_CAP)}\n… (truncated, ${text.length} chars total)`;
  }
  return text;
}

/**
 * Build a compact context block describing a step's current state plus the rich
 * per-step evidence the run trace exposes.
 *
 * The block is always deterministic for the same inputs — no randomness, no
 * timestamps added here. Callers append their own question.
 *
 * Sections, each emitted only when it has real content (honest absence — no
 * empty headers, no fabricated placeholders):
 *   - Step / Status / Latency / Error  — from the {@link StepView}.
 *   - Input / Output                   — from `trace` (the step's real values).
 *   - Capabilities called              — from `trace.calls` (with a "stubbed"
 *                                        marker per call); an empty trace reads
 *                                        "none", and only a MISSING trace falls
 *                                        back to declared `capabilities`.
 *   - Unused stubs / Stub warnings     — run-level stub bookkeeping from a
 *                                        local (offline) run.
 *   - Logs                             — the step's tail-kept log slice.
 *
 * @param step  the step's render view (name, status, latency, error, logs).
 * @param trace the rich per-step evidence (input/output/calls/stub info), when
 *              a run trace is available. Omit for a graph-only / pre-run ask.
 * @param facts the step's declared graph facts (capabilities), used only as a
 *              fallback for the capabilities line when `trace.calls` is absent.
 */
export function extractStepContext(
  step: StepView,
  trace?: StepTrace,
  facts?: StepGraphFacts,
): string {
  const lines: string[] = [];

  lines.push(`Step: ${step.name}`);
  lines.push(`Status: ${step.status}`);

  if (step.latencyMs != null) {
    lines.push(`Latency: ${formatLatency(step.latencyMs)}`);
  }

  if (step.status === "failed" && step.error) {
    lines.push(`Error: ${step.error}`);
  }

  // Real per-step input/output — the "what did this step actually receive and
  // return" evidence. Only present when the trace carries the value.
  if (trace?.input !== undefined) {
    lines.push(`\nInput:\n${formatValue(trace.input)}`);
  }
  if (trace?.output !== undefined) {
    lines.push(`\nOutput:\n${formatValue(trace.output)}`);
  }

  // Capabilities the step called. The three states are honestly distinct:
  //   - calls present + non-empty → the truth of what actually ran, each
  //     annotated with whether a stub served it.
  //   - calls present but EMPTY ([]) → the step ran and made zero capability
  //     calls. That is real evidence ("it never called out"), NOT a missing
  //     trace, so it must not borrow the declared-capabilities fallback.
  //   - calls ABSENT (undefined) → there is no call trace at all (a graph-only
  //     / pre-run ask), so fall back to the step's DECLARED capabilities to
  //     say what it is built to call rather than stay silent.
  // Capability ids only, never a model name.
  const runtimeCalls = trace?.calls;
  if (runtimeCalls !== undefined) {
    if (runtimeCalls.length > 0) {
      lines.push("\nCapabilities called:");
      for (const call of runtimeCalls) {
        const marker = call.stubUsed ? " (stubbed)" : "";
        lines.push(`  - ${call.capability}${marker}`);
      }
    } else {
      lines.push("\nCapabilities called: none (the step made zero capability calls).");
    }
  } else if (facts?.capabilities && facts.capabilities.length > 0) {
    lines.push("\nCapabilities declared (no call trace):");
    for (const capability of facts.capabilities) {
      lines.push(`  - ${capability}`);
    }
  }

  // Stub bookkeeping from a local (offline) run: a supplied stub that matched
  // nothing (silent no-op) or matched with the wrong shape (silent wrong data)
  // are the two traps a debug ask most needs surfaced.
  if (trace?.unusedStubs && trace.unusedStubs.length > 0) {
    lines.push("\nUnused stubs (supplied but matched no call):");
    for (const key of trace.unusedStubs) {
      lines.push(`  - ${key}`);
    }
  }
  if (trace?.stubWarnings && trace.stubWarnings.length > 0) {
    lines.push("\nStub warnings:");
    for (const warning of trace.stubWarnings) {
      lines.push(`  - ${warning}`);
    }
  }

  if (step.logSlice) {
    const raw = step.logSlice.trimEnd();
    // Tail-keep: if the slice exceeds the cap, take the last LOG_CAP chars so
    // the most recent output (most useful for debugging) is always present.
    const trimmed =
      raw.length > LOG_CAP ? raw.slice(raw.length - LOG_CAP) : raw;
    lines.push(`\nLogs:\n${trimmed}`);
  }

  return lines.join("\n");
}
