/**
 * The pre-gate normalizes the schema it is handed, so a manifest BUILT before
 * the generator was fixed still accepts a partial input (SAP-3218) with no
 * redeploy.
 *
 * Schemas here are written as literal JSON on purpose: they stand in for a
 * stored manifest read back from the engine, which is exactly what this gate
 * receives. (Constructing them with Zod would also load a second Zod module
 * instance through the SDK's CJS build, which this package's test environment
 * cannot do.)
 *
 * Nothing here asserts that normalization leaves an author's `default` payload
 * intact, even though this gate normalizes: AJV is built without `useDefaults`,
 * so `default` is annotation-only and cannot change a verdict. Any assertion
 * made through this gate would pass whether or not the payload was rewritten.
 * That property is tested where it is observable — against the emitted schema,
 * in `@sapiom/agent`'s `introspection.spec.ts`.
 */
import { StepInputValidationError } from '@sapiom/agent';
import Ajv2020 from 'ajv/dist/2020.js';

import { validateManifestStepInput } from './manifest-validation';

/** A manifest as an older SDK published it: nested defaults left in `required`. */
const legacySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    opts: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', default: false },
        retries: { type: 'number', default: 3 },
      },
      required: ['verbose', 'retries'],
      additionalProperties: false,
    },
  },
  required: ['name', 'opts'],
  additionalProperties: false,
};

/** Whether the gate accepts `input` for `schema`. */
function accepts(schema: Record<string, unknown> | null, input: unknown): boolean {
  try {
    validateManifestStepInput('step', schema, input);
    return true;
  } catch {
    return false;
  }
}

describe('validateManifestStepInput', () => {
  it('accepts a partial nested input against a manifest built by an older SDK', () => {
    // The failing production shape: a coordinator sends part of the child's input.
    expect(accepts(legacySchema, { name: 'x', opts: {} })).toBe(true);
    expect(accepts(legacySchema, { name: 'x', opts: { verbose: true } })).toBe(true);
  });

  it('still rejects a field that is genuinely missing', () => {
    // Neither `name` nor `opts` itself carries a default.
    expect(accepts(legacySchema, { opts: {} })).toBe(false);
    expect(accepts(legacySchema, { name: 'x' })).toBe(false);
  });

  it('still rejects a wrongly-typed value inside a nested object', () => {
    expect(accepts(legacySchema, { name: 'x', opts: { retries: 'many' } })).toBe(false);
  });

  it('accepts unknown extra fields (the Zod parse strips rather than rejects them)', () => {
    expect(accepts(legacySchema, { name: 'x', opts: {}, addedUpstream: 1 })).toBe(true);
  });

  it('is a no-op for a step that declares no schema', () => {
    expect(accepts(null, { anything: true })).toBe(true);
  });
});

describe('validateManifestStepInput: memory (SAP-3671)', () => {
  afterEach(() => jest.restoreAllMocks());

  // Track both schema and generated-validator retention to detect leaks in either store (SAP-3671).
  type AjvInternals = { _cache: Map<unknown, unknown>; scope: { get(): { validate?: unknown[] } } };
  const footprint = (ajv: AjvInternals) => ({
    cache: ajv._cache.size,
    validators: ajv.scope.get().validate?.length ?? 0,
  });

  it('does not grow the long-lived instance across calls', () => {
    const metaSpy = jest.spyOn(Ajv2020.prototype, 'validateSchema');
    validateManifestStepInput('step', structuredClone(legacySchema), { name: 'x', opts: {} });
    const longLived = metaSpy.mock.instances[0] as unknown as AjvInternals;
    const before = footprint(longLived);

    const compileSpy = jest.spyOn(Ajv2020.prototype, 'compile');
    for (let i = 0; i < 500; i++) {
      validateManifestStepInput('step', structuredClone(legacySchema), { name: 'x', opts: {} });
    }

    expect(compileSpy).toHaveBeenCalledTimes(500);
    expect(compileSpy.mock.instances).not.toContain(longLived);
    expect(footprint(longLived)).toEqual(before);
  });

  it('still throws `schema is invalid` for a malformed schema', () => {
    const malformed = { type: 'object', properties: { x: { type: 'nope' } } };
    let thrown: unknown;
    try {
      validateManifestStepInput('step', malformed, { x: 1 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(StepInputValidationError);
    expect((thrown as Error).message).toMatch(
      /^schema is invalid: data\/properties\/x\/type must be equal to one of the allowed values/,
    );
  });

  it('keeps verdicts independent across calls', () => {
    const run = (input: unknown) => () => validateManifestStepInput('step', structuredClone(legacySchema), input);
    expect(run({ name: 'x', opts: {} })).not.toThrow();
    expect(run({ name: 1, opts: {} })).toThrow(StepInputValidationError);
    expect(run({ name: 'x', opts: {} })).not.toThrow();
  });

  it('ignores `format` without warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(accepts({ type: 'string', format: 'email' }, 'not-an-email')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
