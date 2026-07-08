/**
 * inspect / logs — fetch execution details, step records, or build status.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 * The function named `inspect` (vs `logs`) makes the intent clear for
 * programmatic consumers; the CLI alias these as "logs" on its command surface.
 */
import { GatewayClient } from "./client.js";
import { decodeExecutionProjection, decodeExecutionRef } from "./decode.js";
import type { ExecutionProjection, ExecutionRef, SseEvent } from "./types.js";
import { watchExecution } from "./watch.js";

export interface BuildDetail {
  id?: string;
  status: string;
  error?: unknown;
}

// ── Inspect an execution ──────────────────────────────────────────────────────

export interface InspectOptions {
  executionId: string;
}

/**
 * Fetch the full {@link ExecutionProjection} for a single execution — the same
 * tree + per-node cost + trace refs the REST DTO returns (Module P / SAP-1138).
 * The SDK is a thin passthrough of the REST shape; the body is only NORMALIZED
 * (see {@link decodeExecutionProjection}) so pre-seam runs decode without error
 * (degraded tree from lineage, flat cost fallback) — never reshaped or recosted.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function inspect(
  opts: InspectOptions,
  client: GatewayClient,
): Promise<ExecutionProjection> {
  const raw = await client.get<unknown>(`/executions/${opts.executionId}`);
  return decodeExecutionProjection(raw);
}

// ── Wait for an execution to settle ────────────────────────────────────────────

/** Statuses an execution will not advance from. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

/** True when an execution has reached a state it won't advance from on its own. */
export function isExecutionTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Pause signals the engine resumes on its own (a dispatched capability reports
 * completion via a callback), so a wait should keep polling through them.
 * Extend as more dispatched capabilities land.
 */
const AUTO_RESUME_PAUSE_SIGNALS = [
  "models.coding.result",
  "contentGeneration.video.result",
];

export type WaitStopReason = "terminal" | "needs-signal" | "timeout";

export interface WaitForExecutionOptions {
  executionId: string;
  /** Max wall-clock to wait before returning the latest snapshot. Default 45_000. */
  maxWaitMs?: number;
  /** Poll-fallback interval; backs off (×1.5, capped at 5s) between reads. Default 1_000. */
  pollMs?: number;
  /** Paused signals that auto-resume — keep waiting through them rather than returning. */
  autoResumeSignals?: string[];
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * The live event source. Defaults to {@link watchExecution}; injectable so
   * tests can drive the SSE path deterministically. When it throws / ends
   * without the run settling, the wait reverts to the poll loop below.
   */
  watch?: (
    opts: { executionId: string; signal?: AbortSignal },
    client: GatewayClient,
  ) => AsyncIterable<SseEvent>;
}

export interface WaitForExecutionResult {
  execution: ExecutionProjection;
  /** Why polling stopped. */
  reason: WaitStopReason;
  /** True only when the execution reached a terminal status. */
  done: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an execution has settled into a state `waitForExecution` should return
 * on. `null` means "still in flight — keep waiting". A paused run only settles
 * when its signal is NOT one the engine auto-resumes.
 */
function settledResult(
  execution: ExecutionProjection,
  autoResume: string[],
): { reason: WaitStopReason; done: boolean } | null {
  if (isExecutionTerminal(execution.status)) {
    return { reason: "terminal", done: true };
  }
  if (execution.status === "paused") {
    const signal = execution.pausedSignalName ?? null;
    if (!signal || !autoResume.includes(signal)) {
      // Won't progress on its own — an external signal is required.
      return { reason: "needs-signal", done: false };
    }
  }
  return null;
}

/**
 * Wait for an execution to reach a terminal status, settle on a pause that needs
 * an external signal, or exhaust the wait budget — so callers (and the tool that
 * wraps this) never hand-roll a wait loop and can't misjudge elapsed time. Reads
 * at least once; returns the latest snapshot and why it stopped.
 *
 * Live by default: it wakes on {@link watchExecution} SSE events and refetches
 * `inspect()` on each, so it reflects live run state instead of polling on a
 * timer. On ANY SSE failure or drop it reverts to the original poll loop (×1.5
 * backoff, capped at 5s) for the remaining budget — no functional regression,
 * matching Module A's fallback invariant. Heartbeats never wake it, so the wait
 * is bounded by aborting the stream at the deadline.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) on gateway errors from
 * the `inspect()` refetch (SSE handshake errors are swallowed into the fallback).
 */
export async function waitForExecution(
  opts: WaitForExecutionOptions,
  client: GatewayClient,
): Promise<WaitForExecutionResult> {
  const maxWaitMs = opts.maxWaitMs ?? 45_000;
  const autoResume = opts.autoResumeSignals ?? AUTO_RESUME_PAUSE_SIGNALS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const watch = opts.watch ?? watchExecution;

  const deadline = now() + maxWaitMs;

  const read = () => inspect({ executionId: opts.executionId }, client);

  // Read at least once — an already-settled run resolves without waiting.
  let execution = await read();
  let settled = settledResult(execution, autoResume);
  if (settled) return { execution, ...settled };
  if (now() >= deadline) return { execution, reason: "timeout", done: false };

  // Live path: wake on SSE, refetch, re-evaluate. Bounded by aborting the stream
  // at the deadline (heartbeats are filtered, so nothing else would wake us). Any
  // SSE failure/drop falls through to the poll loop below — no regression.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - now()));
  timer.unref?.();
  const events = watch({ executionId: opts.executionId, signal: abort.signal }, client)[
    Symbol.asyncIterator
  ]();
  try {
    for (;;) {
      const next = await events.next(); // resolves on each SSE event (heartbeats filtered)
      if (next.done) break; // stream ended — drop to polling for any remaining budget
      execution = await read();
      settled = settledResult(execution, autoResume);
      if (settled) return { execution, ...settled };
      if (now() >= deadline) return { execution, reason: "timeout", done: false };
    }
    if (now() >= deadline) return { execution, reason: "timeout", done: false };
  } catch {
    // SSE unavailable / dropped — fall back to polling below.
  } finally {
    // Tear the stream down (aborts the underlying fetch) and stop the deadline
    // timer, whether we settled, timed out, or are falling back to polling.
    clearTimeout(timer);
    await events.return?.(undefined);
  }

  // Poll fallback (the pre-SSE behavior) for the remaining budget.
  let interval = opts.pollMs ?? 1_000;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return { execution, reason: "timeout", done: false };

    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval * 1.5, 5_000);

    execution = await read();
    settled = settledResult(execution, autoResume);
    if (settled) return { execution, ...settled };
  }
}

// ── List recent executions ────────────────────────────────────────────────────

/**
 * List recent executions as tree-aware {@link ExecutionRef}s (no filter — the
 * gateway decides the page size and ordering). Each ref carries its `traceRoot`
 * so callers can group runs into their dispatch trees without a second read;
 * `traceRoot` degrades to the run's own id for pre-seam rows.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function listExecutions(
  client: GatewayClient,
): Promise<ExecutionRef[]> {
  const raw = await client.get<unknown>("/executions");
  return Array.isArray(raw) ? raw.map(decodeExecutionRef) : [];
}

// ── Inspect a build ───────────────────────────────────────────────────────────

export interface InspectBuildOptions {
  definitionId: string;
  buildRunId: string;
}

export interface InspectBuildResult {
  build: BuildDetail;
}

/**
 * Fetch build status for a specific build run.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function inspectBuild(
  opts: InspectBuildOptions,
  client: GatewayClient,
): Promise<InspectBuildResult> {
  const build = await client.get<BuildDetail>(
    `/definitions/${opts.definitionId}/builds/${opts.buildRunId}`,
  );
  return { build };
}
