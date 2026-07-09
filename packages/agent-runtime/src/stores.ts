import type { NextStepDirective, PauseUntilSignalDirective, AgentManifest } from '@sapiom/agent';

import type { ExecutionState, StepRow } from './execution-state.js';

export interface StartExecutionArgs {
  readonly workflowName: string;
  readonly organizationId: string | null;
  readonly tenantId: string | null;
  readonly input: unknown;
  readonly entryStep: string;
  readonly entryStepInput: unknown;
  readonly idempotencyKey?: string;
  readonly manifest: AgentManifest;
  readonly definitionId?: string | null;
  readonly buildRunId?: string | null;
  readonly scopedApiKeyId?: string | null;
}

/**
 * Persistence host for the runtime. The walker calls this; a host backs it with
 * whatever store it chooses (e.g. a database, or the in-memory map included here).
 *
 * **CAS contract (load-bearing):** every mutation past the initial insert takes
 * an `expectedVersion` and returns `Promise<boolean>` — `true` if the write
 * landed, `false` if another advance won the version race. The walker branches
 * on this. A single-writer host (local) legitimately always returns `true`.
 */
export interface ExecutionStore {
  startExecution(args: StartExecutionArgs): Promise<string>;
  loadExecution(executionId: string): Promise<ExecutionState | null>;
  prepareResume(args: { executionId: string; fromStepName: string; fromStepInput: unknown }): Promise<void>;

  nextStepOrder(executionId: string): Promise<number>;
  startStep(args: {
    executionId: string;
    stepName: string;
    stepOrder: number;
    attempt: number;
    input: unknown;
    status: 'dispatched' | 'running';
  }): Promise<string>;
  findStepRow(executionId: string, stepOrder: number, attempt: number): Promise<StepRow | null>;
  findStepRowById(stepRowId: string): Promise<StepRow | null>;
  completeStep(args: {
    stepRowId: string;
    output: unknown;
    nextDirective: NextStepDirective;
    sharedStateAfter: Record<string, unknown>;
    logs?: unknown;
  }): Promise<void>;
  failStep(args: { stepRowId: string; error: unknown; sharedStateAfter: Record<string, unknown>; logs?: unknown }): Promise<void>;

  // ── CAS transitions — boolean = "won the version race?" ──────────────────
  markStepDispatched(args: { executionId: string; expectedVersion: number; stepRowId: string; deadlineAt: Date }): Promise<boolean>;
  transitionToStep(args: {
    executionId: string;
    expectedVersion: number;
    nextStep: string;
    nextStepInput: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean>;
  retainStepForRetry(args: { executionId: string; expectedVersion: number; sharedState: Record<string, unknown> }): Promise<boolean>;
  pauseExecution(args: {
    executionId: string;
    expectedVersion: number;
    directive: PauseUntilSignalDirective;
    sharedState: Record<string, unknown>;
  }): Promise<boolean>;
  completeExecution(args: {
    executionId: string;
    expectedVersion: number;
    output: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean>;
  failExecution(args: {
    executionId: string;
    expectedVersion: number;
    error: unknown;
    output?: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface SpanSpec {
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * Optional side-channel hooks (tracing, metrics, terminal events). Every hook
 * defaults to a no-op, so a host can ignore tracing entirely or wire in its
 * own spans/metrics as it sees fit.
 */
export interface RuntimeObserver {
  withSpan<T>(span: SpanSpec, fn: () => Promise<T>): Promise<T>;
  count(metric: { name: string; attributes?: Record<string, unknown> }): void;
  onTerminal?(executionId: string, kind: 'completed' | 'failed'): Promise<void>;

  // ── Optional tracing hooks. A host that traces implements them; otherwise
  //    they are undefined and no-op via optional chaining. The walker calls
  //    them best-effort and never reads the host's tracing handles.
  /** Begin tracing the run. Called once after startExecution. */
  openRun?(args: { executionId: string; workflowName: string; tenantId: string }): Promise<void>;
  /** Begin tracing a step attempt, before dispatch. */
  openStep?(args: { executionId: string; stepName: string; stepRowId: string; tenantId: string }): Promise<void>;
  /** End tracing a step attempt when it finishes. */
  completeStep?(args: { stepRowId: string; outcome: 'success' | 'error' }): Promise<void>;
  /** End tracing the run on a terminal outcome. */
  completeRun?(args: { executionId: string; outcome: 'success' | 'error' }): Promise<void>;
}

/** A `RuntimeObserver` that does nothing — the default for hosts that don't observe. */
export const NOOP_OBSERVER: RuntimeObserver = {
  withSpan: (_span, fn) => fn(),
  count: () => {
    /* no-op */
  },
};

/**
 * Optional sink for workflow **usage analytics** — the `step.start` /
 * `step.complete` / `step.error` lifecycle events the walker emits when a
 * host provides one. Deliberately structural (just a `track` method) so the
 * runtime takes no dependency on any emitter package; `SapiomAnalytics`
 * from `@sapiom/analytics-core` satisfies it as-is.
 *
 * The walker treats the sink as enqueue-only fire-and-forget: it never
 * awaits it, and it wraps every call in try/catch, so a throwing sink
 * cannot affect an execution. Hosts that don't pass one get exactly the
 * previous behavior — not even a no-op call.
 */
export interface RuntimeAnalytics {
  track(eventType: string, data?: Record<string, unknown>): void;
}
