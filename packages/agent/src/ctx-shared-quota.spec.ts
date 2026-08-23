import {
  CTX_SHARED_QUOTA_CONTRACT,
  MAX_SHARED_SNAPSHOT_BYTES,
  CtxSharedSizeLimitExceededError,
  ctxSharedSizeLimitExceededPayloadSchema,
  findCtxSharedSizeViolation,
  isCtxSharedSizeLimitExceededPayload,
  measureCtxSharedSnapshotBytes,
} from './index.js';
import type { CtxSharedSizeLimitPhase } from './index.js';

const EMPTY_VALUE_SNAPSHOT_BYTES = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');

function asciiSnapshotAt(byteLength: number): Record<string, string> {
  return { value: 'x'.repeat(byteLength - EMPTY_VALUE_SNAPSHOT_BYTES) };
}

describe('ctx.shared quota contract', () => {
  it('is frozen and owns the only public policy value', () => {
    expect(Object.isFrozen(CTX_SHARED_QUOTA_CONTRACT)).toBe(true);
    expect(CTX_SHARED_QUOTA_CONTRACT).toEqual({
      version: 1,
      limitBytes: 262_144,
      serialization: 'JSON.stringify',
      encoding: 'utf8',
      errorCode: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
    });
    expect(MAX_SHARED_SNAPSHOT_BYTES).toBe(CTX_SHARED_QUOTA_CONTRACT.limitBytes);
  });

  it('measures an empty snapshot as compact JSON', () => {
    expect(measureCtxSharedSnapshotBytes({})).toBe(2);
  });

  it('includes keys, punctuation, and every existing value in the whole snapshot', () => {
    const snapshot = { existing: 'kept', candidate: 'new' };
    expect(measureCtxSharedSnapshotBytes(snapshot)).toBe(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    expect(measureCtxSharedSnapshotBytes(snapshot)).toBeGreaterThan(Buffer.byteLength('keptnew', 'utf8'));
  });

  it('accepts an ASCII snapshot at exactly 262,144 bytes', () => {
    const snapshot = asciiSnapshotAt(MAX_SHARED_SNAPSHOT_BYTES);
    expect(measureCtxSharedSnapshotBytes(snapshot)).toBe(MAX_SHARED_SNAPSHOT_BYTES);
    expect(findCtxSharedSizeViolation(snapshot)).toBeUndefined();
  });

  it('rejects an ASCII snapshot one byte over the boundary', () => {
    const snapshot = asciiSnapshotAt(MAX_SHARED_SNAPSHOT_BYTES + 1);
    expect(findCtxSharedSizeViolation(snapshot)).toEqual({
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 1,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
    });
  });

  it('measures multibyte strings as UTF-8 rather than JavaScript code units', () => {
    const snapshot = { value: '😀é' };
    const serialized = JSON.stringify(snapshot);
    expect(measureCtxSharedSnapshotBytes(snapshot)).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(measureCtxSharedSnapshotBytes(snapshot)).toBeGreaterThan(serialized.length);
  });

  it('does not relabel JSON serialization failures as quota errors', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    let thrown: unknown;
    try {
      findCtxSharedSizeViolation(circular);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(CtxSharedSizeLimitExceededError);
  });
});

describe('CtxSharedSizeLimitExceededError', () => {
  const phases: readonly CtxSharedSizeLimitPhase[] = ['ctx_shared_set', 'step_completion', 'step_dispatch'];

  it.each(phases)('serializes stable machine fields for phase %s', (phase) => {
    const error = new CtxSharedSizeLimitExceededError({
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 17,
      stepName: 'collect',
      phase,
      stack: 'stack trace',
    });
    const payload = JSON.parse(JSON.stringify(error));

    expect(payload).toEqual({
      name: 'CtxSharedSizeLimitExceededError',
      message: error.message,
      code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 17,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
      stepName: 'collect',
      phase,
      retryable: false,
      stack: 'stack trace',
    });
    expect(error.message).toContain('IDs, or references');
    expect(isCtxSharedSizeLimitExceededPayload(payload)).toBe(true);
    expect(ctxSharedSizeLimitExceededPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('recognizes plain cross-process payloads without instanceof', () => {
    const payload = {
      name: 'CtxSharedSizeLimitExceededError',
      message: 'oversized',
      code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
      actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 1,
      limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
      stepName: 'summarize',
      phase: 'step_completion',
      retryable: false,
    };

    expect(isCtxSharedSizeLimitExceededPayload(payload)).toBe(true);
    expect(payload).not.toBeInstanceOf(CtxSharedSizeLimitExceededError);
  });

  it('rejects near-miss payloads with the canonical code but no actual violation', () => {
    expect(
      isCtxSharedSizeLimitExceededPayload({
        name: 'CtxSharedSizeLimitExceededError',
        message: 'not actually oversized',
        code: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
        actualBytes: MAX_SHARED_SNAPSHOT_BYTES,
        limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
        stepName: 'summarize',
        phase: 'step_completion',
        retryable: false,
      }),
    ).toBe(false);
  });
});
