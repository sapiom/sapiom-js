import {
  CTX_SHARED_QUOTA_CONTRACT,
  CTX_SHARED_SERIALIZATION_ERROR_CONTRACT,
  CtxSharedSerializationError,
  MAX_SHARED_SNAPSHOT_BYTES as CANONICAL_MAX_SHARED_SNAPSHOT_BYTES,
  SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT,
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

  it('round-trips and normalizes the terminal ctx.shared serialization payload', () => {
    const error = {
      name: 'CtxSharedSerializationError',
      message: 'snapshot serialization failed',
      code: CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.errorCode,
      version: CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.version + 1,
      stepName: 'collect',
      phase: 'future_host_boundary',
      retryable: false,
      candidate: 'must be stripped',
    };

    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: 'CtxSharedSerializationError',
      message: 'snapshot serialization failed',
      code: 'CTX_SHARED_SERIALIZATION_FAILED',
      version: 2,
      stepName: 'collect',
      phase: 'future_host_boundary',
      retryable: false,
    });
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

    const serializationError = new CtxSharedSerializationError({
      stepName: 'collect',
      phase: 'ctx_shared_set',
    });
    expect(serializeStepCompletionError(serializationError)).toEqual(serializationError.toJSON());
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
    {
      name: 'CtxSharedSerializationError',
      message: 'wrong disposition',
      code: 'CTX_SHARED_SERIALIZATION_FAILED',
      version: 1,
      stepName: 'collect',
      phase: 'ctx_shared_set',
      retryable: true,
    },
  ])('falls back to the retryable legacy shape for unrecognized payload %#', (error) => {
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: error.name,
      message: error.message,
    });
  });
});

describe('transient Sapiom-surface call errors', () => {
  const transientError = () => {
    const error = new Error('Failed to search: 503 upstream unavailable');
    error.name = 'SearchHttpError';
    error.stack = 'SearchHttpError: boom\n    at step';
    return error;
  };

  it('serializes the canonical payload when the call recorded transient facts', () => {
    const error = transientError();

    expect(serializeStepCompletionError(error, { capability: 'web.search', status: 503, retryAfterMs: 2000 })).toEqual({
      name: 'SearchHttpError',
      message: error.message,
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
      retryable: true,
      status: 503,
      capability: 'web.search',
      retryAfterMs: 2000,
      stack: error.stack,
    });
  });

  it('leaves a deterministic failure on the legacy shape, with no disposition field', () => {
    const error = transientError();

    const payload = serializeStepCompletionError(error, { capability: 'web.search', status: 404 });

    expect(payload).toEqual({ name: 'SearchHttpError', message: error.message, stack: error.stack });
    expect(payload).not.toHaveProperty('retryable');
    expect(payload).not.toHaveProperty('code');
  });

  it('serializes exactly as before when the host passes no facts', () => {
    const error = transientError();

    expect(serializeStepCompletionError(error)).toEqual({
      name: 'SearchHttpError',
      message: error.message,
      stack: error.stack,
    });
  });

  it('keeps a terminal platform error terminal even when facts are present', () => {
    const error = new CtxSharedSerializationError({ stepName: 'collect', phase: 'ctx_shared_set' });

    expect(serializeStepCompletionError(error, { status: 503 })).toEqual(error.toJSON());
  });

  it('round-trips the payload through protocol 1, stripping extras', () => {
    const error = {
      name: 'SearchHttpError',
      message: 'Failed to search: 503 upstream unavailable',
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
      retryable: true,
      status: 503,
      capability: 'web.search',
      secret: 'must be stripped',
    };

    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: 'SearchHttpError',
      message: 'Failed to search: 503 upstream unavailable',
      code: 'SAPIOM_CALL_TRANSIENT',
      version: 1,
      retryable: true,
      status: 503,
      capability: 'web.search',
    });
  });

  it('accepts a compatible future contract version', () => {
    const error = {
      name: 'SearchHttpError',
      message: 'Failed to search: 503 upstream unavailable',
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version + 1,
      retryable: true,
      status: 503,
    };

    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual(error);
  });

  it.each([
    {
      name: 'CustomError',
      message: 'unknown code with a retryable claim',
      code: 'SOMETHING_ELSE',
      version: 1,
      retryable: true,
    },
    {
      name: 'SearchHttpError',
      message: 'out-of-range status',
      code: 'SAPIOM_CALL_TRANSIENT',
      version: 1,
      retryable: true,
      status: 42,
    },
  ])('strips an unrecognized retryable claim to the legacy shape %#', (error) => {
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual({
      name: error.name,
      message: error.message,
    });
  });
});
