/**
 * End-to-end proof for the schema a deployed agent PUBLISHES (SAP-3218):
 * every input the step's Zod schema parses must pass an AJV gate compiled from
 * the manifest's `inputSchema`. The engine runs exactly such a gate before it
 * pays for a sandbox dispatch, so a schema that is stricter than the Zod parse
 * behind it rejects a run that would otherwise have succeeded.
 *
 * The regression pinned here: a defaulted field nested inside an object stayed
 * in that object's `required` array, so a PARTIAL input (`{ opts: {} }`) was
 * rejected while an entirely omitted one passed — the opposite of the authoring
 * guidance that a default makes a field omissible. A coordinator sending
 * partial input to a child agent hit this in production.
 *
 * AJV is configured the way both pre-gates configure it (`ajv/dist/2020` for
 * the 2020-12 meta-schema `z.toJSONSchema` emits, `strict: false`), and the
 * gates additionally strip `additionalProperties: false` — which
 * `zodToJsonSchema` has already done here.
 */
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod/v4';

import { defineAgent } from './agent.js';
import { buildManifest } from './build-manifest.js';
import { terminate } from './directives.js';
import { defineStep } from './step.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });

const ARTIFACT = { sha256: `sha256:${'0'.repeat(64)}`, entryFile: 'index.js' };

/** The manifest `inputSchema` a deployed agent would publish for `inputSchema`. */
function publishedSchema(inputSchema: z.ZodType): Record<string, unknown> {
  const def = defineAgent({
    name: 'wf',
    entry: 'step',
    steps: {
      step: defineStep({
        name: 'step',
        next: [],
        terminal: true,
        inputSchema,
        async run() {
          return terminate(null);
        },
      }),
    },
  });
  const manifest = buildManifest(def, { sdkVersion: '0.0.0-test', artifact: ARTIFACT });
  return manifest.steps.step.inputSchema!;
}

/** Whether the published schema's AJV gate accepts `input`. */
function gateAccepts(inputSchema: z.ZodType, input: unknown): boolean {
  return ajv.compile(publishedSchema(inputSchema))(input) === true;
}

/** Whether the authoritative Zod parse accepts `input`. */
function zodAccepts(inputSchema: z.ZodType, input: unknown): boolean {
  return inputSchema.safeParse(input).success;
}

describe("the published inputSchema's AJV gate", () => {
  const nested = z.object({
    name: z.string(),
    opts: z.object({ verbose: z.boolean().default(false), retries: z.number().default(3) }),
  });

  it('accepts a partial nested input whose omitted fields are defaulted', () => {
    for (const input of [
      { name: 'x', opts: {} },
      { name: 'x', opts: { verbose: true } },
      { name: 'x', opts: { retries: 1 } },
    ]) {
      expect(zodAccepts(nested, input)).toBe(true);
      expect(gateAccepts(nested, input)).toBe(true);
    }
  });

  it('still rejects a genuinely missing required field', () => {
    // Neither `name` nor the `opts` object itself carries a default.
    for (const input of [{ opts: {} }, { name: 'x' }, {}]) {
      expect(zodAccepts(nested, input)).toBe(false);
      expect(gateAccepts(nested, input)).toBe(false);
    }
  });

  it('still rejects a wrongly-typed value inside a nested object', () => {
    const input = { name: 'x', opts: { retries: 'many' } };
    expect(zodAccepts(nested, input)).toBe(false);
    expect(gateAccepts(nested, input)).toBe(false);
  });

  it('accepts an empty input when every top-level field is defaulted', () => {
    // The authoring guidance is "put a default on every field so a zero-input
    // run validates" — and a partial input must never be stricter than that.
    const allDefaulted = z.object({
      topic: z.string().default('demo'),
      opts: z.object({ verbose: z.boolean().default(false) }).default({ verbose: false }),
    });
    expect(gateAccepts(allDefaulted, {})).toBe(true);
    expect(gateAccepts(allDefaulted, { opts: {} })).toBe(true);
  });

  it('accepts array items that omit their defaulted fields', () => {
    const rows = z.object({
      rows: z.array(z.object({ id: z.string(), retries: z.number().default(3) })),
    });
    expect(gateAccepts(rows, { rows: [{ id: 'a' }] })).toBe(true);
    // `id` has no default, so an item missing it is still rejected.
    expect(gateAccepts(rows, { rows: [{}] })).toBe(false);
  });

  it('accepts an omitted .prefault() field', () => {
    const prefaulted = z.object({ id: z.string(), region: z.string().prefault('us-east-1') });
    expect(zodAccepts(prefaulted, { id: 'a' })).toBe(true);
    expect(gateAccepts(prefaulted, { id: 'a' })).toBe(true);
  });

  it('accepts a union branch that omits its defaulted field', () => {
    const union = z.union([
      z.object({ kind: z.literal('a'), depth: z.number().default(1) }),
      z.object({ kind: z.literal('b'), tag: z.string() }),
    ]);
    expect(gateAccepts(union, { kind: 'a' })).toBe(true);
    expect(gateAccepts(union, { kind: 'b' })).toBe(false);
  });

  it('accepts unknown extra fields (the Zod parse strips rather than rejects them)', () => {
    const input = { name: 'x', opts: {}, extra: 1 };
    expect(zodAccepts(nested, input)).toBe(true);
    expect(gateAccepts(nested, input)).toBe(true);
  });
});
