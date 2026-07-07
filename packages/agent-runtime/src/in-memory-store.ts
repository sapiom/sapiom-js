/**
 * In-memory ExecutionStore and SyncInProcessDispatcher for tests.
 *
 * InMemoryExecutionStore — single-writer (no concurrency), so every CAS
 * method always returns true and just bumps the version. Backed by Maps.
 *
 * SyncInProcessDispatcher — test helper that runs a step body synchronously
 * and immediately calls core.completeDispatchedStep. Wire up the step body
 * in the test before calling core.advance().
 */

import type { NextStepDirective, PauseUntilSignalDirective } from '@sapiom/agent';

import type { StepCompletionPayload } from './completion-payload.js';
import { STEP_COMPLETION_OUTCOME } from './completion-payload.js';
import type { StepDispatchRequest, StepDispatcher } from './dispatch.js';
import { parseCorrelationId } from './dispatch.js';
import { EXECUTION_STATUS, STEP_STATUS } from './execution-state.js';
import type { ExecutionState, StepRow } from './execution-state.js';
import { DEFAULT_MAX_ATTEMPTS_PER_STEP } from './runner-core.js';
import type { AgentRunnerCore } from './runner-core.js';
import type { ExecutionStore, StartExecutionArgs } from './stores.js';

// ---------------------------------------------------------------------------
// InMemoryExecutionStore
// ---------------------------------------------------------------------------

/** Mutable execution row (superset of ExecutionState). */
interface MutableExecution {
  id: string;
  name: string;
  status: ExecutionState['status'];
  version: number;
  manifest: ExecutionState['manifest'];
  input: unknown;
  currentStep: string | null;
  currentStepInput: unknown;
  currentStepAttempt: number;
  sharedState: Record<string, unknown>;
  pausedSignalName: string | null;
  pausedSignalCorrelationId: string | null;
  pausedUntil: Date | null;
  dispatchedStepRowId: string | null;
  dispatchDeadlineAt: Date | null;
  output: unknown;
  error: unknown;
  organizationId: string | null;
  tenantId: string | null;
  definitionId?: string | null;
  buildRunId?: string | null;
  scopedApiKeyId?: string | null;
}

/** Mutable step row (superset of StepRow). */
interface MutableStepRow {
  id: string;
  executionId: string;
  stepName: string;
  stepOrder: number;
  attempt: number;
  status: StepRow['status'];
  input: unknown;
  output?: unknown;
  error?: unknown;
  nextDirective?: NextStepDirective;
  sharedStateAfter?: Record<string, unknown>;
  logs?: unknown;
}

let _nextId = 1;
function newId(): string {
  return String(_nextId++);
}

export function resetIdCounter(): void {
  _nextId = 1;
}

function toReadonly(e: MutableExecution): ExecutionState {
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    version: e.version,
    manifest: e.manifest,
    input: e.input,
    currentStep: e.currentStep,
    currentStepInput: e.currentStepInput,
    currentStepAttempt: e.currentStepAttempt,
    sharedState: e.sharedState,
    pausedSignalName: e.pausedSignalName,
    pausedSignalCorrelationId: e.pausedSignalCorrelationId,
    pausedUntil: e.pausedUntil,
    dispatchedStepRowId: e.dispatchedStepRowId,
    dispatchDeadlineAt: e.dispatchDeadlineAt,
    output: e.output,
    error: e.error,
    organizationId: e.organizationId,
    tenantId: e.tenantId,
    definitionId: e.definitionId,
    buildRunId: e.buildRunId,
    scopedApiKeyId: e.scopedApiKeyId,
  };
}

function stepToReadonly(s: MutableStepRow): StepRow {
  return {
    id: s.id,
    stepName: s.stepName,
    stepOrder: s.stepOrder,
    attempt: s.attempt,
    status: s.status,
  };
}

/**
 * Single-writer in-memory store. All CAS methods return true because
 * there is no concurrent writer — a test that needs to simulate CAS loss
 * can subclass and override the relevant method.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly executions = new Map<string, MutableExecution>();
  /** Key: `${executionId}:${stepOrder}:${attempt}` */
  private readonly steps = new Map<string, MutableStepRow>();
  /** Key: stepRowId */
  private readonly stepsById = new Map<string, MutableStepRow>();
  /** Key: executionId → highest stepOrder seen */
  private readonly maxStepOrder = new Map<string, number>();

  // ── Read helpers for tests ────────────────────────────────────────────────

  getExecution(executionId: string): ExecutionState | undefined {
    const e = this.executions.get(executionId);
    return e ? toReadonly(e) : undefined;
  }

  allExecutions(): ExecutionState[] {
    return Array.from(this.executions.values()).map(toReadonly);
  }

  // ── ExecutionStore interface ───────────────────────────────────────────────

  async startExecution(args: StartExecutionArgs): Promise<string> {
    const id = newId();
    const row: MutableExecution = {
      id,
      name: args.workflowName,
      status: EXECUTION_STATUS.RUNNING,
      version: 0,
      manifest: args.manifest,
      input: args.input,
      currentStep: args.entryStep,
      currentStepInput: args.entryStepInput,
      currentStepAttempt: 0,
      sharedState: {},
      pausedSignalName: null,
      pausedSignalCorrelationId: null,
      pausedUntil: null,
      dispatchedStepRowId: null,
      dispatchDeadlineAt: null,
      output: undefined,
      error: undefined,
      organizationId: args.organizationId,
      tenantId: args.tenantId,
      definitionId: args.definitionId ?? null,
      buildRunId: args.buildRunId ?? null,
      scopedApiKeyId: args.scopedApiKeyId ?? null,
    };
    this.executions.set(id, row);
    return id;
  }

  async loadExecution(executionId: string): Promise<ExecutionState | null> {
    const e = this.executions.get(executionId);
    return e ? toReadonly(e) : null;
  }

  async prepareResume(args: { executionId: string; fromStepName: string; fromStepInput: unknown }): Promise<void> {
    const e = this.executions.get(args.executionId);
    if (!e) return;
    e.status = EXECUTION_STATUS.RUNNING;
    e.currentStep = args.fromStepName;
    e.currentStepInput = args.fromStepInput;
    e.currentStepAttempt = 0;
    e.pausedSignalName = null;
    e.pausedSignalCorrelationId = null;
    e.pausedUntil = null;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    e.error = null;
  }

  async nextStepOrder(executionId: string): Promise<number> {
    const current = this.maxStepOrder.get(executionId) ?? -1;
    const next = current + 1;
    this.maxStepOrder.set(executionId, next);
    return next;
  }

  async startStep(args: {
    executionId: string;
    stepName: string;
    stepOrder: number;
    attempt: number;
    input: unknown;
    status: 'dispatched' | 'running';
  }): Promise<string> {
    const id = newId();
    const row: MutableStepRow = {
      id,
      executionId: args.executionId,
      stepName: args.stepName,
      stepOrder: args.stepOrder,
      attempt: args.attempt,
      status: args.status,
      input: args.input,
    };
    const key = `${args.executionId}:${args.stepOrder}:${args.attempt}`;
    this.steps.set(key, row);
    this.stepsById.set(id, row);
    return id;
  }

  async findStepRow(executionId: string, stepOrder: number, attempt: number): Promise<StepRow | null> {
    const key = `${executionId}:${stepOrder}:${attempt}`;
    const s = this.steps.get(key);
    return s ? stepToReadonly(s) : null;
  }

  async findStepRowById(stepRowId: string): Promise<StepRow | null> {
    const s = this.stepsById.get(stepRowId);
    return s ? stepToReadonly(s) : null;
  }

  async completeStep(args: {
    stepRowId: string;
    output: unknown;
    nextDirective: NextStepDirective;
    sharedStateAfter: Record<string, unknown>;
    logs?: unknown;
  }): Promise<void> {
    const s = this.stepsById.get(args.stepRowId);
    if (!s) return;
    s.status = STEP_STATUS.SUCCEEDED;
    s.output = args.output;
    s.nextDirective = args.nextDirective;
    s.sharedStateAfter = args.sharedStateAfter;
    if (args.logs !== undefined) s.logs = args.logs;
  }

  async failStep(args: {
    stepRowId: string;
    error: unknown;
    sharedStateAfter: Record<string, unknown>;
    logs?: unknown;
  }): Promise<void> {
    const s = this.stepsById.get(args.stepRowId);
    if (!s) return;
    s.status = STEP_STATUS.FAILED;
    s.error = args.error;
    s.sharedStateAfter = args.sharedStateAfter;
    if (args.logs !== undefined) s.logs = args.logs;
  }

  // ── CAS transitions ────────────────────────────────────────────────────────
  // Single-writer: always return true and bump version.

  async markStepDispatched(args: {
    executionId: string;
    expectedVersion: number;
    stepRowId: string;
    deadlineAt: Date;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.dispatchedStepRowId = args.stepRowId;
    e.dispatchDeadlineAt = args.deadlineAt;
    e.version += 1;
    return true;
  }

  async transitionToStep(args: {
    executionId: string;
    expectedVersion: number;
    nextStep: string;
    nextStepInput: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.currentStep = args.nextStep;
    e.currentStepInput = args.nextStepInput;
    e.currentStepAttempt = 0;
    e.sharedState = args.sharedState;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    e.version += 1;
    return true;
  }

  async retainStepForRetry(args: {
    executionId: string;
    expectedVersion: number;
    sharedState: Record<string, unknown>;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.currentStepAttempt += 1;
    e.sharedState = args.sharedState;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    e.version += 1;
    return true;
  }

  async pauseExecution(args: {
    executionId: string;
    expectedVersion: number;
    directive: PauseUntilSignalDirective;
    sharedState: Record<string, unknown>;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.status = EXECUTION_STATUS.PAUSED;
    e.pausedSignalName = args.directive.signal.name;
    e.pausedSignalCorrelationId = args.directive.signal.correlationId ?? null;
    e.pausedUntil = args.directive.timeoutMs ? new Date(Date.now() + args.directive.timeoutMs) : null;
    e.sharedState = args.sharedState;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    if (args.directive.resumeStep) {
      e.currentStep = args.directive.resumeStep;
    }
    e.version += 1;
    return true;
  }

  async completeExecution(args: {
    executionId: string;
    expectedVersion: number;
    output: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.status = EXECUTION_STATUS.COMPLETED;
    e.output = args.output;
    e.sharedState = args.sharedState;
    e.currentStep = null;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    e.version += 1;
    return true;
  }

  async failExecution(args: {
    executionId: string;
    expectedVersion: number;
    error: unknown;
    output?: unknown;
    sharedState: Record<string, unknown>;
  }): Promise<boolean> {
    const e = this.executions.get(args.executionId);
    if (!e || e.version !== args.expectedVersion) return false;
    e.status = EXECUTION_STATUS.FAILED;
    e.error = args.error;
    if (args.output !== undefined) e.output = args.output;
    e.sharedState = args.sharedState;
    e.dispatchedStepRowId = null;
    e.dispatchDeadlineAt = null;
    e.version += 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// SyncInProcessDispatcher
// ---------------------------------------------------------------------------

/**
 * Test-only dispatcher. The test wires a step body per step name via
 * `setSyncBody(stepName, body)`. When `dispatch` is called, it runs the
 * body synchronously (within the same microtask), then immediately calls
 * `core.completeDispatchedStep` with the result so the execution advances
 * without any async gap.
 *
 * If a step body throws, the dispatcher records a THREW outcome and the
 * walker's retry path runs as it would against a real executor.
 */
export class SyncInProcessDispatcher implements StepDispatcher {
  private bodies = new Map<string, (input: unknown) => Promise<{ output: unknown; directive: NextStepDirective }>>();
  private core: AgentRunnerCore | null = null;
  /**
   * The cap the simulated completion supplies to the runner. In the real engine
   * the completion (a separate request) carries its own max, independent of the
   * value advance() was called with — so the fixture models it as its own knob.
   */
  private maxAttemptsPerStep = DEFAULT_MAX_ATTEMPTS_PER_STEP;

  setCore(core: AgentRunnerCore): void {
    this.core = core;
  }

  setMaxAttempts(max: number): void {
    this.maxAttemptsPerStep = max;
  }

  setSyncBody(
    stepName: string,
    body: (input: unknown) => Promise<{ output: unknown; directive: NextStepDirective }>,
  ): void {
    this.bodies.set(stepName, body);
  }

  async dispatch(request: StepDispatchRequest): Promise<void> {
    const body = this.bodies.get(request.stepName);
    if (!body) {
      throw new Error(`SyncInProcessDispatcher: no body registered for step '${request.stepName}'`);
    }

    const parsed = parseCorrelationId(request.correlationId);
    if (!parsed) {
      throw new Error(`SyncInProcessDispatcher: malformed correlationId '${request.correlationId}'`);
    }

    let payload: StepCompletionPayload;
    try {
      const { output, directive } = await body(request.input);
      // The wire directive type (Zod-inferred from wireDirectiveSchema) is
      // structurally identical to NextStepDirective. The cast is safe for tests.
      payload = {
        protocol: 1,
        correlationId: request.correlationId,
        outcome: STEP_COMPLETION_OUTCOME.RESULT,
        result: { output, directive: directive as never },
        shared: request.shared,
      };
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      payload = {
        protocol: 1,
        correlationId: request.correlationId,
        outcome: STEP_COMPLETION_OUTCOME.THREW,
        error: { name: e.name, message: e.message, stack: e.stack },
        shared: request.shared,
      };
    }

    // In real life, dispatch() hands work off and resolves immediately; the
    // completion arrives later via a POST. In tests, we run completion inline
    // so the entire round-trip is synchronous within one advance() call. Tests
    // should assert on store state (always current) rather than advance()'s
    // return value, which will be DISPATCHED regardless of what the completion
    // did (since dispatchOneStep returns DISPATCHED after a successful dispatch).
    if (!this.core) {
      throw new Error('SyncInProcessDispatcher: setCore() was not called');
    }
    await this.core.completeDispatchedStep(payload, parsed, this.maxAttemptsPerStep);
  }
}
