import {
  SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT,
  isRetryableStepErrorPayload,
  isTransientSapiomCall,
  parseRetryableStepErrorPayload,
  sapiomCallTransientErrorPayloadSchema,
  toRetryableStepErrorPayload,
} from './index.js';
import type { RetryableStepErrorPayload, SapiomCallFacts } from './index.js';

const payloadOf = (overrides: Partial<RetryableStepErrorPayload> = {}): RetryableStepErrorPayload => ({
  name: 'SearchHttpError',
  message: 'Failed to search: 503 upstream unavailable',
  code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
  version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
  retryable: true,
  status: 503,
  capability: 'web.search',
  ...overrides,
});

describe('isTransientSapiomCall()', () => {
  const transient: SapiomCallFacts[] = [
    { status: 500 },
    { status: 502 },
    { status: 503 },
    { status: 504 },
    { status: 529 },
    { status: 429 },
    { status: 408 },
    { status: 425 },
    { network: true },
    { network: true, capability: 'web.search' },
  ];
  const deterministic: SapiomCallFacts[] = [
    { status: 400 },
    { status: 401 },
    { status: 402 },
    { status: 404 },
    { status: 409 },
    { status: 422 },
    { status: 200 },
    {},
    { capability: 'web.search' },
    { network: false, status: 404 },
  ];

  it.each(transient)('treats %j as transient', (facts) => {
    expect(isTransientSapiomCall(facts)).toBe(true);
  });

  it.each(deterministic)('treats %j as not transient', (facts) => {
    expect(isTransientSapiomCall(facts)).toBe(false);
  });

  it('ignores a status that is not a real HTTP status', () => {
    expect(isTransientSapiomCall({ status: 9999 })).toBe(false);
    expect(isTransientSapiomCall({ status: 503.5 })).toBe(false);
    expect(isTransientSapiomCall({ status: Number.NaN })).toBe(false);
  });
});

describe('toRetryableStepErrorPayload()', () => {
  it('builds the canonical payload from a live error and its facts', () => {
    const error = new Error('Failed to search: 503 upstream unavailable');
    error.name = 'SearchHttpError';
    error.stack = 'SearchHttpError: boom\n    at step';

    const payload = toRetryableStepErrorPayload(error, {
      capability: 'web.search',
      status: 503,
      retryAfterMs: 2000,
    });

    expect(payload).toEqual(payloadOf({ retryAfterMs: 2000, stack: error.stack }));
    expect(Object.isFrozen(SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT)).toBe(true);
    expect(sapiomCallTransientErrorPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('omits the status when no response ever existed', () => {
    const error = new TypeError('fetch failed');

    const payload = toRetryableStepErrorPayload(error, { network: true, capability: 'web.search' });

    expect(payload).toMatchObject({ name: 'TypeError', capability: 'web.search', retryable: true });
    expect(payload).not.toHaveProperty('status');
  });

  it('returns undefined for a deterministic failure so it ships as a legacy error', () => {
    const error = new Error('Failed to search: 404 not found');

    expect(toRetryableStepErrorPayload(error, { status: 404, capability: 'web.search' })).toBeUndefined();
  });

  it('returns undefined when the call recorded no facts at all', () => {
    expect(toRetryableStepErrorPayload(new Error('author threw'), undefined)).toBeUndefined();
  });

  it('drops malformed facts instead of throwing on the failure path', () => {
    const payload = toRetryableStepErrorPayload(new TypeError('fetch failed'), {
      network: true,
      status: 9999,
      capability: 'x'.repeat(500),
      retryAfterMs: 1500.7,
    });

    expect(payload).not.toHaveProperty('status');
    expect(payload?.capability).toHaveLength(200);
    expect(payload?.retryAfterMs).toBe(1501);
  });

  it('is total: never throws, whatever the error and facts carry', () => {
    const hostile = new Error('boom');
    (hostile as unknown as { name: unknown }).name = 42;
    (hostile as unknown as { stack: unknown }).stack = { not: 'a string' };

    const payload = toRetryableStepErrorPayload(hostile, {
      status: 503,
      retryAfterMs: 1e20,
    });

    expect(payload).toMatchObject({ name: '42', message: 'boom', status: 503 });
    expect(payload).not.toHaveProperty('retryAfterMs');
    expect(payload).not.toHaveProperty('stack');
  });

  it('does not throw on facts built with hostile accessors', () => {
    const hostileFacts = {
      get status(): number {
        throw new Error('hostile getter');
      },
      get capability(): string {
        throw new Error('hostile getter');
      },
      network: true,
    };

    expect(() => isTransientSapiomCall(hostileFacts)).not.toThrow();
    expect(isTransientSapiomCall(hostileFacts)).toBe(true);
    expect(toRetryableStepErrorPayload(new Error('boom'), hostileFacts)).toEqual({
      name: 'Error',
      message: 'boom',
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
      retryable: true,
      stack: expect.any(String) as unknown as string,
    });
  });

  it('keeps a large but representable Retry-After', () => {
    expect(toRetryableStepErrorPayload(new Error('boom'), { status: 429, retryAfterMs: 86_400_000 })).toMatchObject({
      retryAfterMs: 86_400_000,
    });
  });

  it.each([
    ['a message replaced by an object', { message: { nope: true } }],
    ['a name replaced by null', { name: null }],
    ['a message replaced by a throwing getter', {}],
  ])('survives %s', (_label, overrides) => {
    const error = Object.assign(new Error('boom'), overrides);
    if (_label.includes('throwing getter')) {
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('hostile accessor');
        },
      });
    }

    expect(() => toRetryableStepErrorPayload(error, { status: 503 })).not.toThrow();
  });

  it('never emits a stack key when the error has none', () => {
    const error = new Error('boom');
    delete error.stack;

    expect(toRetryableStepErrorPayload(error, { status: 503 })).not.toHaveProperty('stack');
  });
});

describe('parseRetryableStepErrorPayload()', () => {
  it('accepts the canonical payload and strips extra properties', () => {
    const parsed = parseRetryableStepErrorPayload({ ...payloadOf(), sourceMap: { file: 'step.ts' } });

    expect(parsed).toEqual(payloadOf());
    expect(isRetryableStepErrorPayload(payloadOf())).toBe(true);
  });

  it('accepts a compatible future contract version', () => {
    expect(parseRetryableStepErrorPayload(payloadOf({ version: 2 }))?.version).toBe(2);
  });

  it.each([
    ['an unknown code', payloadOf({ code: 'SOMETHING_ELSE' as never })],
    ['a non-retryable disposition', payloadOf({ retryable: false as never })],
    ['an out-of-range status', payloadOf({ status: 42 })],
    ['a legacy error', { name: 'Error', message: 'author threw' }],
    ['a terminal platform error', { name: 'StepInputValidationError', code: 'STEP_INPUT_VALIDATION_FAILED', retryable: false }],
    ['a non-object', 'SAPIOM_CALL_TRANSIENT'],
  ])('rejects %s', (_label, value) => {
    expect(parseRetryableStepErrorPayload(value)).toBeUndefined();
    expect(isRetryableStepErrorPayload(value)).toBe(false);
  });
});
