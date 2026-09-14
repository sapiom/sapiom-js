import { z } from 'zod/v4';
import { describe, expect, it } from 'vitest';

import { exampleFromJsonSchema } from './introspection.js';

describe('exampleFromJsonSchema (skeleton fallback)', () => {
  it('produces a type-appropriate placeholder for a nullable string field', () => {
    // z.string().nullable() -> JSON Schema { type: ["string", "null"] }
    const schema = z.toJSONSchema(z.object({ name: z.string().nullable() }));

    expect(exampleFromJsonSchema(schema)).toEqual({ name: '' });
  });

  it('produces a type-appropriate placeholder for a nullable number field', () => {
    const schema = z.toJSONSchema(z.object({ count: z.number().nullable() }));

    expect(exampleFromJsonSchema(schema)).toEqual({ count: 0 });
  });

  it('produces a type-appropriate placeholder for a nullable boolean field', () => {
    const schema = z.toJSONSchema(z.object({ active: z.boolean().nullable() }));

    expect(exampleFromJsonSchema(schema)).toEqual({ active: false });
  });

  it('handles the raw type-union shape directly (not just via zod)', () => {
    expect(exampleFromJsonSchema({ type: ['string', 'null'] })).toBe('');
    expect(exampleFromJsonSchema({ type: ['number', 'null'] })).toBe(0);
    expect(exampleFromJsonSchema({ type: ['null', 'boolean'] })).toBe(false);
  });

  it('still returns null for a schema that is only ever null', () => {
    expect(exampleFromJsonSchema({ type: 'null' })).toBe(null);
    expect(exampleFromJsonSchema({ type: ['null'] })).toBe(null);
  });
});
