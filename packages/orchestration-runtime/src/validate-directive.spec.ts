import { DisallowedTransitionError, UnknownStepError, type WorkflowManifest, goto, retry, terminate } from '@sapiom/orchestration';

import { decideRetry, validateDirective } from './validate-directive.js';

type Steps = WorkflowManifest['steps'];

function manifest(steps: Steps): WorkflowManifest {
  return {
    protocol: 1,
    name: 'w',
    entry: 'a',
    sdkVersion: '0.0.0',
    artifact: { sha256: 'x', entryFile: 'w.mjs' },
    steps,
  } as WorkflowManifest;
}

describe('validateDirective', () => {
  it('allows a declared continue to an existing step', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue', target: 'b' }] },
      b: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' }] },
    } as unknown as Steps);
    expect(validateDirective(m, 'a', goto('b'))).toBeNull();
  });

  it('rejects a continue to an unknown step', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue', target: 'b' }] },
      b: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' }] },
    } as unknown as Steps);
    expect(validateDirective(m, 'a', goto('c'))).toBeInstanceOf(UnknownStepError);
  });

  it('rejects a continue to an existing-but-undeclared target', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue', target: 'x' }] },
      b: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' }] },
      x: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' }] },
    } as unknown as Steps);
    expect(validateDirective(m, 'a', goto('b'))).toBeInstanceOf(DisallowedTransitionError);
  });

  it('allows a declared terminate and rejects an undeclared one', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' }] },
      b: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue', target: 'a' }] },
    } as unknown as Steps);
    expect(validateDirective(m, 'a', terminate())).toBeNull();
    expect(validateDirective(m, 'b', terminate())).toBeInstanceOf(DisallowedTransitionError);
  });

  it('always allows retry (universal, not a declared edge)', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue', target: 'a' }] },
    } as unknown as Steps);
    expect(validateDirective(m, 'a', retry())).toBeNull();
  });

  it('legacy manifest (no transitions) falls back to continue-target existence', () => {
    const m = manifest({
      a: { timeoutMs: null, inputSchema: null } as unknown as Steps[string],
    } as unknown as Steps);
    expect(validateDirective(m, 'a', goto('a'))).toBeNull();
    expect(validateDirective(m, 'a', goto('missing'))).toBeInstanceOf(UnknownStepError);
  });
});

describe('decideRetry', () => {
  it('retries while below the cap', () => {
    expect(decideRetry(0, 3)).toBe('retry');
    expect(decideRetry(1, 3)).toBe('retry');
  });

  it('fails once the next attempt would reach the cap', () => {
    expect(decideRetry(2, 3)).toBe('fail');
    expect(decideRetry(5, 3)).toBe('fail');
  });
});
