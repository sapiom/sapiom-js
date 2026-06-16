/**
 * Transition constructor shapes — goto/terminate/fail/pauseUntilSignal/retry.
 * The runner extracts `output` from these and rebuilds the wire directive; the
 * engine then validates the directive against the pinned manifest.
 */

import { DIRECTIVE_KIND, fail, goto, pauseUntilSignal, retry, terminate } from './index.js';

describe('goto', () => {
  it('builds a continue directive carrying the payload as `input`', () => {
    expect(goto('enrich', { topic: 't' })).toEqual({
      kind: DIRECTIVE_KIND.CONTINUE,
      stepName: 'enrich',
      input: { topic: 't' },
    });
  });

  it('omitted payload → input undefined', () => {
    expect(goto('enrich')).toEqual({ kind: DIRECTIVE_KIND.CONTINUE, stepName: 'enrich', input: undefined });
  });
});

describe('terminate', () => {
  it('carries output and optional reason', () => {
    expect(terminate({ ok: true })).toEqual({
      kind: DIRECTIVE_KIND.TERMINATE,
      output: { ok: true },
      reason: undefined,
    });
    expect(terminate({ ok: true }, { reason: 'done' }).reason).toBe('done');
  });
});

describe('fail', () => {
  it('carries reason and optional structured output', () => {
    expect(fail('rejected')).toEqual({ kind: DIRECTIVE_KIND.FAIL, reason: 'rejected', output: undefined });
    expect(fail('rejected', { output: { code: 7 } }).output).toEqual({ code: 7 });
  });
});

describe('pauseUntilSignal', () => {
  it('wraps signal as { name } and carries resumeStep; correlationId left undefined for the runner', () => {
    expect(pauseUntilSignal({ signal: 'demo.approval', resumeStep: 'finalize' })).toEqual({
      kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
      signal: { name: 'demo.approval', correlationId: undefined },
      resumeStep: 'finalize',
      timeoutMs: undefined,
      output: undefined,
    });
  });

  it('passes through an explicit correlationId', () => {
    const d = pauseUntilSignal({ signal: 's', resumeStep: 'r', correlationId: 'key-1' });
    expect(d.signal.correlationId).toBe('key-1');
  });
});

describe('retry', () => {
  it('builds a retry directive with optional delay/reason', () => {
    expect(retry()).toEqual({ kind: DIRECTIVE_KIND.RETRY, delayMs: undefined, reason: undefined });
    expect(retry({ delayMs: 500, reason: 'transient' })).toEqual({
      kind: DIRECTIVE_KIND.RETRY,
      delayMs: 500,
      reason: 'transient',
    });
  });
});
