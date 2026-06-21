/**
 * Errors raised by the walker's control flow that are not part of the public
 * @sapiom/orchestration contract.
 *
 * Public errors (UnknownStepError, StepInputValidationError,
 * DisallowedTransitionError, WorkflowError) come from @sapiom/orchestration and
 * are not repeated here.
 */
import { WorkflowError } from '@sapiom/orchestration';

/** A step asked to retry more times than `maxAttemptsPerStep`. */
export class RetryLimitExceededError extends WorkflowError {
  readonly stepName: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  constructor(stepName: string, attempts: number, maxAttempts: number) {
    super(`Step '${stepName}' exceeded retry cap (attempted ${attempts} of ${maxAttempts})`);
    this.name = 'RetryLimitExceededError';
    this.stepName = stepName;
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }
}

/**
 * A step explicitly failed the workflow via the FAIL directive (vs. the
 * cap-exceeded path that produces `RetryLimitExceededError`).
 */
export class WorkflowFailedByStepError extends WorkflowError {
  readonly stepName: string;
  readonly reason: string | null;
  constructor(stepName: string, reason: string | null) {
    super(`Workflow failed by step '${stepName}' via FAIL directive${reason ? ` (reason: ${reason})` : ''}`);
    this.name = 'WorkflowFailedByStepError';
    this.stepName = stepName;
    this.reason = reason;
  }
}

/**
 * A step completion arrived for a dispatched step attempt the runner is no
 * longer waiting on.
 */
export class StaleDispatchCompletionError extends WorkflowError {
  readonly executionId: string;
  readonly correlationId: string;
  constructor(executionId: string, correlationId: string, detail: string) {
    super(`Stale step-completion for execution ${executionId} (correlation ${correlationId}): ${detail}`);
    this.name = 'StaleDispatchCompletionError';
    this.executionId = executionId;
    this.correlationId = correlationId;
  }
}

/**
 * A dispatched step attempt produced no completion by its deadline.
 */
export class DispatchDeadlineExceededError extends WorkflowError {
  readonly stepName: string;
  readonly deadlineAt: Date;
  constructor(stepName: string, deadlineAt: Date) {
    super(`Dispatched step '${stepName}' produced no completion by its deadline (${deadlineAt.toISOString()})`);
    this.name = 'DispatchDeadlineExceededError';
    this.stepName = stepName;
    this.deadlineAt = deadlineAt;
  }
}

/**
 * A paused execution's `paused_until` elapsed with no signal.
 */
export class PauseTimeoutError extends WorkflowError {
  readonly signalName: string;
  readonly pausedUntil: Date;
  constructor(signalName: string, pausedUntil: Date) {
    super(`Pause on signal '${signalName}' timed out (paused_until ${pausedUntil.toISOString()} elapsed)`);
    this.name = 'PauseTimeoutError';
    this.signalName = signalName;
    this.pausedUntil = pausedUntil;
  }
}

/** Caller invoked resume on an execution that isn't in a resumable state. */
export class NotResumableError extends WorkflowError {
  readonly executionId: string;
  readonly status: string;
  constructor(executionId: string, status: string) {
    super(`Execution ${executionId} is not resumable (status='${status}'; resumable states: paused, failed)`);
    this.name = 'NotResumableError';
    this.executionId = executionId;
    this.status = status;
  }
}
