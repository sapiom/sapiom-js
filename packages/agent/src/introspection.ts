// `zod/v4` subpath (present in zod 3.25.x AND zod 4.x): gives `z.toJSONSchema`
// while the `zod` peer can resolve to v3 or v4, so the engine (zod 3.25) and
// external zod-4 authors can both consume this package.
import { z } from 'zod/v4';

import type { AgentDefinition } from './agent.js';

/**
 * The input contract of a step, derived from its `inputSchema`. For the entry
 * step this is the whole workflow's input contract (the admin "start a
 * workflow" form consumes it); for a `pause_until_signal` resume step it's the
 * contract of the resume payload (the admin "resume" form consumes it). Both
 * pre-fill + validate an otherwise-opaque JSON editor.
 */
export interface StepInputContract {
  /** JSON Schema (draft 2020-12) of the step's input. */
  readonly jsonSchema: Record<string, unknown>;
  /**
   * A prefill value for the input editor. Prefers an author-provided
   * runnable example (`schema.meta({ examples: [{ … }] })`) so the
   * operator can start it as-is; falls back to a type-correct skeleton
   * (`""` / `0` / `false` / first-enum-value / `[]`) when the schema
   * declares no example — that gives the right SHAPE but its placeholder
   * values may not satisfy refinements like `.positive()`, so the
   * operator edits before running.
   */
  readonly example: unknown;
}

/**
 * @deprecated Use {@link StepInputContract}. Retained as an alias because the
 * entry-step contract and a resume-step contract are the same shape.
 */
export type AgentInputContract = StepInputContract;

/**
 * Convert a Zod schema to the JSON Schema of what a CALLER MAY SEND.
 *
 * Used by the manifest generator (build phase, sandbox), by the input-contract
 * helpers below, and by engine tooling. Every consumer of this function
 * describes an input — a step's `inputSchema` — so the conversion is done in
 * Zod's `io: "input"` mode and then normalized by
 * {@link normalizeInputJsonSchema}. See both for why.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `io: "input"` describes the value a caller SENDS rather than the value a
  // parse RETURNS. Three consequences, all of them what an input contract
  // wants:
  //   - a field with `.default()` / `.prefault()` / `.catch()` is not listed in
  //     `required` (at every depth), because omitting it is legal — Zod
  //     supplies the value on parse;
  //   - a `.pipe()` / `.transform()` is described by its INPUT type, so the
  //     pre-gate checks what was actually sent (and `.transform()` no longer
  //     throws "Transforms cannot be represented in JSON Schema" at build);
  //   - plain `z.object()` is not emitted as closed, matching its
  //     strip-not-reject parse.
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return normalizeInputJsonSchema(jsonSchema);
}

/**
 * Normalize an already-converted input JSON Schema so it accepts exactly what
 * the Zod schema behind it parses. Pure JSON in, pure JSON out — no Zod
 * involved, so a caller that must run `z.toJSONSchema` with its own Zod module
 * instance (the engine does, to keep `.meta()` registry lookups on one
 * instance) can still share this normalization, and so can a pre-gate holding
 * only a stored manifest.
 *
 * Two rules, applied to every schema node reachable from the root:
 *
 * 1. Drop `additionalProperties: false`. `z.strictObject()` still emits it in
 *    input mode, and an AJV pre-gate that rejects unnamed fields is stricter
 *    than the authoritative Zod parse downstream — including for additive
 *    fields an upstream layer adds that the author does not control. A typed
 *    catchall (`additionalProperties: { … }`) is preserved.
 *
 * 2. Drop from `required` any key whose `properties` entry declares a
 *    `default`. A caller may omit such a field, so reporting it missing makes a
 *    PARTIAL input stricter than an omitted one (SAP-3218). `io: "input"`
 *    already does this, so for a freshly converted schema this rule is an
 *    invariant guard rather than the load-bearing mechanism. It IS load-bearing
 *    for a schema converted in output mode, and for a manifest built by an
 *    older SDK that a pre-gate has to normalize without a redeploy.
 */
export function normalizeInputJsonSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeSchemaNode(jsonSchema) as Record<string, unknown>;
}

// The traversal is STRUCTURAL, not a blind deep walk: it descends only through
// keywords whose values are subschemas. That matters because several JSON
// Schema keywords carry arbitrary CALLER DATA — `default`, `const`, `enum`,
// `examples`, `example` — and an author's default or example may itself be a
// JSON-Schema-shaped object (an agent whose input IS a schema is a real case).
// A blind walk applies both rules to that payload and silently rewrites it:
// a `default` of `{ properties: …, required: ["a"], additionalProperties: false }`
// would come back with `required: []` and no `additionalProperties`. Anything
// not listed below is copied through untouched, payload and validation
// keywords alike.
//
// The inverse hazard is why this cannot instead be a blind walk that skips
// payload KEYS: inside a `properties` map, a property may legitimately be
// NAMED `default` or `required`, and its value is a real subschema that must
// be normalized. Only position — not name — distinguishes the two.

/** Keywords whose value is a single subschema (or, pre-2020-12, a list of them). */
const SUBSCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** Keywords whose value is a map of name → subschema. */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSchemaNode(value: unknown): unknown {
  // A boolean schema (`true` / `false`) and any non-object are already final.
  if (!isPlainObject(value)) return value;

  const node = value;
  const out: Record<string, unknown> = {};
  for (const [keyword, v] of Object.entries(node)) {
    // Rule 1. `additionalProperties` is the one keyword that is either a
    // boolean constraint or a subschema, so it is handled before the rest.
    if (keyword === 'additionalProperties') {
      if (v === false) continue;
      out[keyword] = isPlainObject(v) ? normalizeSchemaNode(v) : v;
      continue;
    }
    // Rule 2.
    if (keyword === 'required' && Array.isArray(v)) {
      out[keyword] = dropDefaultedKeys(v, node.properties);
      continue;
    }
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = Array.isArray(v) ? v.map(normalizeSchemaNode) : normalizeSchemaNode(v);
      continue;
    }
    if (SUBSCHEMA_LIST_KEYWORDS.has(keyword)) {
      out[keyword] = Array.isArray(v) ? v.map(normalizeSchemaNode) : v;
      continue;
    }
    if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isPlainObject(v)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v)) {
        mapped[name] = normalizeSchemaNode(sub);
      }
      out[keyword] = mapped;
      continue;
    }
    out[keyword] = v;
  }
  return out;
}

/**
 * Filter a `required` array down to the keys the caller must actually supply:
 * a key whose sibling `properties` entry declares a `default` may be omitted.
 * Non-string entries and keys with no `properties` entry are left alone.
 */
function dropDefaultedKeys(required: unknown[], properties: unknown): unknown[] {
  if (!isPlainObject(properties)) {
    return required;
  }
  return required.filter((key) => {
    if (typeof key !== 'string') return true;
    const prop = properties[key];
    return !(isPlainObject(prop) && 'default' in prop);
  });
}

/**
 * Describe a named step's input contract for tooling. Returns null when the
 * step doesn't exist or declares no schema (the step accepts opaque input; the
 * form falls back to a free editor).
 */
export function stepInputContract(
  def: AgentDefinition<unknown, Record<string, unknown>>,
  stepName: string,
): StepInputContract | null {
  const schema = def.steps[stepName]?.inputSchema;
  if (!schema) return null;

  const jsonSchema = zodToJsonSchema(schema);
  return { jsonSchema, example: exampleFromJsonSchema(jsonSchema) };
}

/**
 * Describe a workflow's input contract for tooling.
 *
 * The entry step's `inputSchema` IS the workflow's input contract — the
 * entry step receives whatever the caller passes to `run`/`createExecution`.
 * Returns null when the entry step declares no schema (the workflow
 * accepts opaque input; the form falls back to a free editor).
 */
export function workflowInputContract(
  def: AgentDefinition<unknown, Record<string, unknown>>,
): StepInputContract | null {
  return stepInputContract(def, def.entry);
}

/**
 * Prefer an author-declared example (`.meta({ examples: [...] })` →
 * JSON Schema `examples`, or singular `example`) — it's meant to be
 * runnable as-is. Fall back to a generated type-skeleton otherwise.
 *
 * Exported so engine/tooling can call it after converting a schema with
 * their own `z.toJSONSchema` (avoiding cross-module-instance issues).
 */
export function exampleFromJsonSchema(jsonSchema: Record<string, unknown>): unknown {
  const examples = jsonSchema.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0];
  }
  if ('example' in jsonSchema && jsonSchema.example !== undefined) {
    return jsonSchema.example;
  }
  return skeletonFromJsonSchema(jsonSchema);
}

/**
 * Walk a JSON Schema and emit a placeholder value of the right type.
 * Covers the shapes our input schemas produce (flat objects of scalars +
 * enums + nested objects/arrays). Unknown shapes fall back to null —
 * a placeholder the operator edits, never a crash.
 */
function skeletonFromJsonSchema(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(branches) && branches.length > 0) {
    return skeletonFromJsonSchema(branches[0]);
  }

  switch (schema.type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        out[key] = skeletonFromJsonSchema(value);
      }
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}
