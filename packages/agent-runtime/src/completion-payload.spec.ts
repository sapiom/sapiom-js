import {
  MAX_SHARED_SNAPSHOT_BYTES as CANONICAL_MAX_SHARED_SNAPSHOT_BYTES,
  ctxSharedSizeLimitExceededPayloadSchema,
} from '@sapiom/agent';

import {
  MAX_SHARED_SNAPSHOT_BYTES,
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

  it('continues to accept the legacy name/message/stack shape', () => {
    const error = {
      name: 'Error',
      message: 'ordinary failure',
      stack: 'stack trace',
    };
    expect(stepCompletionPayloadSchema.parse(threwPayload(error)).error).toEqual(error);
  });
});
