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
