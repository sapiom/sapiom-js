import { StepInputValidationError } from '@sapiom/agent';

import { validateManifestStepInput } from './manifest-validation.js';

/**
 * A step-input JSON Schema shaped like `z.toJSONSchema()` output for
 * `z.object({ title, options: z.object({ tone: z.string().default('formal') }) })`.
 * The nested `tone` carries a `default` yet is listed in the nested `required` —
 * exactly what an older SDK (which relaxed only the top level) would emit into a
 * manifest. Written as a literal so the test exercises the runtime pre-check's
 * own relaxation, not `buildManifest`'s.
 */
function schemaWithNestedDefaultedRequired(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      options: {
        type: 'object',
        properties: {
          tone: { type: 'string', default: 'formal' },
        },
        required: ['tone'],
        additionalProperties: false,
      },
    },
    required: ['title', 'options'],
    additionalProperties: false,
  };
}

describe('validateManifestStepInput', () => {
  it('accepts input omitting a nested field that carries a default (pre-check must not be stricter than Zod)', () => {
    const schema = schemaWithNestedDefaultedRequired();
    // Zod would supply `tone: 'formal'` here — the pre-check must let it through.
    expect(() =>
      validateManifestStepInput('start', schema, { title: 'hello', options: {} }),
    ).not.toThrow();
  });

  it('still rejects a genuinely missing nested field that has no default', () => {
    const schema = schemaWithNestedDefaultedRequired();
    // `title` has no default, so omitting it is a real error — relaxation is narrow.
    expect(() =>
      validateManifestStepInput('start', schema, { options: {} }),
    ).toThrow(StepInputValidationError);
  });

  it('is a no-op when the schema is null', () => {
    expect(() => validateManifestStepInput('start', null, { anything: true })).not.toThrow();
  });
});
