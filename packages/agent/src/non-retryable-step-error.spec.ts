import {
  CTX_SHARED_QUOTA_CONTRACT,
  MAX_SHARED_SNAPSHOT_BYTES,
  STEP_INPUT_VALIDATION_ERROR_CONTRACT,
  StepInputValidationError,
  isNonRetryableStepErrorPayload,
  isStepInputValidationErrorPayload,
  parseNonRetryableStepErrorPayload,
  stepInputValidationErrorPayloadSchema,
} from './index.js';

describe('non-retryable platform step errors', () => {
  it('serializes StepInputValidationError without raw Zod issues', () => {
    const error = new StepInputValidationError('validate', [
      {
        code: 'custom',
        path: ['email'],
        message: 'required',
        input: undefined,
      },
    ]);
    const payload = JSON.parse(JSON.stringify(error));

    expect(Object.isFrozen(STEP_INPUT_VALIDATION_ERROR_CONTRACT)).toBe(true);
    expect(payload).toMatchObject({
      name: 'StepInputValidationError',
      message: error.message,
      code: 'STEP_INPUT_VALIDATION_FAILED',
      version: 1,
      stepName: 'validate',
      retryable: false,
    });
    expect(payload).not.toHaveProperty('issues');
    expect(stepInputValidationErrorPayloadSchema.parse(payload)).toEqual(payload);
    expect(isStepInputValidationErrorPayload(payload)).toBe(true);
  });

  it('recognizes compatible future reporting versions and strips extra fields', () => {
    const payload = {
      name: 'StepInputValidationError',
      message: 'input is invalid',
      code: STEP_INPUT_VALIDATION_ERROR_CONTRACT.errorCode,
      version: STEP_INPUT_VALIDATION_ERROR_CONTRACT.version + 1,
      stepName: 'validate',
      retryable: false,
      issues: [{ path: ['secret'], message: 'must not cross the wire' }],
    };

    expect(parseNonRetryableStepErrorPayload(payload)).toEqual({
      name: 'StepInputValidationError',
      message: 'input is invalid',
      code: 'STEP_INPUT_VALIDATION_FAILED',
      version: 2,
      stepName: 'validate',
      retryable: false,
    });
  });

  it('recognizes the existing canonical quota payload through the same registry', () => {
    const payload = {
      name: 'CtxSharedSizeLimitExceededError',
      message: 'too large',
      code: CTX_SHARED_QUOTA_CONTRACT.errorCode,
      version: CTX_SHARED_QUOTA_CONTRACT.version,
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 1,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
      stepName: 'collect',
      phase: 'ctx_shared_set',
      retryable: false,
    };

    expect(parseNonRetryableStepErrorPayload(payload)).toEqual(payload);
    expect(isNonRetryableStepErrorPayload(payload)).toBe(true);
  });

  it.each([
    { name: 'Error', message: 'ordinary author error', retryable: false },
    {
      name: 'CustomError',
      message: 'unknown platform-looking error',
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
      name: 'CtxSharedSizeLimitExceededError',
      message: 'not actually over quota',
      code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
      version: 1,
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
      stepName: 'collect',
      phase: 'ctx_shared_set',
      retryable: false,
    },
  ])('defaults unrecognized payloads to retryable: %#', (payload) => {
    expect(parseNonRetryableStepErrorPayload(payload)).toBeUndefined();
    expect(isNonRetryableStepErrorPayload(payload)).toBe(false);
  });
});
