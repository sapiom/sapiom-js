import {
  CTX_SHARED_QUOTA_CONTRACT,
  MAX_SHARED_SNAPSHOT_BYTES as CANONICAL_MAX_SHARED_SNAPSHOT_BYTES,
  STEP_INPUT_VALIDATION_ERROR_CONTRACT,
  StepInputValidationError,
  ctxSharedSizeLimitExceededPayloadSchema,
} from '@sapiom/agent';

import {
  MAX_SHARED_SNAPSHOT_BYTES,
  serializeStepCompletionError,
  STEP_COMPLETION_OUTCOME,
  stepCompletionPayloadSchema,
} from './completion-payload.js';

function threwPayload(error: Record<string, unknown>) {
  return {
    protocol: 1,
    correlationId: 'execution:1:0',
    outcome: STEP_COMPLETION_OUTCOME.THREW,
    error,
  };
}

describe('step completion error compatibility', () => {
  it('re-exports the canonical @sapiom/agent quota instead of owning a literal', () => {
    expect(MAX_SHARED_SNAPSHOT_BYTES).toBe(CANONICAL_MAX_SHARED_SNAPSHOT_BYTES);
  });

  it('round-trips every canonical quota field through protocol 1', () => {
    const error = {
      name: 'CtxSharedSizeLimitExceededError',
      message: 'snapshot is too large',
      code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
      version: CTX_SHARED_QUOTA_CONTRACT.version,
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 1,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
      stepName: 'collect',
      phase: 'ctx_shared_set',
      retryable: false,
      stack: 'stack trace',
    };

    expect(ctxSharedSizeLimitExceededPayloadSchema.parse(error)).toEqual(error);
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual(error);
  });

  it('preserves structured fields from a compatible contract version with a different limit and phase', () => {
    const otherVersionLimitBytes = 100_000;
    const error = {
      name: 'CtxSharedSizeLimitExceededError',
      message: 'snapshot is too large for the reporting host',
      code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
      version: CTX_SHARED_QUOTA_CONTRACT.version + 1,
      actualBytes: otherVersionLimitBytes + 1,
      limitBytes: otherVersionLimitBytes,
      stepName: 'collect',
      phase: 'future_host_boundary',
      retryable: false,
    };

    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual(error);
  });

  it('continues to accept the legacy name/message/stack shape', () => {
    const error = {
      name: 'Error',
      message: 'ordinary failure',
      stack: 'stack trace',
    };
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual(error);
  });

  it('exports the dispatcher boundary serializer that preserves recognized platform fields', () => {
    const error = new StepInputValidationError('validate', [
      {
        code: 'custom',
        path: ['email'],
        message: 'required',
        input: undefined,
      },
    ]);

    expect(serializeStepCompletionError(error)).toEqual(error.toStepErrorPayload());

    const authorError = Object.assign(new Error('ordinary failure'), { retryable: false });
    expect(serializeStepCompletionError(authorError)).toEqual({
      name: 'Error',
      message: 'ordinary failure',
      stack: authorError.stack,
    });
  });

  it('round-trips the platform input-validation payload and strips raw issues', () => {
    const error = {
      name: 'StepInputValidationError',
      message: 'input is invalid',
      code: STEP_INPUT_VALIDATION_ERROR_CONTRACT.errorCode,
      version: STEP_INPUT_VALIDATION_ERROR_CONTRACT.version,
      stepName: 'validate',
      retryable: false,
      issues: [{ path: ['secret'], message: 'not a wire field' }],
    };

    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: 'StepInputValidationError',
      message: 'input is invalid',
      code: 'STEP_INPUT_VALIDATION_FAILED',
      version: 1,
      stepName: 'validate',
      retryable: false,
    });
  });

  it.each([
    { name: 'Error', message: 'ordinary failure', retryable: false },
    {
      name: 'CustomError',
      message: 'unknown code',
      code: 'UNKNOWN_CODE',
      version: 1,
      retryable: false,
    },
    {
      name: 'StepInputValidationError',
      message: 'wrong disposition',
      code: 'STEP_INPUT_VALIDATION_FAILED',
      version: 1,
      stepName: 'validate',
      retryable: true,
    },
  ])('falls back to the retryable legacy shape for unrecognized payload %#', (error) => {
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: error.name,
      message: error.message,
    });
  });
});
