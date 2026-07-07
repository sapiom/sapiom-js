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
  readonly entry: string;
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
 * Validate and return a workflow definition. Checks done here:
 *   1. `name` is non-empty
 *   2. `entry` exists in `steps`
 *   3. Every step in `steps` is non-null and the map key matches `step.name`
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
  // Attach the brand as a non-enumerable property so it:
  //   - survives esbuild bundling (symbol properties pass through)
  //   - survives dynamic import (the imported object is the same reference)
  //   - doesn't pollute JSON.stringify or for...in iteration
  Object.defineProperty(def, AGENT_DEFINITION_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return def;
}
