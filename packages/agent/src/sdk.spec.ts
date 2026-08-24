/**
 * @sapiom/workflow-sdk — own-package tests.
 *
 * Proves:
 *   1. defineAgent validation (name, entry, step map checks)
 *   2. Directive guard functions (isContinue, isRetry, isPause, isTerminate, isFail)
 *   3. InMemoryContextStore round-trip (get/set/has/snapshot)
 *   4. UnknownStepError is thrown by defineAgent for missing entry
 *   5. StepLogger structural compatibility: a plain object matching the
 *      StepLogger interface is accepted (validates the structural design)
 */

import { z } from 'zod/v4';

import {
  MAX_SHARED_SNAPSHOT_BYTES,
  CtxSharedSerializationError,
  CtxSharedSizeLimitExceededError,
  DIRECTIVE_KIND,
  InMemoryContextStore,
  StepInputValidationError,
  UnknownStepError,
  AGENT_DEFINITION_BRAND,
  AgentError,
  defineStep,
  defineAgent,
  isContinue,
  isFail,
  isPause,
  isRetry,
  isTerminate,
  isAgentDefinition,
  isLegacyOrchestrationDefinition,
  LEGACY_ORCHESTRATION_DEFINITION_BRAND,
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

/** Minimal terminal step suitable for use in defineAgent test fixtures. */
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
// 1. defineAgent validation
// ---------------------------------------------------------------------------

describe('defineAgent', () => {
  it('returns the definition unchanged when valid', () => {
    const entry = makeStep('start');
    const def = defineAgent({
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
      defineAgent({
        name: '',
        entry: 'start',
        steps: { start: makeStep('start') },
      }),
    ).toThrow('Agent definition must have a non-empty name');
  });

  it('throws when entry is empty string', () => {
    expect(() =>
      defineAgent({
        name: 'wf',
        entry: '',
        steps: { start: makeStep('start') },
      }),
    ).toThrow("Agent 'wf' must declare an entry step");
  });

  it('throws UnknownStepError when entry is not in steps', () => {
    expect(() =>
      defineAgent({
        name: 'wf',
        entry: 'missing',
        steps: { start: makeStep('start') },
      }),
    ).toThrow(UnknownStepError);
  });

  it('UnknownStepError carries the step name', () => {
    let thrown: unknown;
    try {
      defineAgent({ name: 'wf', entry: 'missing', steps: { start: makeStep('start') } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownStepError);
    expect((thrown as UnknownStepError).stepName).toBe('missing');
  });

  it('throws when a step key does not match step.name', () => {
    expect(() =>
      defineAgent({
        name: 'wf',
        entry: 'start',
        steps: { start: makeStep('wrong-name') },
      }),
    ).toThrow("step name mismatch at key 'start'");
  });

  it('accepts multiple steps with correct names', () => {
    const def = defineAgent({
      name: 'multi',
      entry: 'a',
      steps: { a: makeStep('a'), b: makeStep('b'), c: makeStep('c') },
    });
    expect(Object.keys(def.steps)).toHaveLength(3);
  });

  it('attaches a non-enumerable AGENT_DEFINITION_BRAND symbol to the returned object', () => {
    const def = defineAgent({
      name: 'branded',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    // The brand must be present with value 1.
    const brand = (def as unknown as Record<symbol, unknown>)[AGENT_DEFINITION_BRAND];
    expect(brand).toBe(1);
    // Non-enumerable: must not appear in Object.keys or for...in.
    expect(Object.keys(def)).not.toContain(AGENT_DEFINITION_BRAND.toString());
    const enumKeys: string[] = [];
    for (const k in def) enumKeys.push(k);
    expect(enumKeys).not.toContain(AGENT_DEFINITION_BRAND.toString());
  });

  it('brand survives a JSON round-trip by being on the live object (not on a parsed copy)', () => {
    const def = defineAgent({
      name: 'json-round-trip',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    // The brand is on the live definition object.
    expect(isAgentDefinition(def)).toBe(true);
    // A plain-JSON copy (simulating what JSON.stringify/parse produces) lacks the brand.
    const copy = JSON.parse(JSON.stringify({ name: def.name, entry: def.entry, steps: {} }));
    expect(isAgentDefinition(copy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1b. defineAgent — agent-level inputSchema (the first-class input contract)
// ---------------------------------------------------------------------------

describe('defineAgent agent-level inputSchema', () => {
  const contract = z.object({ companyId: z.number() });

  /** An entry step that declares no inputSchema of its own. */
  function entryWithoutSchema(name: string) {
    return defineStep({
      name,
      next: [],
      terminal: true,
      async run() {
        return terminate(null);
      },
    });
  }

  /** An entry step that declares its own inputSchema. */
  function entryWithSchema(name: string, schema: z.ZodType) {
    return defineStep({
      name,
      next: [],
      terminal: true,
      inputSchema: schema,
      async run() {
        return terminate(null);
      },
    });
  }

  it('folds the agent-level schema onto an entry step that declares none', () => {
    const entry = entryWithoutSchema('start');
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      inputSchema: contract,
      steps: { start: entry },
    });
    // The entry step now carries the agent-level schema.
    expect(def.steps.start.inputSchema).toBe(contract);
  });

  it('leaves an entry step that declares the identical schema object untouched (no conflict)', () => {
    const entry = entryWithSchema('start', contract);
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      inputSchema: contract,
      steps: { start: entry },
    });
    expect(def.steps.start).toBe(entry);
    expect(def.steps.start.inputSchema).toBe(contract);
  });

  it('throws a clear error when agent-level and entry-step schemas conflict', () => {
    const entrySchema = z.object({ topic: z.string() });
    expect(() =>
      defineAgent({
        name: 'wf',
        entry: 'start',
        inputSchema: contract,
        steps: { start: entryWithSchema('start', entrySchema) },
      }),
    ).toThrow(/declares a different inputSchema at the agent level and on its entry step 'start'/);
  });

  it('does not mutate a steps object shared across two defineAgent calls', () => {
    // Both agents are built from the SAME steps object literal. Folding the
    // agent-level schema onto the first must NOT rewrite the entry step the
    // second reads (copy-on-write, not in-place mutation).
    const start = entryWithoutSchema('start');
    const shared = { start };
    const withSchema = defineAgent({
      name: 'with',
      entry: 'start',
      inputSchema: contract,
      steps: shared,
    });
    const without = defineAgent({
      name: 'without',
      entry: 'start',
      steps: shared,
    });
    // The first agent folded the contract onto its own (fresh) entry step...
    expect(withSchema.steps.start.inputSchema).toBe(contract);
    // ...but the shared object and the second agent are untouched.
    expect(shared.start).toBe(start);
    expect(shared.start.inputSchema).toBeUndefined();
    expect(without.steps.start.inputSchema).toBeUndefined();
  });

  it('does not mutate a frozen steps map (folds via copy, no TypeError)', () => {
    const frozen = Object.freeze({ start: entryWithoutSchema('start') });
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      inputSchema: contract,
      steps: frozen,
    });
    expect(def.steps.start.inputSchema).toBe(contract);
    // The original frozen map is left as-is.
    expect(frozen.start.inputSchema).toBeUndefined();
  });

  it('does not touch non-entry steps', () => {
    const entry = entryWithoutSchema('start');
    const second = entryWithoutSchema('second');
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      inputSchema: contract,
      steps: { start: entry, second },
    });
    expect(def.steps.second.inputSchema).toBeUndefined();
    expect(def.steps.second).toBe(second);
  });

  it('is a no-op when no agent-level schema is declared (back-compat)', () => {
    const entry = entryWithSchema('start', contract);
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      steps: { start: entry },
    });
    // Entry step reference and its own schema are preserved unchanged.
    expect(def.steps.start).toBe(entry);
    expect(def.steps.start.inputSchema).toBe(contract);
  });
});

// ---------------------------------------------------------------------------
// isAgentDefinition type guard
// ---------------------------------------------------------------------------

describe('isAgentDefinition', () => {
  it('returns true for a value produced by defineAgent', () => {
    const def = defineAgent({
      name: 'wf',
      entry: 'start',
      steps: { start: makeStep('start') },
    });
    expect(isAgentDefinition(def)).toBe(true);
  });

  it('returns false for a plain object with name/entry/steps (duck-type trap)', () => {
    const plain = { name: 'wf', entry: 'start', steps: {} };
    expect(isAgentDefinition(plain)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAgentDefinition(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isAgentDefinition('workflow')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAgentDefinition(undefined)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isAgentDefinition({})).toBe(false);
  });

  it('narrows the type: TypeScript accepts it as AgentDefinition after guard', () => {
    const val: unknown = defineAgent({
      name: 'narrowed',
      entry: 's',
      steps: { s: makeStep('s') },
    });
    if (isAgentDefinition(val)) {
      // If this compiles, the type narrowing works.
      expect(val.name).toBe('narrowed');
    } else {
      throw new Error('expected isAgentDefinition to return true');
    }
  });
});

// ---------------------------------------------------------------------------
// isLegacyOrchestrationDefinition type guard (pre-rename @sapiom/orchestration)
// ---------------------------------------------------------------------------

describe('isLegacyOrchestrationDefinition', () => {
  // What the old SDK's defineOrchestration produced: the same definition
  // shape, branded with Symbol.for('sapiom.orchestration.definition') = 1
  // as a non-enumerable property.
  function makeLegacyDefinition(): unknown {
    const def = { name: 'legacy-wf', entry: 'start', steps: { start: makeStep('start') } };
    Object.defineProperty(def, LEGACY_ORCHESTRATION_DEFINITION_BRAND, {
      value: 1,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return def;
  }

  it('returns true for a legacy-branded definition', () => {
    expect(isLegacyOrchestrationDefinition(makeLegacyDefinition())).toBe(true);
  });

  it('returns false for a current defineAgent definition — the two brands are distinct', () => {
    const def = defineAgent({ name: 'wf', entry: 'start', steps: { start: makeStep('start') } });
    expect(isLegacyOrchestrationDefinition(def)).toBe(false);
    expect(isAgentDefinition(makeLegacyDefinition())).toBe(false);
  });

  it('returns false for plain objects, null and primitives', () => {
    expect(isLegacyOrchestrationDefinition({ name: 'wf', entry: 'start', steps: {} })).toBe(false);
    expect(isLegacyOrchestrationDefinition(null)).toBe(false);
    expect(isLegacyOrchestrationDefinition('workflow')).toBe(false);
    expect(isLegacyOrchestrationDefinition(undefined)).toBe(false);
  });

  it('resolves through the global symbol registry — a brand attached via its own Symbol.for call matches', () => {
    const def = { name: 'other-copy', entry: 's', steps: { s: makeStep('s') } };
    Object.defineProperty(def, Symbol.for('sapiom.orchestration.definition'), { value: 1, enumerable: false });
    expect(isLegacyOrchestrationDefinition(def)).toBe(true);
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

  describe('atomic whole-snapshot validation', () => {
    interface QuotaShared extends Record<string, unknown> {
      existing: string;
      value: unknown;
      toJSON: () => unknown;
    }

    function asciiValueForSnapshotBytes(snapshotBytes: number, existing?: string): string {
      const empty = existing === undefined ? { value: '' } : { existing, value: '' };
      return 'x'.repeat(snapshotBytes - Buffer.byteLength(JSON.stringify(empty), 'utf8'));
    }

    it('copies constructor state without validating it', () => {
      const initial: Partial<QuotaShared> = { value: BigInt(1) };
      const store = new InMemoryContextStore<QuotaShared>(initial, { stepName: 'construct' });

      initial.value = 'changed outside the store';

      expect(store.get('value')).toBe(BigInt(1));
    });

    it('accepts exactly 262,144 bytes while counting existing state and punctuation', () => {
      const store = new InMemoryContextStore<QuotaShared>({ existing: 'kept' }, { stepName: 'collect' });
      const value = asciiValueForSnapshotBytes(MAX_SHARED_SNAPSHOT_BYTES, 'kept');

      store.set('value', value);

      expect(Buffer.byteLength(JSON.stringify(store.snapshot()), 'utf8')).toBe(MAX_SHARED_SNAPSHOT_BYTES);
      expect(store.snapshot()).toEqual({ existing: 'kept', value });
    });

    it('rejects one byte over and leaves a failed insertion uncommitted', () => {
      const store = new InMemoryContextStore<QuotaShared>({}, { stepName: 'collect' });
      const value = asciiValueForSnapshotBytes(MAX_SHARED_SNAPSHOT_BYTES + 1);

      let thrown: unknown;
      try {
        store.set('value', value);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        name: 'CtxSharedSizeLimitExceededError',
        actualBytes: MAX_SHARED_SNAPSHOT_BYTES + 1,
        limitBytes: MAX_SHARED_SNAPSHOT_BYTES,
        stepName: 'collect',
        phase: 'ctx_shared_set',
        retryable: false,
      });
      expect(thrown).toBeInstanceOf(CtxSharedSizeLimitExceededError);
      expect(store.snapshot()).toEqual({});
    });

    it('preserves the previous value when an oversized replacement fails', () => {
      const store = new InMemoryContextStore<QuotaShared>(
        { existing: 'kept', value: 'accepted' },
        { stepName: 'replace' },
      );

      expect(() => store.set('value', 'x'.repeat(MAX_SHARED_SNAPSHOT_BYTES))).toThrow(CtxSharedSizeLimitExceededError);
      expect(store.snapshot()).toEqual({ existing: 'kept', value: 'accepted' });
    });

    it('measures multibyte values as UTF-8 bytes at set time', () => {
      const store = new InMemoryContextStore<QuotaShared>({}, { stepName: 'unicode' });

      expect(() => store.set('value', '😀'.repeat(70_000))).toThrow(CtxSharedSizeLimitExceededError);
      expect(store.snapshot()).toEqual({});
    });

    it.each([
      {
        label: 'a circular reference',
        value: () => {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          return circular;
        },
      },
      { label: 'a BigInt', value: () => BigInt(1) },
      {
        label: 'a throwing toJSON method',
        value: () => ({
          toJSON() {
            throw new Error('private serialization detail');
          },
        }),
      },
    ])('rejects $label atomically as a typed terminal serialization error', ({ value }) => {
      const store = new InMemoryContextStore<QuotaShared>(
        { existing: 'accepted', value: 'previous' },
        { stepName: 'serialize' },
      );

      let thrown: unknown;
      try {
        store.set('value', value());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CtxSharedSerializationError);
      expect(thrown).toMatchObject({
        code: 'CTX_SHARED_SERIALIZATION_FAILED',
        stepName: 'serialize',
        phase: 'ctx_shared_set',
        retryable: false,
      });
      expect((thrown as Error).message).not.toContain('private serialization detail');
      expect(store.snapshot()).toEqual({
        existing: 'accepted',
        value: 'previous',
      });
    });

    it('rejects a root toJSON method that makes the whole snapshot undefined', () => {
      const store = new InMemoryContextStore<QuotaShared>({}, { stepName: 'root-json' });

      expect(() => store.set('toJSON', () => undefined)).toThrow(CtxSharedSerializationError);
      expect(store.snapshot()).toEqual({});
    });

    it('uses JSON.stringify omission and coercion semantics without normalizing stored values', () => {
      const store = new InMemoryContextStore<QuotaShared>({}, { stepName: 'json-semantics' });
      const date = new Date('2026-08-24T00:00:00.000Z');
      const value = {
        omitted: undefined,
        functionValue: () => 'ignored',
        symbolValue: Symbol('ignored'),
        date,
        notANumber: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
      };

      store.set('value', value);

      expect(store.get('value')).toBe(value);
      expect(JSON.parse(JSON.stringify(store.snapshot()))).toEqual({
        value: {
          date: date.toISOString(),
          notANumber: null,
          infinity: null,
        },
      });
    });

    it('uses a stable fallback step name for legacy direct construction', () => {
      const store = new InMemoryContextStore<QuotaShared>();

      expect(() => store.set('value', BigInt(1))).toThrow(expect.objectContaining({ stepName: '(unknown step)' }));
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Error hierarchy
// ---------------------------------------------------------------------------

describe('error hierarchy', () => {
  it('UnknownStepError is a AgentError', () => {
    const e = new UnknownStepError('foo');
    expect(e).toBeInstanceOf(AgentError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('UnknownStepError');
    expect(e.stepName).toBe('foo');
    expect(e.message).toContain('foo');
  });

  it('StepInputValidationError is a AgentError and carries issues', () => {
    // Use a minimal $ZodIssue-compatible object cast to the constructor's expected type
    const fakeIssues = [
      { path: ['name'], message: 'Required', code: 'invalid_type' },
    ] as unknown as ConstructorParameters<typeof StepInputValidationError>[1];
    const e = new StepInputValidationError('myStep', fakeIssues);
    expect(e).toBeInstanceOf(AgentError);
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
