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
 * Convert a Zod schema to its JSON Schema representation.
 * Used by the manifest generator (build phase, sandbox) and by engine tooling.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
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
