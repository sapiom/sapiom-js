// `zod/v4` subpath (present in zod 3.25.x AND zod 4.x): the v4 `ZodType` surface
// while the `zod` peer can resolve to v3 or v4. See step.ts / introspection.ts.
import type { ZodType } from 'zod/v4';

import { UnknownStepError } from './errors.js';
import type { StepDefinition } from './step.js';

/**
 * Brand symbol for AgentDefinition objects produced by `defineAgent`.
 *
 * Attached as a non-enumerable property so it survives bundling + dynamic
 * import without polluting the object's visible shape. The value is the
 * protocol version (1); bump if the definition contract changes.
 *
 * Use `isAgentDefinition(val)` to check the brand — never duck-type on
 * name/entry/steps because those keys are also valid plain data objects.
 */
export const AGENT_DEFINITION_BRAND = Symbol.for('sapiom.models.definition');

/**
 * A workflow definition: a name, an entry step, and a name → step map.
 *
 * Generics:
 *   - TInput:  the type of the value passed to the entry step on `runner.run(def, input, ...)`
 *   - TShared: the named-slots shape for cross-step values; ctx.shared is typed by this
 *
 * Agent authors write:
 *
 *   interface CycleShared {
 *     summary: SummaryOutput;
 *     monitoring: MonitoringSnapshot;
 *   }
 *
 *   export const cycleAgent = defineAgent<{ companyId: number }, CycleShared>({
 *     name: 'cycle',
 *     entry: 'gather',
 *     steps: { gather, summarize, ... },
 *   });
 *
 * The input contract can instead be declared once, at the agent level, via
 * `inputSchema` — `TInput` is then inferred from it (no explicit generic
 * needed) and `defineAgent` folds it onto the entry step:
 *
 *   export const cycleAgent = defineAgent({
 *     name: 'cycle',
 *     entry: 'gather',
 *     inputSchema: z.object({ companyId: z.number() }),
 *     steps: { gather, summarize, ... },
 *   });
 *
 * Steps inside `steps` are typed Step<unknown, unknown, TShared>. The
 * primitive doesn't (and can't) statically enforce that each step's TIn
 * matches its predecessor's TOut — that's a design tradeoff for the
 * "dynamic next directive" capability. Step authors maintain the chain
 * by convention; runtime mismatches surface as the step's own TS
 * narrowing at the top of run().
 */
export interface AgentDefinition<
  TInput = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  /** Human-authored workflow summary for the canvas Overview panel (Option A —
   *  deterministic, no LLM). */
  readonly description?: string;
  readonly entry: string;
  /**
   * Optional agent-level input contract — the one obvious place to declare
   * "what this agent takes". When the entry step declares no `inputSchema`,
   * `defineAgent` folds this schema onto it, so the manifest's entry step
   * carries the JSON Schema and the dashboard renders its fields. Declaring it
   * here AND on the entry step (as a *different* schema) is a build error —
   * declare the contract once.
   *
   * Typed `ZodType<TInput>` so the `defineAgent<TInput>` generic (hence the
   * `run(def, input)` call site) is inferred from the same runtime schema that
   * becomes the contract — the TS annotation and the runtime validation cannot
   * drift apart (SAP-2226).
   */
  readonly inputSchema?: ZodType<TInput>;
  readonly steps: Readonly<Record<string, StepDefinition<TShared>>>;
  /**
   * Phantom marker that carries the entry-step input type so `runner.run(def, input)`
   * can infer it (see TInput in the doc above). The steps map is deliberately
   * type-erased, leaving TInput no structural home — this is its anchor. Never
   * assigned at runtime; do not read it.
   */
  readonly __inputType?: TInput;
}

/**
 * Type guard that checks the `AGENT_DEFINITION_BRAND` symbol set by
 * `defineAgent`. Use this (not duck-typing on name/entry/steps) to
 * detect workflow definitions among module exports.
 *
 * Example:
 *   const mod = await import(bundleUrl);
 *   const defs = Object.values(mod).filter(isAgentDefinition);
 */
export function isAgentDefinition(val: unknown): val is AgentDefinition {
  if (val === null || typeof val !== 'object') return false;
  return (val as Record<symbol, unknown>)[AGENT_DEFINITION_BRAND] === 1;
}

/**
 * The brand `@sapiom/orchestration`'s `defineOrchestration` attached before
 * the agents/models rename (cc1261e). Projects still on that SDK carry this
 * symbol instead of `AGENT_DEFINITION_BRAND`; the definition shape itself is
 * unchanged by the rename (same name/entry/steps, same step runtime
 * properties), so a legacy-branded definition is safe to feed to
 * `buildManifest` as-is.
 */
export const LEGACY_ORCHESTRATION_DEFINITION_BRAND = Symbol.for('sapiom.orchestration.definition');

/**
 * Type guard for definitions produced by the pre-rename SDK's
 * `defineOrchestration`. Tooling that inspects arbitrary customer projects
 * (e.g. `@sapiom/agent-core`'s `check()`) accepts either brand so workflows
 * authored against the old SDK keep working without a dependency bump.
 */
export function isLegacyOrchestrationDefinition(val: unknown): val is AgentDefinition {
  if (val === null || typeof val !== 'object') return false;
  return (val as Record<symbol, unknown>)[LEGACY_ORCHESTRATION_DEFINITION_BRAND] === 1;
}

/**
 * Validate and return a workflow definition. Checks done here:
 *   1. `name` is non-empty
 *   2. `entry` exists in `steps`
 *   3. Every step in `steps` is non-null and the map key matches `step.name`
 *   4. If an agent-level `inputSchema` is declared, fold it onto the entry step
 *      (build error if the entry step declares a *different* one) — see below.
 *
 * When `inputSchema` is declared at the agent level and the entry step declares
 * none, the agent-level schema BECOMES the entry step's `inputSchema`. This
 * keeps a single source of truth for the input contract while leaving every
 * downstream consumer (`buildManifest`, `workflowInputContract`,
 * `stepInputContract`) unchanged — they still read `steps[entry].inputSchema`,
 * which now carries it. Declaring a *different* schema in both places is a
 * conflict and throws; declaring the identical schema object in both is allowed.
 *
 * Attaches a non-enumerable brand symbol (`AGENT_DEFINITION_BRAND`) so
 * the object can be detected by `isAgentDefinition` after bundling +
 * dynamic import without relying on duck-typed property names.
 *
 * Static validation of every `continue` target is intentionally NOT
 * done — most are computed at runtime inside `run()`. PR review is the
 * gate for "did you reference a step that doesn't exist."
 */
export function defineAgent<TInput = unknown, TShared extends Record<string, unknown> = Record<string, unknown>>(
  def: AgentDefinition<TInput, TShared>,
): AgentDefinition<TInput, TShared> {
  if (!def.name) {
    throw new Error('Agent definition must have a non-empty name');
  }
  if (!def.entry) {
    throw new Error(`Agent '${def.name}' must declare an entry step`);
  }
  if (!def.steps[def.entry]) {
    throw new UnknownStepError(def.entry);
  }
  for (const [key, step] of Object.entries(def.steps)) {
    if (!step) {
      throw new Error(`Agent '${def.name}' has null/undefined step at key '${key}'`);
    }
    if (step.name !== key) {
      throw new Error(`Agent '${def.name}' step name mismatch at key '${key}': step.name='${step.name}'`);
    }
  }
  // Fold the agent-level input contract onto the entry step (see the doc above).
  if (def.inputSchema) {
    const entryStep = def.steps[def.entry];
    if (entryStep.inputSchema && entryStep.inputSchema !== def.inputSchema) {
      throw new Error(
        `Agent '${def.name}' declares a different inputSchema at the agent level and on its entry step '${def.entry}'. ` +
          `Declare the input contract once and reference that single schema object in both places (or remove one).`,
      );
    }
    if (!entryStep.inputSchema) {
      // The entry step declared no schema: the agent-level contract becomes it.
      // Copy-on-write — build a FRESH steps map with a fresh entry step rather
      // than mutating the caller's (Readonly) `steps` object in place. Mutating
      // it would corrupt a `steps` literal shared across two `defineAgent` calls
      // (the first fold would rewrite the second's entry step) and would throw on
      // an `Object.freeze()`d map. The step's `run` and routing declarations are
      // carried over by the spread, so downstream readers of
      // `steps[entry].inputSchema` pick up the contract without special-casing.
      def = {
        ...def,
        steps: {
          ...def.steps,
          [def.entry]: { ...entryStep, inputSchema: def.inputSchema as ZodType<unknown> },
        },
      } as AgentDefinition<TInput, TShared>;
    }
  }
  // Attach the brand as a non-enumerable property so it:
  //   - survives esbuild bundling (symbol properties pass through)
  //   - survives dynamic import (the imported object is the same reference)
  //   - doesn't pollute JSON.stringify or for...in iteration
  const result = { ...def } as AgentDefinition<TInput, TShared>;
  Object.defineProperty(result, AGENT_DEFINITION_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}
