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

  it('does not let normalization corrupt an author default that looks like a schema', () => {
    const payload = {
      properties: { a: { type: 'string', default: 'x' } },
      required: ['a'],
      additionalProperties: false,
    };
    const schema = {
      type: 'object',
      properties: { childSchema: { type: 'object', default: payload } },
    };
    // The gate must still validate against the SCHEMA, not the payload inside it.
    expect(accepts(schema, { childSchema: { anything: true } })).toBe(true);
    expect(accepts(schema, { childSchema: 'not-an-object' })).toBe(false);
  });

  it('is a no-op for a step that declares no schema', () => {
    expect(accepts(null, { anything: true })).toBe(true);
  });
});
