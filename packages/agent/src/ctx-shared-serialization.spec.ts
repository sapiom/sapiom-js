import {
  CTX_SHARED_SERIALIZATION_ERROR_CONTRACT,
  CtxSharedSerializationError,
  ctxSharedSerializationErrorPayloadSchema,
  isCtxSharedSerializationErrorPayload,
} from './index.js';
import type { CtxSharedSerializationPhase } from './index.js';

describe('ctx.shared serialization error contract', () => {
  const phases: readonly CtxSharedSerializationPhase[] = ['ctx_shared_set', 'step_completion', 'step_dispatch'];

  it('is frozen and publishes the stable terminal disposition', () => {
    expect(Object.isFrozen(CTX_SHARED_SERIALIZATION_ERROR_CONTRACT)).toBe(true);
    expect(CTX_SHARED_SERIALIZATION_ERROR_CONTRACT).toEqual({
      version: 1,
      errorCode: 'CTX_SHARED_SERIALIZATION_FAILED',
      retryable: false,
    });
  });

  it.each(phases)('serializes bounded machine fields for phase %s', (phase) => {
    const error = new CtxSharedSerializationError({
      stepName: 'collect',
      phase,
      stack: 'stack trace',
    });
    const payload = JSON.parse(JSON.stringify(error));

    expect(payload).toEqual({
      name: 'CtxSharedSerializationError',
      message: error.message,
      code: 'CTX_SHARED_SERIALIZATION_FAILED',
      version: 1,
      stepName: 'collect',
      phase,
      retryable: false,
      stack: 'stack trace',
    });
    expect(error.message).toContain('circular references and BigInt');
    expect(error).not.toHaveProperty('cause');
    expect(isCtxSharedSerializationErrorPayload(payload)).toBe(true);
    expect(ctxSharedSerializationErrorPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('recognizes plain compatible-version payloads without instanceof', () => {
    const payload = {
      name: 'CtxSharedSerializationError',
      message: 'future host could not serialize shared state',
      code: 'CTX_SHARED_SERIALIZATION_FAILED',
      version: CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.version + 1,
      stepName: 'summarize',
      phase: 'future_host_boundary',
      retryable: false,
    };

    expect(isCtxSharedSerializationErrorPayload(payload)).toBe(true);
    expect(payload).not.toBeInstanceOf(CtxSharedSerializationError);
  });

  it.each([
    { version: 0, phase: 'ctx_shared_set', retryable: false },
    { version: 1, phase: '', retryable: false },
    { version: 1, phase: 'ctx_shared_set', retryable: true },
  ])('rejects malformed disposition fields: %#', ({ version, phase, retryable }) => {
    expect(
      isCtxSharedSerializationErrorPayload({
        name: 'CtxSharedSerializationError',
        message: 'invalid payload',
        code: 'CTX_SHARED_SERIALIZATION_FAILED',
        version,
        stepName: 'collect',
        phase,
        retryable,
      }),
    ).toBe(false);
  });
});
