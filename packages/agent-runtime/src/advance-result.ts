import type { PauseUntilSignalDirective, AgentManifest } from '@sapiom/agent';

/**
 * The `kind` of an {@link AdvanceResult} — what the runner tells its caller
 * about the workflow's overall state after one advance (distinct from a
 * step-level directive). `RUNNING` → advance again; the others → stop.
 */
export const ADVANCE_RESULT_KIND = {
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  /**
   * A step body was handed to a dispatcher (or a duplicate advance found one
   * already in flight). Stop advancing — the next transition is owned by the
   * step completion or the deadline sweep, never by another advance.
   */
  DISPATCHED: 'dispatched',
} as const;

export type AdvanceResultKind = (typeof ADVANCE_RESULT_KIND)[keyof typeof ADVANCE_RESULT_KIND];

/** The result of one advance. Callers decide what to do based on `kind`. */
export type AdvanceResult =
  | { kind: typeof ADVANCE_RESULT_KIND.RUNNING }
  | { kind: typeof ADVANCE_RESULT_KIND.PAUSED; directive: PauseUntilSignalDirective }
  | { kind: typeof ADVANCE_RESULT_KIND.COMPLETED; output: unknown }
  | { kind: typeof ADVANCE_RESULT_KIND.FAILED; error: unknown }
  | { kind: typeof ADVANCE_RESULT_KIND.DISPATCHED; deadlineAt: Date | null };

/**
 * What completing a dispatched step returns. `applied: false` is the
 * idempotent-duplicate case — an identical earlier completion already
 * finalized the attempt; `result` reflects current state either way.
 */
export interface CompleteDispatchOutcome {
  readonly applied: boolean;
  readonly result: AdvanceResult;
}

/** Options for creating a new execution. The manifest is mandatory. */
export interface CreateExecutionOptions {
  readonly organizationId?: string | null;
  readonly tenantId?: string | null;
  /** Unique key for exactly-once create semantics (optional). */
  readonly idempotencyKey?: string;
  /** Pinned manifest the execution runs against — REQUIRED. */
  readonly manifest: AgentManifest;
  readonly definitionId?: string | null;
  readonly buildRunId?: string | null;
  readonly scopedApiKeyId?: string | null;
}
