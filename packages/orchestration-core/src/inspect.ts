/**
 * inspect / logs — fetch execution details, step records, or build status.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 * The function named `inspect` (vs `logs`) makes the intent clear for
 * programmatic consumers; the CLI alias these as "logs" on its command surface.
 */
import { GatewayClient } from "./client.js";

export interface StepRecord {
  stepName: string;
  attempt: number;
  status: string;
  error?: { message?: string; stack?: string } | null;
}

export interface ExecutionDetail {
  id: string;
  status: string;
  currentStep?: string | null;
  pausedSignalName?: string | null;
  error?: unknown;
  steps?: StepRecord[];
}

export interface BuildDetail {
  id?: string;
  status: string;
  error?: unknown;
}

// ── Inspect an execution ──────────────────────────────────────────────────────

export interface InspectOptions {
  executionId: string;
}

export interface InspectResult {
  execution: ExecutionDetail;
}

/**
 * Fetch full detail for a single execution, including its step records.
 *
 * Throws `OrchestrationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function inspect(
  opts: InspectOptions,
  client: GatewayClient,
): Promise<InspectResult> {
  const execution = await client.get<ExecutionDetail>(
    `/executions/${opts.executionId}`,
  );
  return { execution };
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
  "agent.coding.result",
  "contentGeneration.video.result",
];

export type WaitStopReason = "terminal" | "needs-signal" | "timeout";

export interface WaitForExecutionOptions {
  executionId: string;
  /** Max wall-clock to poll before returning the latest snapshot. Default 45_000. */
  maxWaitMs?: number;
  /** First poll interval; backs off (×1.5, capped at 5s) between reads. Default 1_000. */
  pollMs?: number;
  /** Paused signals that auto-resume — keep waiting through them rather than returning. */
  autoResumeSignals?: string[];
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitForExecutionResult {
  execution: ExecutionDetail;
  /** Why polling stopped. */
  reason: WaitStopReason;
  /** True only when the execution reached a terminal status. */
  done: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an execution until it reaches a terminal status, settles on a pause that
 * needs an external signal, or the wait budget elapses — so callers (and the
 * tool that wraps this) never hand-roll a sleep loop and can't misjudge elapsed
 * time. Reads at least once; returns the latest snapshot and why it stopped.
 *
 * Throws `OrchestrationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function waitForExecution(
  opts: WaitForExecutionOptions,
  client: GatewayClient,
): Promise<WaitForExecutionResult> {
  const maxWaitMs = opts.maxWaitMs ?? 45_000;
  const autoResume = opts.autoResumeSignals ?? AUTO_RESUME_PAUSE_SIGNALS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + maxWaitMs;
  let interval = opts.pollMs ?? 1_000;

  for (;;) {
    const { execution } = await inspect(
      { executionId: opts.executionId },
      client,
    );

    if (isExecutionTerminal(execution.status)) {
      return { execution, reason: "terminal", done: true };
    }
    if (execution.status === "paused") {
      const signal = execution.pausedSignalName ?? null;
      if (!signal || !autoResume.includes(signal)) {
        // Won't progress on its own — an external signal is required.
        return { execution, reason: "needs-signal", done: false };
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) return { execution, reason: "timeout", done: false };

    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval * 1.5, 5_000);
  }
}

// ── List recent executions ────────────────────────────────────────────────────

export interface ListExecutionsResult {
  executions: ExecutionDetail[];
}

/**
 * List recent executions (no filter — the gateway decides the page size and
 * ordering). Callers can pass a definitionId in opts if the gateway supports it.
 */
export async function listExecutions(
  client: GatewayClient,
): Promise<ListExecutionsResult> {
  const executions = await client.get<ExecutionDetail[]>("/executions");
  return { executions };
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
 * Throws `OrchestrationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
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
