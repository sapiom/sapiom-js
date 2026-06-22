/**
 * @sapiom/workflow-sdk — own-package tests.
 *
 * Proves:
 *   1. defineOrchestration validation (name, entry, step map checks)
 *   2. Directive guard functions (isContinue, isRetry, isPause, isTerminate, isFail)
 *   3. InMemoryContextStore round-trip (get/set/has/snapshot)
 *   4. UnknownStepError is thrown by defineOrchestration for missing entry
 *   5. StepLogger structural compatibility: a plain object matching the
 *      StepLogger interface is accepted (validates the structural design)
 */

import {
  DIRECTIVE_KIND,
  InMemoryContextStore,
  StepInputValidationError,
  UnknownStepError,
  ORCHESTRATION_DEFINITION_BRAND,
  WorkflowError,
  defineStep,
  defineOrchestration,
  isContinue,
  isFail,
  isPause,
  isRetry,
  isTerminate,
  isOrchestrationDefinition,
  terminate,
} from './index.js';
import type {
  ContinueDirective,
  FailDirective,
  NextStepDirective,
  PauseUntilSignalDirective,
  RetryDirective,
  StepLogger,
  TerminateDirective,
} from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal terminal step suitable for use in defineOrchestration test fixtures. */
function makeStep(name: string) {
  return defineStep({
    name,
    next: [],
    terminal: true,
    async run() {
      return terminate(null);
    },
  });
}

// ---------------------------------------------------------------------------
// 1. defineOrchestration validation
// ---------------------------------------------------------------------------

describe('defineOrchestration', () => {
  it('returns the definition unchanged when valid', () => {
    const entry = makeStep('start');
    const def = defineOrchestration({
      name: 'my-workflow',
      entry: 'start',
      steps: { start: entry },
    });
    expect(def.name).toBe('my-workflow');
    expect(def.entry).toBe('start');
    expect(def.steps.start).toBe(entry);
  });

  it('throws when name is empty', () => {
    expect(() =>
      defineOrchestration({
        name: '',
        entry: 'start',
        steps: { start: makeStep('start') },
      }),
    ).toThrow('Workflow definition must have a non-empty name');
  });

  it('throws when entry is empty string', () => {
    expect(() =>
      defineOrchestration({
        name: 'wf',
        entry: '',
        steps: { start: makeStep('start') },
      }),
    ).toThrow("Workflow 'wf' must declare an entry step");
  });

  it('throws UnknownStepError when entry is not in steps', () => {
    expect(() =>
      defineOrchestration({
        name: 'wf',
        entry: 'missing',
        steps: { start: makeStep('start') },
      }),
    ).toThrow(UnknownStepError);
  });

  it('UnknownStepError carries the step name', () => {
    let thrown: unknown;
    try {
      defineOrchestration({ name: 'wf', entry: 'missing', steps: { start: makeStep('start') } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownStepError);
    expect((thrown as UnknownStepError).stepName).toBe('missing');
  });

  it('throws when a step key does not match step.name', () => {
    expect(() =>
      defineOrchestration({
        name: 'wf',
        entry: 'start',
        steps: { start: makeStep('wrong-name') },
      }),
    ).toThrow("step name mismatch at key 'start'");
  });

  it('accepts multiple steps with correct names', () => {
    const def = defineOrchestration({
      name: 'multi',
      entry: 'a',
      steps: { a: makeStep('a'), b: makeStep('b'), c: makeStep('c') },
    });
    expect(Object.keys(def.steps)).toHaveLength(3);
  });

  it('attaches a non-enumerable ORCHESTRATION_DEFINITION_BRAND symbol to the returned object', () => {
    const def = defineOrchestration({
      name: 'branded',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    // The brand must be present with value 1.
    const brand = (def as unknown as Record<symbol, unknown>)[ORCHESTRATION_DEFINITION_BRAND];
    expect(brand).toBe(1);
    // Non-enumerable: must not appear in Object.keys or for...in.
    expect(Object.keys(def)).not.toContain(ORCHESTRATION_DEFINITION_BRAND.toString());
    const enumKeys: string[] = [];
    for (const k in def) enumKeys.push(k);
    expect(enumKeys).not.toContain(ORCHESTRATION_DEFINITION_BRAND.toString());
  });

  it('brand survives a JSON round-trip by being on the live object (not on a parsed copy)', () => {
    const def = defineOrchestration({
      name: 'json-round-trip',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    // The brand is on the live definition object.
    expect(isOrchestrationDefinition(def)).toBe(true);
    // A plain-JSON copy (simulating what JSON.stringify/parse produces) lacks the brand.
    const copy = JSON.parse(JSON.stringify({ name: def.name, entry: def.entry, steps: {} }));
    expect(isOrchestrationDefinition(copy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isOrchestrationDefinition type guard
// ---------------------------------------------------------------------------

describe('isOrchestrationDefinition', () => {
  it('returns true for a value produced by defineOrchestration', () => {
    const def = defineOrchestration({
      name: 'wf',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    expect(isOrchestrationDefinition(def)).toBe(true);
  });

  it('returns false for a plain object with name/entry/steps (duck-type trap)', () => {
    const plain = { name: 'wf', entry: 'start', steps: {} };
    expect(isOrchestrationDefinition(plain)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isOrchestrationDefinition(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isOrchestrationDefinition('workflow')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isOrchestrationDefinition(undefined)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isOrchestrationDefinition({})).toBe(false);
  });

  it('narrows the type: TypeScript accepts it as OrchestrationDefinition after guard', () => {
    const val: unknown = defineOrchestration({
      name: 'narrowed',
      entry: 's',
      steps: { s: makeStep('s') },
    });
    if (isOrchestrationDefinition(val)) {
      // If this compiles, the type narrowing works.
      expect(val.name).toBe('narrowed');
    } else {
      throw new Error('expected isOrchestrationDefinition to return true');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Directive guard functions
// ---------------------------------------------------------------------------

describe('directive guards', () => {
  const continueD: ContinueDirective = { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'next' };
  const retryD: RetryDirective = { kind: DIRECTIVE_KIND.RETRY };
  const pauseD: PauseUntilSignalDirective = { kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL, signal: { name: 'sig' } };
  const terminateD: TerminateDirective = { kind: DIRECTIVE_KIND.TERMINATE };
  const failD: FailDirective = { kind: DIRECTIVE_KIND.FAIL };

  const all: NextStepDirective[] = [continueD, retryD, pauseD, terminateD, failD];

  it('isContinue identifies only continue', () => {
    expect(all.filter(isContinue)).toEqual([continueD]);
  });

  it('isRetry identifies only retry', () => {
    expect(all.filter(isRetry)).toEqual([retryD]);
  });

  it('isPause identifies only pause_until_signal', () => {
    expect(all.filter(isPause)).toEqual([pauseD]);
  });

  it('isTerminate identifies only terminate', () => {
    expect(all.filter(isTerminate)).toEqual([terminateD]);
  });

  it('isFail identifies only fail', () => {
    expect(all.filter(isFail)).toEqual([failD]);
  });

  it('isContinue narrows type: stepName is accessible', () => {
    const d: NextStepDirective = continueD;
    if (isContinue(d)) {
      // TypeScript should allow d.stepName here
      expect(d.stepName).toBe('next');
    } else {
      throw new Error('isContinue should have returned true');
    }
  });

  it('isPause carries signal name and correlationId', () => {
    const d: PauseUntilSignalDirective = {
      kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
      signal: { name: 'approval', correlationId: 'run-1' },
      resumeStep: 'finalize',
    };
    expect(isPause(d)).toBe(true);
    if (isPause(d)) {
      expect(d.signal.correlationId).toBe('run-1');
      expect(d.resumeStep).toBe('finalize');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. InMemoryContextStore round-trip
// ---------------------------------------------------------------------------

describe('InMemoryContextStore', () => {
  // Extends `Record<string, unknown>` so it satisfies `InMemoryContextStore`'s
  // `TShared extends Record<string, unknown>` constraint. A bare interface (or a
  // plain object) lacks the index signature the constraint needs; `extends`
  // gives it one while keeping the named keys' specific types for get/set. (A
  // `type` alias would also satisfy the constraint via its implicit index
  // signature, but the lint rule auto-rewrites `type`→`interface`, which would
  // then fail the constraint — so the interface form is the stable one.)
  interface TestShared extends Record<string, unknown> {
    count: number;
    label: string;
    nested: { x: number };
  }

  it('starts empty and has returns false for unknown keys', () => {
    const store = new InMemoryContextStore<TestShared>();
    expect(store.has('count')).toBe(false);
    expect(store.get('count')).toBeUndefined();
  });

  it('set/get round-trips scalar values', () => {
    const store = new InMemoryContextStore<TestShared>();
    store.set('count', 42);
    expect(store.get('count')).toBe(42);
    expect(store.has('count')).toBe(true);
  });

  it('set/get round-trips object values', () => {
    const store = new InMemoryContextStore<TestShared>();
    store.set('nested', { x: 7 });
    expect(store.get('nested')).toEqual({ x: 7 });
  });

  it('snapshot returns a copy with all set keys', () => {
    const store = new InMemoryContextStore<TestShared>({ count: 1 });
    store.set('label', 'hello');
    const snap = store.snapshot();
    expect(snap).toEqual({ count: 1, label: 'hello' });
  });

  it('snapshot is a shallow copy — mutation does not affect store', () => {
    const store = new InMemoryContextStore<TestShared>({ count: 5 });
    const snap = store.snapshot();
    (snap as { count?: number }).count = 99;
    expect(store.get('count')).toBe(5);
  });

  it('initialises from a partial initial state', () => {
    const store = new InMemoryContextStore<TestShared>({ count: 10 });
    expect(store.get('count')).toBe(10);
    expect(store.get('label')).toBeUndefined();
  });

  it('overwrites previous value on repeated set', () => {
    const store = new InMemoryContextStore<TestShared>();
    store.set('count', 1);
    // intentional: asserts a repeated set overwrites the prior value
    store.set('count', 2);
    expect(store.get('count')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Error hierarchy
// ---------------------------------------------------------------------------

describe('error hierarchy', () => {
  it('UnknownStepError is a WorkflowError', () => {
    const e = new UnknownStepError('foo');
    expect(e).toBeInstanceOf(WorkflowError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('UnknownStepError');
    expect(e.stepName).toBe('foo');
    expect(e.message).toContain('foo');
  });

  it('StepInputValidationError is a WorkflowError and carries issues', () => {
    // Use a minimal $ZodIssue-compatible object cast to the constructor's expected type
    const fakeIssues = [
      { path: ['name'], message: 'Required', code: 'invalid_type' },
    ] as unknown as ConstructorParameters<typeof StepInputValidationError>[1];
    const e = new StepInputValidationError('myStep', fakeIssues);
    expect(e).toBeInstanceOf(WorkflowError);
    expect(e.name).toBe('StepInputValidationError');
    expect(e.stepName).toBe('myStep');
    expect(e.issues).toBe(fakeIssues);
    expect(e.message).toContain('myStep');
    expect(e.message).toContain('name');
  });
});

// ---------------------------------------------------------------------------
// 5. StepLogger structural compatibility
// ---------------------------------------------------------------------------

describe('StepLogger structural interface', () => {
  it('a plain object with the four methods satisfies StepLogger', () => {
    const logs: string[] = [];
    // If this assignment compiles, the structural interface is correct.
    const logger: StepLogger = {
      info: (msg) => {
        logs.push(`info:${msg}`);
      },
      warn: (msg) => {
        logs.push(`warn:${msg}`);
      },
      error: (msg) => {
        logs.push(`error:${msg}`);
      },
      debug: (msg) => {
        logs.push(`debug:${msg}`);
      },
    };
    logger.info('hello');
    logger.warn('careful', { key: 'val' });
    logger.error('boom');
    logger.debug('trace');
    expect(logs).toEqual(['info:hello', 'warn:careful', 'error:boom', 'debug:trace']);
  });
});
