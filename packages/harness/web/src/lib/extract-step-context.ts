/**
 * Builds a compact, readable context block for a step — consumed by the
 * step-detail panel's debug macros and free-form ask. Pure and deterministic:
 * no I/O, no side effects. The block is prepended to whatever question a macro
 * or the user asks, so the agent gets the step's full context alongside the
 * question in a single injection.
 *
 * Log slice is tail-kept and trimmed to LOG_CAP characters: when a log is long,
 * the most recent output (the tail) is the most relevant for debugging.
 */
import type { RunStepSpend, StepView } from "@shared/types";
import { formatUsd } from "./format-usd";

/** Maximum characters of log slice to include in the context block. */
const LOG_CAP = 3000;

/**
 * Format latency for display: under 1 000 ms → "716ms", 1 000 ms+ → "1.4s".
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build a compact context block describing a step's current state.
 * The block is always deterministic for a given StepView — no randomness,
 * no timestamps added here. Callers append their own question.
 *
 * When `spend` is provided, a cost line is included so the agent's debug
 * context includes the step's billable cost alongside its logs and latency.
 */
export function extractStepContext(
  step: StepView,
  spend?: RunStepSpend,
): string {
  const lines: string[] = [];

  lines.push(`Step: ${step.name}`);
  lines.push(`Status: ${step.status}`);

  if (step.latencyMs != null) {
    lines.push(`Latency: ${formatLatency(step.latencyMs)}`);
  }

  if (spend != null) {
    lines.push(
      `Cost: ${formatUsd(spend.totalUsd)} across ${spend.entryCount} billable call(s)`,
    );
  }

  if (step.status === "failed" && step.error) {
    lines.push(`Error: ${step.error}`);
  }

  if (step.logSlice) {
    const raw = step.logSlice.trimEnd();
    // Tail-keep: if the slice exceeds the cap, take the last LOG_CAP chars
    // so the most recent output (most useful for debugging) is always present.
    const trimmed =
      raw.length > LOG_CAP ? raw.slice(raw.length - LOG_CAP) : raw;
    lines.push(`\nLogs:\n${trimmed}`);
  }

  return lines.join("\n");
}

/**
 * Extract the distinct http(s) URLs a step surfaced in its logs — e.g. a
 * preview/deploy URL or a file-storage download link — so the step-detail panel
 * can render them as clickable links. Order-preserving + deduped; trailing
 * sentence/JSON punctuation is stripped so a URL logged inside `{"url":"…"}` or
 * a sentence still opens cleanly.
 */
export function extractStepLinks(step: StepView): string[] {
  const matches =
    (step.logSlice ?? "").match(/https?:\/\/[^\s"'<>)\]}]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const url = match.replace(/[.,;:!?]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}
