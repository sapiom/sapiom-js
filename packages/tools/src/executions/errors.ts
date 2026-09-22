import type { ExecutionErrorBody, ExecutionReference } from "./types.js";

export class ExecutionError extends Error implements ExecutionReference {
  readonly executionId?: string;
  readonly submissionKey?: string;
  constructor(message: string, reference: ExecutionReference = {}) {
    super(message);
    this.name = new.target.name;
    this.executionId = reference.executionId;
    this.submissionKey = reference.submissionKey;
  }
}
export class ExecutionProtocolError extends ExecutionError {}
export class ExecutionTransportError extends ExecutionError {}
export class ExecutionInterruptedError extends ExecutionError {}
export class ExecutionExpiredError extends ExecutionError {
  readonly status = 410;
}
export class ExecutionHttpError extends ExecutionError {
  constructor(
    readonly status: number,
    readonly body: { code?: string; message?: string },
    reference: ExecutionReference = {},
    readonly retryAfterMs?: number,
  ) {
    super(`Execution request rejected (HTTP ${status}).`, reference);
  }
}
/** SDK classification of a saved failure, not the original provider HTTP response. */
export const executionFailureStatus: Readonly<
  Record<ExecutionErrorBody["code"], number>
> = {
  invalid_request: 400,
  rate_limited: 429,
  capability_usage_limit: 429,
  deadline_exceeded: 504,
  execution_failed: 502,
  execution_indeterminate: 502,
};
export class ExecutionFailedError extends ExecutionError {
  readonly status: number;
  constructor(
    readonly body: ExecutionErrorBody,
    reference: ExecutionReference,
  ) {
    super(body.message, reference);
    this.status = executionFailureStatus[body.code];
  }
}
/** No automatic retry or resubmission: the provider outcome is unknown. */
export class ExecutionIndeterminateError extends ExecutionError {
  constructor(
    readonly body: ExecutionErrorBody,
    reference: ExecutionReference,
  ) {
    super(body.message, reference);
  }
}
