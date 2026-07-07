import type { AgentManifest } from '@sapiom/orchestration';

/**
 * Single source of truth for an execution's status values. (Mirrors the
 * server's persisted `workflow_executions.status` enum; the walker only ever
 * reasons over these literals, never the storage.)
 */
export const EXECUTION_STATUS = {
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

export const STEP_STATUS = {
  DISPATCHED: 'dispatched',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

/**
 * The execution state the walker reads, as plain data — the host-neutral
 * projection of whatever a host persists. A host's own record may be a
 * superset (audit/tenant/transport fields); those it carries as opaque
 * pass-throughs and the walker never reads them.
 */
export interface ExecutionState {
  readonly id: string;
  readonly name: string;
  readonly status: ExecutionStatus;
  /** Optimistic-lock token; every mutation is conditioned on it (CAS). */
  readonly version: number;
  readonly manifest: AgentManifest;
  /** The value the execution was started with (the entry step's input). */
  readonly input: unknown;
  /** The step the next advance will run; null once finished. */
  readonly currentStep: string | null;
  readonly currentStepInput: unknown;
  /** 0-based attempt counter for the current step. */
  readonly currentStepAttempt: number;
  readonly sharedState: Record<string, unknown>;
  readonly pausedSignalName: string | null;
  readonly pausedSignalCorrelationId: string | null;
  readonly pausedUntil: Date | null;
  /** Non-null exactly while a step body is dispatched and in flight. */
  readonly dispatchedStepRowId: string | null;
  readonly dispatchDeadlineAt: Date | null;
  readonly output: unknown;
  readonly error: unknown;
  readonly organizationId: string | null;
  readonly tenantId: string | null;
  // Opaque audit pass-throughs — set/read by hosts that care, ignored by the walker.
  readonly definitionId?: string | null;
  readonly buildRunId?: string | null;
  readonly scopedApiKeyId?: string | null;
}

/** A single step-attempt row, as plain data. */
export interface StepRow {
  readonly id: string;
  readonly stepName: string;
  readonly stepOrder: number;
  readonly attempt: number;
  readonly status: StepStatus;
}
