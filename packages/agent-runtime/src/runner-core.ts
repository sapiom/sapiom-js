/**
 * AgentRunnerCore — the host-agnostic stateful walker.
 *
 * Owns the workflow's decision loop: it advances an execution one step at a
 * time, interprets the directive each step returns, and persists progress —
 * all through the host interfaces it is constructed with (`ExecutionStore`,
 * `StepDispatcher`, and an optional `RuntimeObserver`). It performs no I/O of
 * its own, so the same loop runs anywhere a host supplies those interfaces.
 */

import {
  StepInputValidationError,
  UnknownStepError,
  isContinue,
  isFail,
  isPause,
  isRetry,
  isTerminate,
} from '@sapiom/agent';
import type { NextStepDirective, AgentManifest } from '@sapiom/agent';

import { ADVANCE_RESULT_KIND } from './advance-result.js';
import type { AdvanceResult, CompleteDispatchOutcome, CreateExecutionOptions } from './advance-result.js';
import { STEP_COMPLETION_OUTCOME } from './completion-payload.js';
import type { StepCompletionPayload } from './completion-payload.js';
import { buildCorrelationId } from './dispatch.js';
import type { StepDispatcher } from './dispatch.js';
import { EXECUTION_STATUS, STEP_STATUS } from './execution-state.js';
import type { ExecutionState } from './execution-state.js';
import {
  DispatchDeadlineExceededError,
  NotResumableError,
  PauseTimeoutError,
  RetryLimitExceededError,
  StaleDispatchCompletionError,
  AgentFailedByStepError,
} from './errors.js';
import { validateManifestStepInput } from './manifest-validation.js';
import { outcomeForFinishedRow } from './outcome.js';
import { NOOP_OBSERVER } from './stores.js';
import type { ExecutionStore, RuntimeAnalytics, RuntimeObserver } from './stores.js';
import { validateDirective } from './validate-directive.js';

export const DEFAULT_MAX_ATTEMPTS_PER_STEP = 3;

/**
 * Upper bound on remembered step-start times (for `duration_ms` on the
 * analytics events). Completions normally drain the map; the cap only
 * matters for a long-lived analytics-enabled host whose completions land in
 * a different process, where entries would otherwise accumulate forever.
 */
const MAX_TRACKED_STEP_STARTS = 10_000;

/**
 * Extended observer interface with optional Core transaction spine hooks.
 * These will be added to RuntimeObserver in stores.ts (see NOTES.md).
 * The walker calls them via optional chaining so hosts that don't implement
 * them silently skip. All are best-effort — wrapped in try/catch, never thrown.
 */
interface ObserverWithSpine extends RuntimeObserver {
  /** Open the run's spine root. Called once after startExecution. */
  openRun?(args: { executionId: string; workflowName: string; tenantId: string }): Promise<void>;
  /** Open a step's spine leg. Called once per step attempt, before dispatch. */
  openStep?(args: { executionId: string; stepName: string; stepRowId: string; tenantId: string }): Promise<void>;
  /** Complete a step's spine leg (success or error). */
  completeStep?(args: { stepRowId: string; outcome: 'success' | 'error' }): Promise<void>;
  /** Complete the run's spine root on COMPLETED or FAILED terminal. */
  completeRun?(args: { executionId: string; outcome: 'success' | 'error' }): Promise<void>;
}

/**
 * Default deadline for one dispatched step attempt. Generous enough for an
 * ordinary remote step body; a step that legitimately needs longer declares
 * `timeoutMs`. Long-running work should be expressed as launch-detached +
 * PAUSE_UNTIL_SIGNAL.
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The host-agnostic workflow walker.
 *
 * Owns three caller-agnostic operations:
 *   - `createExecution`        — INSERT a new execution row.
 *   - `advance(executionId)`   — execute exactly one step.
 *   - `resetForResume`         — reset an execution to re-run from a step.
 *   - `completeDispatchedStep` — apply a dispatched step's result.
 *   - `expireDispatchedStep`   — convert a blown deadline into a failed attempt.
 *   - `expirePausedExecution`  — finalize a timed-out paused execution.
 *
 * No chaining, no queue knowledge, no loop — those belong to the caller.
 */
export class AgentRunnerCore {
  // Cast to ObserverWithSpine so the spine hooks are reachable via optional
  // chaining. The hooks are added to RuntimeObserver in stores.ts per NOTES.md;
  // until that patch lands, the cast is the compile-time bridge.
  private readonly obs: ObserverWithSpine;

  /** stepRowId → Date.now() at dispatch, so finish events can carry `duration_ms`. */
  private readonly stepStartedAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: ExecutionStore;
      dispatcher: StepDispatcher;
      observer?: RuntimeObserver;
      /**
       * Optional usage-analytics sink for `step.start` / `step.complete` /
       * `step.error` events (see {@link RuntimeAnalytics}). Absent → no
       * events, identical behavior to before the option existed.
       */
      analytics?: RuntimeAnalytics;
    },
  ) {
    this.obs = (deps.observer ?? NOOP_OBSERVER) as ObserverWithSpine;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * INSERT a fresh execution row. Returns the executionId. Does NOT drive
   * the workflow forward.
   *
   * Requires a manifest. Entry-input validation is AJV against the manifest's
   * entry step inputSchema — no customer code runs in the walker.
   */
  async createExecution(
    workflowName: string,
    entry: string,
    input: unknown,
    opts: CreateExecutionOptions,
  ): Promise<string> {
    const { manifest } = opts;

    const entryStepManifest = manifest.steps[entry];
    if (entryStepManifest?.inputSchema) {
      validateManifestStepInput(entry, entryStepManifest.inputSchema, input);
    }

    const executionId = await this.deps.store.startExecution({
      workflowName,
      organizationId: opts.organizationId ?? null,
      tenantId: opts.tenantId ?? null,
      input,
      entryStep: entry,
      entryStepInput: input,
      idempotencyKey: opts.idempotencyKey,
      manifest,
      definitionId: opts.definitionId ?? null,
      buildRunId: opts.buildRunId ?? null,
      scopedApiKeyId: opts.scopedApiKeyId ?? null,
    });

    // Open the run's Core transaction spine — best-effort observer hook.
    await this.openRunTransaction(executionId, workflowName, opts.tenantId ?? null);
    return executionId;
  }

  /**
   * Reset an existing execution so the next `advance` re-runs from a
   * specific step. Accepts paused or failed executions; refuses running
   * and completed/cancelled.
   */
  async resetForResume(
    executionId: string,
    opts: { fromStepName?: string; fromStepInput?: unknown } = {},
  ): Promise<void> {
    const row = await this.deps.store.loadExecution(executionId);
    if (!row) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    if (row.status !== EXECUTION_STATUS.PAUSED && row.status !== EXECUTION_STATUS.FAILED) {
      throw new NotResumableError(executionId, row.status);
    }

    const manifest = row.manifest;
    const fromStep = opts.fromStepName ?? row.currentStep ?? manifest.entry;
    if (!manifest.steps[fromStep]) {
      throw new UnknownStepError(fromStep);
    }
    const fromInput = opts.fromStepInput !== undefined ? opts.fromStepInput : row.currentStepInput;

    await this.deps.store.prepareResume({
      executionId,
      fromStepName: fromStep,
      fromStepInput: fromInput,
    });
  }

  /**
   * The primitive: advance by exactly one step.
   *
   * Loads the row, dispatches one step, persists the step row + new execution
   * state via CAS, returns the AdvanceResult.
   */
  async advance(
    executionId: string,
    maxAttemptsPerStep: number = DEFAULT_MAX_ATTEMPTS_PER_STEP,
  ): Promise<AdvanceResult> {
    const row = await this.deps.store.loadExecution(executionId);
    if (!row) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    return this.advanceBody(row, maxAttemptsPerStep);
  }

  /**
   * Apply a dispatched step's result — the completion half of the dispatch
   * split. The other side of `dispatchOneStep`: everything after the step body
   * has run, fed by the step's completion payload.
   */
  async completeDispatchedStep(
    payload: StepCompletionPayload,
    parsed: { executionId: string; stepOrder: number; attempt: number },
    maxAttemptsPerStep: number = DEFAULT_MAX_ATTEMPTS_PER_STEP,
  ): Promise<CompleteDispatchOutcome> {
    const row = await this.deps.store.loadExecution(parsed.executionId);
    if (!row) {
      throw new StaleDispatchCompletionError(parsed.executionId, payload.correlationId, 'execution not found');
    }
    const stepRow = await this.deps.store.findStepRow(parsed.executionId, parsed.stepOrder, parsed.attempt);
    if (!stepRow) {
      throw new StaleDispatchCompletionError(parsed.executionId, payload.correlationId, 'unknown step attempt');
    }

    if (stepRow.status !== STEP_STATUS.DISPATCHED) {
      if (stepRow.status === STEP_STATUS.SUCCEEDED) {
        return { applied: false, result: outcomeForFinishedRow(row) };
      }
      throw new StaleDispatchCompletionError(
        parsed.executionId,
        payload.correlationId,
        `attempt already finalized as '${stepRow.status}' (expired or superseded)`,
      );
    }

    if (row.status !== EXECUTION_STATUS.RUNNING || row.dispatchedStepRowId !== stepRow.id) {
      throw new StaleDispatchCompletionError(
        parsed.executionId,
        payload.correlationId,
        'execution is no longer waiting on this attempt',
      );
    }

    const sharedSnapshot = payload.shared ?? row.sharedState ?? {};

    let result: AdvanceResult;
    if (payload.outcome === STEP_COMPLETION_OUTCOME.THREW) {
      const err = rehydrateRemoteError(payload.error);
      await this.deps.store.failStep({
        stepRowId: stepRow.id,
        error: err,
        sharedStateAfter: sharedSnapshot,
        logs: payload.logs,
      });
      // Complete the step's Core spine leg — best-effort.
      await this.completeObserverStepTransaction(stepRow.id, 'error');
      this.trackStepFinish({
        executionId: row.id,
        workflowName: row.name,
        stepName: stepRow.stepName,
        stepRowId: stepRow.id,
        attempt: stepRow.attempt,
        outcome: 'error',
        errorName: err.name,
      });
      result = await this.handleRetryOrCap(row, stepRow.stepName, sharedSnapshot, maxAttemptsPerStep);
    } else {
      const stepResult = {
        output: payload.result?.output,
        next: payload.result?.directive as NextStepDirective,
      };

      // Trust-boundary enforcement: validate the directive against THIS step's
      // declared transitions in the pinned manifest.
      const violation = validateDirective(row.manifest, stepRow.stepName, stepResult.next);
      if (violation) {
        await this.deps.store.failStep({
          stepRowId: stepRow.id,
          error: violation,
          sharedStateAfter: sharedSnapshot,
          logs: payload.logs,
        });
        await this.completeObserverStepTransaction(stepRow.id, 'error');
        this.trackStepFinish({
          executionId: row.id,
          workflowName: row.name,
          stepName: stepRow.stepName,
          stepRowId: stepRow.id,
          attempt: stepRow.attempt,
          outcome: 'error',
          errorName: errorNameOf(violation),
        });
        const won = await this.deps.store.failExecution({
          executionId: row.id,
          expectedVersion: row.version,
          error: violation,
          sharedState: sharedSnapshot,
        });
        if (!won) {
          this.recordCasLoss('manifest_transition_fail', row.id, row.version);
        }
        result = { kind: ADVANCE_RESULT_KIND.FAILED, error: violation };
        await this.recordTerminalOutcome(row, result);
        return { applied: true, result };
      }

      await this.deps.store.completeStep({
        stepRowId: stepRow.id,
        output: stepResult.output,
        nextDirective: stepResult.next,
        sharedStateAfter: sharedSnapshot,
        logs: payload.logs,
      });
      await this.completeObserverStepTransaction(stepRow.id, 'success');
      this.trackStepFinish({
        executionId: row.id,
        workflowName: row.name,
        stepName: stepRow.stepName,
        stepRowId: stepRow.id,
        attempt: stepRow.attempt,
        outcome: 'success',
      });
      result = await this.applyDirective(row, stepResult, sharedSnapshot, maxAttemptsPerStep);
    }

    await this.recordTerminalOutcome(row, result);
    return { applied: true, result };
  }

  /**
   * Convert a blown dispatch deadline into a failed attempt.
   * Called by the sweep processor; returns null on benign races.
   */
  async expireDispatchedStep(
    executionId: string,
    maxAttemptsPerStep: number = DEFAULT_MAX_ATTEMPTS_PER_STEP,
  ): Promise<AdvanceResult | null> {
    const row = await this.deps.store.loadExecution(executionId);
    if (
      !row ||
      row.status !== EXECUTION_STATUS.RUNNING ||
      row.dispatchedStepRowId == null ||
      row.dispatchDeadlineAt == null ||
      row.dispatchDeadlineAt.getTime() > Date.now()
    ) {
      return null;
    }

    const stepRow = await this.deps.store.findStepRowById(row.dispatchedStepRowId);
    const stepName = stepRow?.stepName ?? row.currentStep ?? '(unknown step)';
    const err = new DispatchDeadlineExceededError(stepName, row.dispatchDeadlineAt);

    if (stepRow && stepRow.status === STEP_STATUS.DISPATCHED) {
      await this.deps.store.failStep({
        stepRowId: stepRow.id,
        error: err,
        sharedStateAfter: row.sharedState ?? {},
      });
      await this.completeObserverStepTransaction(stepRow.id, 'error');
      this.trackStepFinish({
        executionId: row.id,
        workflowName: row.name,
        stepName,
        stepRowId: stepRow.id,
        attempt: stepRow.attempt,
        outcome: 'error',
        errorName: err.name,
      });
    }

    const result = await this.handleRetryOrCap(row, stepName, row.sharedState ?? {}, maxAttemptsPerStep);
    await this.recordTerminalOutcome(row, result);
    return result;
  }

  /**
   * Finalize a paused execution whose `paused_until` elapsed with no signal.
   * Called by the sweep processor; null on benign races.
   */
  async expirePausedExecution(executionId: string): Promise<AdvanceResult | null> {
    const row = await this.deps.store.loadExecution(executionId);
    if (!row || row.status !== EXECUTION_STATUS.PAUSED || !row.pausedUntil || row.pausedUntil.getTime() > Date.now()) {
      return null;
    }
    const err = new PauseTimeoutError(row.pausedSignalName ?? '(unknown signal)', row.pausedUntil);
    const won = await this.deps.store.failExecution({
      executionId,
      expectedVersion: row.version,
      error: err,
      sharedState: row.sharedState ?? {},
    });
    if (!won) {
      this.recordCasLoss('pause_timeout', executionId, row.version);
      return null;
    }
    const result: AdvanceResult = { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
    await this.recordTerminalOutcome(row, result);
    return result;
  }

  // ── Private: advance body ──────────────────────────────────────────────────

  private async advanceBody(row: ExecutionState, maxAttemptsPerStep: number): Promise<AdvanceResult> {
    if (row.status !== EXECUTION_STATUS.RUNNING) {
      // Duplicate advance after the execution already paused/completed/failed.
      // Silent no-op; return the existing terminal state.
      return outcomeForFinishedRow(row);
    }

    const result = await this.advanceRunning(row, maxAttemptsPerStep);
    await this.recordTerminalOutcome(row, result);
    return result;
  }

  /**
   * Single choke point for a terminal transition's bookkeeping: complete the
   * run's Core transaction spine and emit the terminal-execution counter.
   */
  private async recordTerminalOutcome(row: ExecutionState, result: AdvanceResult): Promise<void> {
    if (result.kind !== ADVANCE_RESULT_KIND.COMPLETED && result.kind !== ADVANCE_RESULT_KIND.FAILED) {
      return;
    }
    await this.completeRunTransaction(row, result.kind);
    this.obs.count({
      name: 'workflow.execution.terminal',
      attributes: { 'workflow.name': row.name, outcome: result.kind },
    });
  }

  /**
   * The RUNNING-path body: validate the current step pointer, enforce the
   * retry cap, and dispatch one step.
   */
  private async advanceRunning(row: ExecutionState, maxAttemptsPerStep: number): Promise<AdvanceResult> {
    const executionId = row.id;

    if (!row.currentStep) {
      throw new Error(`Execution ${executionId} status=running but current_step is null`);
    }

    // Dispatch already in flight: a duplicate advance must NOT re-dispatch.
    if (row.dispatchedStepRowId != null) {
      return { kind: ADVANCE_RESULT_KIND.DISPATCHED, deadlineAt: row.dispatchDeadlineAt };
    }

    // Denominator for the CAS-conflict retry rate.
    this.obs.count({
      name: 'workflow.advance.total',
      attributes: { 'workflow.name': row.name },
    });

    const manifest = row.manifest;
    const currentStep = row.currentStep;

    const stepManifest = manifest.steps[currentStep];
    if (!stepManifest) {
      const err = new UnknownStepError(currentStep);
      await this.deps.store.failExecution({
        executionId,
        expectedVersion: row.version,
        error: err,
        sharedState: row.sharedState ?? {},
      });
      return { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
    }

    if (row.currentStepAttempt >= maxAttemptsPerStep) {
      const err = new RetryLimitExceededError(currentStep, row.currentStepAttempt, maxAttemptsPerStep);
      await this.deps.store.failExecution({
        executionId,
        expectedVersion: row.version,
        error: err,
        sharedState: row.sharedState ?? {},
      });
      return { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
    }

    return this.dispatchOneStep(row, manifest, stepManifest, maxAttemptsPerStep);
  }

  /**
   * Dispatch one step to the executor. Reads `timeoutMs` and `inputSchema`
   * from the manifest step. No customer code runs in the walker.
   *
   * Sequence — each ordering is load-bearing:
   *   1. INSERT the attempt row (status='dispatched').
   *   2. Open the step's Core spine leg (best-effort observer hook).
   *   3. Validate input against the manifest schema. Terminal on failure.
   *   4. CAS the dispatch-in-flight marker.
   *   5. dispatcher.dispatch(). A throw → retry path.
   */
  private async dispatchOneStep(
    row: ExecutionState,
    manifest: AgentManifest,
    stepManifest: AgentManifest['steps'][string],
    maxAttemptsPerStep: number,
  ): Promise<AdvanceResult> {
    const executionId = row.id;
    const stepName = row.currentStep as string;

    return this.obs.withSpan(
      {
        name: 'workflow.step.dispatch',
        attributes: {
          'workflow.name': row.name,
          'workflow.step': stepName,
          'workflow.execution_id': executionId,
          'workflow.attempt': row.currentStepAttempt,
          'workflow.manifest_driven': true,
        },
      },
      async () => {
        const stepOrder = await this.deps.store.nextStepOrder(executionId);

        const stepRowId = await this.deps.store.startStep({
          executionId,
          stepName,
          stepOrder,
          attempt: row.currentStepAttempt,
          input: row.currentStepInput,
          status: STEP_STATUS.DISPATCHED,
        });

        this.trackStepStart(row, stepName, stepRowId);

        // Open the step's Core spine leg — best-effort observer hook.
        await this.openObserverStepTransaction(row, stepName, stepRowId);

        // AJV pre-gate: validate the step input against the manifest schema.
        // Terminal on bad input — deterministic, retrying wastes the cap budget.
        try {
          validateManifestStepInput(stepName, stepManifest.inputSchema, row.currentStepInput);
        } catch (err) {
          if (err instanceof StepInputValidationError) {
            const sharedSnapshot = row.sharedState ?? {};
            await this.deps.store.failStep({ stepRowId, error: err, sharedStateAfter: sharedSnapshot });
            const won = await this.deps.store.failExecution({
              executionId,
              expectedVersion: row.version,
              error: err,
              sharedState: sharedSnapshot,
            });
            if (!won) {
              this.recordCasLoss('dispatch_input_validation_fail', executionId, row.version);
            }
            await this.completeObserverStepTransaction(stepRowId, 'error');
            this.trackStepFinish({
              executionId,
              workflowName: row.name,
              stepName,
              stepRowId,
              attempt: row.currentStepAttempt,
              outcome: 'error',
              errorName: err.name,
            });
            return { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
          }
          throw err;
        }

        const deadlineAt = new Date(Date.now() + (stepManifest.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS));
        const won = await this.deps.store.markStepDispatched({
          executionId,
          expectedVersion: row.version,
          stepRowId,
          deadlineAt,
        });
        if (!won) {
          this.recordCasLoss('dispatch_mark', executionId, row.version);
          const err = new Error('Dispatch superseded by a concurrent advance (lost CAS before dispatching)');
          await this.deps.store.failStep({ stepRowId, error: err, sharedStateAfter: row.sharedState ?? {} });
          await this.completeObserverStepTransaction(stepRowId, 'error');
          this.trackStepFinish({
            executionId,
            workflowName: row.name,
            stepName,
            stepRowId,
            attempt: row.currentStepAttempt,
            outcome: 'error',
            errorName: 'DispatchSuperseded',
          });
          return { kind: ADVANCE_RESULT_KIND.RUNNING };
        }

        try {
          await this.deps.dispatcher.dispatch({
            executionId,
            workflowName: row.name,
            stepName,
            stepOrder,
            attempt: row.currentStepAttempt,
            stepRowId,
            input: row.currentStepInput,
            workflowInput: row.input,
            shared: row.sharedState ?? {},
            deadlineAt,
            organizationId: row.organizationId,
            tenantId: row.tenantId,
            correlationId: buildCorrelationId(executionId, stepOrder, row.currentStepAttempt),
            artifactEntryFile: manifest.artifact.entryFile,
          });
        } catch (err) {
          await this.deps.store.failStep({ stepRowId, error: err, sharedStateAfter: row.sharedState ?? {} });
          await this.completeObserverStepTransaction(stepRowId, 'error');
          this.trackStepFinish({
            executionId,
            workflowName: row.name,
            stepName,
            stepRowId,
            attempt: row.currentStepAttempt,
            outcome: 'error',
            errorName: errorNameOf(err),
          });
          // After markStepDispatched won, the version was bumped +1.
          const postMarkRow = { ...row, version: row.version + 1 } as ExecutionState;
          return this.handleRetryOrCap(postMarkRow, stepName, row.sharedState ?? {}, maxAttemptsPerStep);
        }

        return { kind: ADVANCE_RESULT_KIND.DISPATCHED, deadlineAt };
      },
    );
  }

  /**
   * Shared retry path for both the RETRY directive and thrown exceptions.
   */
  private async handleRetryOrCap(
    row: ExecutionState,
    stepName: string,
    sharedSnapshot: Record<string, unknown>,
    maxAttemptsPerStep: number,
  ): Promise<AdvanceResult> {
    const nextAttempt = row.currentStepAttempt + 1;
    if (nextAttempt >= maxAttemptsPerStep) {
      const err = new RetryLimitExceededError(stepName, nextAttempt, maxAttemptsPerStep);
      const won = await this.deps.store.failExecution({
        executionId: row.id,
        expectedVersion: row.version,
        error: err,
        sharedState: sharedSnapshot,
      });
      if (!won) {
        this.recordCasLoss('cap_exceeded_fail', row.id, row.version);
      }
      return { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
    }
    const won = await this.deps.store.retainStepForRetry({
      executionId: row.id,
      expectedVersion: row.version,
      sharedState: sharedSnapshot,
    });
    if (!won) {
      this.recordCasLoss('retry', row.id, row.version);
    }
    return { kind: ADVANCE_RESULT_KIND.RUNNING };
  }

  private async applyDirective(
    row: ExecutionState,
    result: { output: unknown; next: NextStepDirective },
    sharedSnapshot: Record<string, unknown>,
    maxAttemptsPerStep: number,
  ): Promise<AdvanceResult> {
    const directive: NextStepDirective = result.next;

    if (isContinue(directive)) {
      const nextInput = directive.input !== undefined ? directive.input : result.output;
      const won = await this.deps.store.transitionToStep({
        executionId: row.id,
        expectedVersion: row.version,
        nextStep: directive.stepName,
        nextStepInput: nextInput,
        sharedState: sharedSnapshot,
      });
      if (!won) {
        this.recordCasLoss('transition', row.id, row.version);
      }
      return { kind: ADVANCE_RESULT_KIND.RUNNING };
    }

    if (isRetry(directive)) {
      if (directive.delayMs) await sleep(directive.delayMs);
      return this.handleRetryOrCap(row, row.currentStep as string, sharedSnapshot, maxAttemptsPerStep);
    }

    if (isPause(directive)) {
      const won = await this.deps.store.pauseExecution({
        executionId: row.id,
        expectedVersion: row.version,
        directive,
        sharedState: sharedSnapshot,
      });
      if (!won) {
        this.recordCasLoss('pause', row.id, row.version);
      }
      return { kind: ADVANCE_RESULT_KIND.PAUSED, directive };
    }

    if (isTerminate(directive)) {
      const won = await this.deps.store.completeExecution({
        executionId: row.id,
        expectedVersion: row.version,
        output: result.output,
        sharedState: sharedSnapshot,
      });
      if (!won) {
        this.recordCasLoss('terminate', row.id, row.version);
      }
      return { kind: ADVANCE_RESULT_KIND.COMPLETED, output: result.output };
    }

    if (isFail(directive)) {
      const stepName = row.currentStep ?? '(unknown step)';
      const err = new AgentFailedByStepError(stepName, directive.reason ?? null);
      const won = await this.deps.store.failExecution({
        executionId: row.id,
        expectedVersion: row.version,
        error: err,
        output: result.output,
        sharedState: sharedSnapshot,
      });
      if (!won) {
        this.recordCasLoss('fail', row.id, row.version);
      }
      return { kind: ADVANCE_RESULT_KIND.FAILED, error: err };
    }

    // Exhaustiveness check.
    const exhaustive: never = directive;
    throw new Error(`Unknown directive kind: ${JSON.stringify(exhaustive)}`);
  }

  /**
   * A CAS write lost the version race — another advance got there first.
   * Emits a metric and silently yields (the winner is making progress).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private recordCasLoss(operation: string, _executionId: string, _expectedVersion: number): void {
    this.obs.count({
      name: 'workflow.cas_conflict',
      attributes: { operation },
    });
  }

  // ── Optional tracing hooks ────────────────────────────────────────────────
  //
  // Routed through the optional RuntimeObserver hooks. A host that wants
  // tracing implements them; otherwise they are undefined and do nothing.
  // Every call is best-effort (wrapped in try/catch) — a tracing failure
  // must never fail the walker's control flow.

  private async openRunTransaction(executionId: string, workflowName: string, tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    try {
      await this.obs.openRun?.({ executionId, workflowName, tenantId });
    } catch {
      // Best-effort — run continues unrecorded.
    }
  }

  private async openObserverStepTransaction(
    row: ExecutionState,
    stepName: string,
    stepRowId: string,
  ): Promise<void> {
    if (!row.tenantId) return;
    try {
      await this.obs.openStep?.({ executionId: row.id, stepName, stepRowId, tenantId: row.tenantId });
    } catch {
      // Best-effort — step continues unrecorded.
    }
  }

  private async completeObserverStepTransaction(
    stepRowId: string,
    outcome: 'success' | 'error',
  ): Promise<void> {
    try {
      await this.obs.completeStep?.({ stepRowId, outcome });
    } catch {
      // Best-effort.
    }
  }

  private async completeRunTransaction(
    row: ExecutionState,
    kind: typeof ADVANCE_RESULT_KIND.COMPLETED | typeof ADVANCE_RESULT_KIND.FAILED,
  ): Promise<void> {
    const outcome = kind === ADVANCE_RESULT_KIND.COMPLETED ? 'success' : 'error';
    try {
      await this.obs.completeRun?.({ executionId: row.id, outcome });
    } catch {
      // Best-effort.
    }
  }

  // ── Optional usage analytics ──────────────────────────────────────────────
  //
  // Step lifecycle events (`step.start` / `step.complete` / `step.error`)
  // emitted through the host-provided `analytics` sink. This is usage
  // analytics (workflow authoring visibility), not tracing — the
  // RuntimeObserver spine hooks above remain the tracing channel. Emission is
  // synchronous enqueue-only (never awaited) and every call is guarded, so
  // analytics can never affect the walker's control flow. Payloads carry
  // metadata only: names, ids, attempt counts, durations — never step inputs,
  // outputs, or error messages.

  /** Emit `step.start` and remember the attempt's start time for `duration_ms`. */
  private trackStepStart(row: ExecutionState, stepName: string, stepRowId: string): void {
    const analytics = this.deps.analytics;
    if (!analytics) return;
    try {
      if (this.stepStartedAt.size >= MAX_TRACKED_STEP_STARTS) {
        const oldest = this.stepStartedAt.keys().next().value;
        if (oldest !== undefined) this.stepStartedAt.delete(oldest);
      }
      this.stepStartedAt.set(stepRowId, Date.now());
      analytics.track('step.start', {
        workflow_name: row.name,
        step: stepName,
        execution_id: row.id,
        attempt: row.currentStepAttempt,
      });
    } catch {
      // Never let telemetry break the walker.
    }
  }

  /**
   * Emit `step.complete` or `step.error` for a finished step attempt.
   * `duration_ms` is included when this process saw the attempt start.
   */
  private trackStepFinish(args: {
    executionId: string;
    workflowName: string;
    stepName: string;
    stepRowId: string;
    attempt: number;
    outcome: 'success' | 'error';
    errorName?: string;
  }): void {
    const analytics = this.deps.analytics;
    if (!analytics) return;
    try {
      const startedAt = this.stepStartedAt.get(args.stepRowId);
      if (startedAt !== undefined) this.stepStartedAt.delete(args.stepRowId);
      analytics.track(args.outcome === 'success' ? 'step.complete' : 'step.error', {
        workflow_name: args.workflowName,
        step: args.stepName,
        execution_id: args.executionId,
        attempt: args.attempt,
        ...(startedAt !== undefined ? { duration_ms: Date.now() - startedAt } : {}),
        ...(args.outcome === 'error' && args.errorName ? { error_name: args.errorName } : {}),
      });
    } catch {
      // Never let telemetry break the walker.
    }
  }
}

// ── Module-scope helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error class name for analytics payloads (names only — never messages). */
function errorNameOf(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/**
 * Rebuild a real Error from a remote throw's serialized form so the store's
 * error serializer preserves the executor-side name/message/stack.
 */
function rehydrateRemoteError(error: { name: string; message: string; stack?: string } | undefined): Error {
  const err = new Error(error?.message ?? 'Dispatched step threw without error detail');
  err.name = error?.name ?? 'RemoteStepError';
  if (error?.stack) {
    err.stack = error.stack;
  }
  return err;
}

