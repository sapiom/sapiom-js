/**
 * Tests for the input-schema conversion + normalization shared by the manifest
 * generator and the input-contract helpers (SAP-3218).
 *
 * The invariant under test: the JSON Schema we PUBLISH (and display) must accept
 * every input the Zod schema behind it PARSES. A field carrying a Zod default
 * may be omitted, so it must not appear in `required` — at any depth. Before
 * this, only the top level was treated, which made a PARTIAL input stricter than
 * an entirely omitted one: `{ opts: {} }` was rejected while `{}` passed.
 */
import { z } from 'zod/v4';

import { defineAgent } from './agent.js';
import { terminate } from './directives.js';
import {
  normalizeInputJsonSchema,
  stepInputContract,
  workflowInputContract,
  zodToJsonSchema,
} from './introspection.js';
import { defineStep } from './step.js';

/** Read the `required` array of a schema node, or `[]` when it declares none. */
function requiredOf(node: unknown): string[] {
  return ((node as Record<string, unknown>)?.required as string[] | undefined) ?? [];
}

/** Walk to a nested property node by key path. */
function propAt(schema: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  let node = schema;
  for (const key of keys) {
    node = (node.properties as Record<string, Record<string, unknown>>)[key];
  }
  return node;
}

describe('zodToJsonSchema', () => {
  it('drops a NESTED defaulted field from required (SAP-3218)', () => {
    const schema = zodToJsonSchema(
      z.object({
        name: z.string(),
        opts: z.object({ verbose: z.boolean().default(false), label: z.string() }),
      }),
    );

    // The caller must still supply `name` and the `opts` object itself (neither
    // has a default), and `label` inside it…
    expect(requiredOf(schema)).toEqual(['name', 'opts']);
    expect(requiredOf(propAt(schema, 'opts'))).toEqual(['label']);
    // …but never `verbose`, which Zod fills in on parse.
    expect(propAt(schema, 'opts', 'verbose').default).toBe(false);
  });

  it('drops a defaulted field from required inside array items', () => {
    const schema = zodToJsonSchema(
      z.object({
        rows: z.array(z.object({ id: z.string(), retries: z.number().default(3) })),
      }),
    );

    const items = (propAt(schema, 'rows').items as Record<string, unknown>);
    expect(requiredOf(items)).toEqual(['id']);
  });

  it('drops a defaulted field from required inside a union branch', () => {
    const schema = zodToJsonSchema(
      z.union([
        z.object({ kind: z.literal('a'), depth: z.number().default(1) }),
        z.object({ kind: z.literal('b'), tag: z.string() }),
      ]),
    );

    const branches = schema.anyOf as Record<string, unknown>[];
    expect(requiredOf(branches[0])).toEqual(['kind']);
    expect(requiredOf(branches[1])).toEqual(['kind', 'tag']);
  });

  it('drops a defaulted field from required in an intersection branch', () => {
    const schema = zodToJsonSchema(
      z.object({ id: z.string() }).and(z.object({ retries: z.number().default(0) })),
    );

    const branches = schema.allOf as Record<string, unknown>[];
    expect(requiredOf(branches[0])).toEqual(['id']);
    expect(requiredOf(branches[1])).toEqual([]);
  });

  it('treats .prefault() like .default(): the field is optional and carries the value', () => {
    // Decided explicitly (SAP-3218): `.prefault()` substitutes its value for a
    // MISSING input before parsing, exactly like `.default()` from a caller's
    // point of view, so an omitted `region` is legal and must not be required.
    // (Unlike `.default()`, the prefault value is then parsed — irrelevant to
    // what a caller may send.) Output mode emits no `default` keyword for a
    // prefault at all, which is why it used to stay required.
    const schema = zodToJsonSchema(
      z.object({ id: z.string(), region: z.string().prefault('us-east-1') }),
    );

    expect(requiredOf(schema)).toEqual(['id']);
    expect(propAt(schema, 'region').default).toBe('us-east-1');
  });

  it('treats .catch() as optional too', () => {
    const schema = zodToJsonSchema(z.object({ mode: z.string().catch('auto') }));

    expect(requiredOf(schema)).toEqual([]);
    expect(propAt(schema, 'mode').default).toBe('auto');
  });

  it('describes a .transform() by its INPUT type instead of failing the build', () => {
    // Output mode throws "Transforms cannot be represented in JSON Schema";
    // an input contract only ever needs the pre-transform type.
    const schema = zodToJsonSchema(
      z.object({ csv: z.string().transform((s) => s.split(',')) }),
    );

    expect(propAt(schema, 'csv').type).toBe('string');
  });

  it('describes a .pipe() by the type the caller sends', () => {
    const schema = zodToJsonSchema(z.object({ n: z.string().pipe(z.coerce.number()) }));

    expect(propAt(schema, 'n').type).toBe('string');
  });

  it('strips additionalProperties:false at every depth, including z.strictObject()', () => {
    const schema = zodToJsonSchema(
      z.object({ opts: z.strictObject({ verbose: z.boolean().default(false) }) }),
    );

    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":false');
  });

  it('preserves a typed additionalProperties catchall', () => {
    const schema = zodToJsonSchema(z.object({ meta: z.record(z.string(), z.number()) }));

    expect(propAt(schema, 'meta').additionalProperties).toEqual({ type: 'number' });
  });

  it('preserves author-declared .meta() examples', () => {
    const schema = zodToJsonSchema(
      z.object({ topic: z.string() }).meta({ examples: [{ topic: 'demo' }] }),
    );

    expect(schema.examples).toEqual([{ topic: 'demo' }]);
  });

  it('leaves a non-defaulted schema unchanged apart from the closed-object marker', () => {
    const schema = zodToJsonSchema(z.object({ a: z.string(), b: z.number() }));

    expect(requiredOf(schema)).toEqual(['a', 'b']);
  });
});

describe('normalizeInputJsonSchema', () => {
  // The engine converts with its OWN zod module instance (to keep `.meta()`
  // registry lookups on one instance) and then reuses this normalizer, so it
  // has to fix up an output-mode schema on its own.
  it('normalizes an output-mode schema recursively', () => {
    const raw = z.toJSONSchema(
      z.object({ name: z.string(), opts: z.object({ verbose: z.boolean().default(false) }) }),
    ) as Record<string, unknown>;
    // Precondition: output mode is the broken shape this fixes.
    expect(requiredOf((raw.properties as Record<string, unknown>).opts)).toEqual(['verbose']);

    const normalized = normalizeInputJsonSchema(raw);

    expect(requiredOf(normalized)).toEqual(['name', 'opts']);
    expect(requiredOf(propAt(normalized, 'opts'))).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain('"additionalProperties":false');
  });

  it('does not mutate its input', () => {
    const raw = z.toJSONSchema(z.object({ n: z.number().default(1) })) as Record<string, unknown>;

    normalizeInputJsonSchema(raw);

    expect(raw.required).toEqual(['n']);
  });

  it('leaves a property literally named "required" or "additionalProperties" alone', () => {
    const schema = zodToJsonSchema(
      z.object({ required: z.array(z.string()), additionalProperties: z.boolean() }),
    );

    expect(requiredOf(schema)).toEqual(['required', 'additionalProperties']);
    expect(propAt(schema, 'required').type).toBe('array');
    expect(propAt(schema, 'additionalProperties').type).toBe('boolean');
  });

  // The traversal descends only through subschema keywords. `default`, `const`,
  // `enum`, `examples` and `example` carry arbitrary AUTHOR DATA, and an
  // author's default may itself be a JSON-Schema-shaped object — an agent whose
  // input IS a schema is a real case. Rewriting it would corrupt the value the
  // step receives and the value the Run form prefills.
  it('never rewrites a JSON-Schema-shaped default value', () => {
    const payload = {
      type: 'object',
      properties: { a: { type: 'string', default: 'x' } },
      required: ['a'],
      additionalProperties: false,
    };
    const schema = zodToJsonSchema(
      z.object({ childSchema: z.record(z.string(), z.unknown()).default(payload) }),
    );

    expect(propAt(schema, 'childSchema').default).toEqual(payload);
  });

  it('never rewrites a JSON-Schema-shaped .meta() example', () => {
    const example = {
      childSchema: { properties: { a: { default: 1 } }, required: ['a'], additionalProperties: false },
    };
    const schema = zodToJsonSchema(
      z.object({ childSchema: z.record(z.string(), z.unknown()) }).meta({ examples: [example] }),
    );

    expect(schema.examples).toEqual([example]);
  });

  it('normalizes a real subschema even when the property is NAMED like a keyword', () => {
    // Position, not name, decides: these are property VALUES, so they are
    // subschemas and both rules apply inside them.
    const schema = zodToJsonSchema(
      z.object({
        default: z.object({ nested: z.number().default(1) }),
        items: z.strictObject({ nested: z.number().default(2) }),
      }),
    );

    expect(requiredOf(propAt(schema, 'default'))).toEqual([]);
    expect(requiredOf(propAt(schema, 'items'))).toEqual([]);
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":false');
  });
});

describe('stepInputContract / workflowInputContract', () => {
  const inputSchema = z.object({
    name: z.string(),
    opts: z.object({ verbose: z.boolean().default(false) }),
  });

  const def = defineAgent({
    name: 'wf',
    entry: 'gather',
    steps: {
      gather: defineStep({
        name: 'gather',
        next: [],
        terminal: true,
        inputSchema,
        async run() {
          return terminate(null);
        },
      }),
    },
  });

  // The displayed contract has to agree with the schema the engine enforces —
  // both now come out of `zodToJsonSchema`.
  it('returns the same normalized schema the manifest publishes', () => {
    expect(stepInputContract(def, 'gather')?.jsonSchema).toEqual(zodToJsonSchema(inputSchema));
  });

  it('shows a nested defaulted field as optional', () => {
    const jsonSchema = workflowInputContract(def)!.jsonSchema;

    expect(requiredOf(propAt(jsonSchema, 'opts'))).toEqual([]);
  });

  it('returns null for an unknown step', () => {
    expect(stepInputContract(def, 'missing')).toBeNull();
  });
});
