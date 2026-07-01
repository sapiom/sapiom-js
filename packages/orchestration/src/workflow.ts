import { UnknownStepError } from './errors.js';
import type { SecretBinding } from './manifest.js';
import type { StepDefinition } from './step.js';

/**
 * Brand symbol for OrchestrationDefinition objects produced by `defineOrchestration`.
 *
 * Attached as a non-enumerable property so it survives bundling + dynamic
 * import without polluting the object's visible shape. The value is the
 * protocol version (1); bump if the definition contract changes.
 *
 * Use `isOrchestrationDefinition(val)` to check the brand — never duck-type on
 * name/entry/steps because those keys are also valid plain data objects.
 */
export const ORCHESTRATION_DEFINITION_BRAND = Symbol.for('sapiom.orchestration.definition');

/**
 * A workflow definition: a name, an entry step, and a name → step map.
 *
 * Generics:
 *   - TInput:  the type of the value passed to the entry step on `runner.run(def, input, ...)`
 *   - TShared: the named-slots shape for cross-step values; ctx.shared is typed by this
 *
 * Workflow authors write:
 *
 *   interface CycleShared {
 *     summary: SummaryOutput;
 *     monitoring: MonitoringSnapshot;
 *   }
 *
 *   export const cycleWorkflow = defineOrchestration<{ companyId: number }, CycleShared>({
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
export interface OrchestrationDefinition<
  TInput = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  readonly entry: string;
  readonly steps: Readonly<Record<string, StepDefinition<TShared>>>;
  /** Vault secret bindings the orchestration needs; injected into step env at dispatch. */
  readonly secrets?: readonly SecretBinding[];
  /**
   * Phantom marker that carries the entry-step input type so `runner.run(def, input)`
   * can infer it (see TInput in the doc above). The steps map is deliberately
   * type-erased, leaving TInput no structural home — this is its anchor. Never
   * assigned at runtime; do not read it.
   */
  readonly __inputType?: TInput;
}

/**
 * Type guard that checks the `ORCHESTRATION_DEFINITION_BRAND` symbol set by
 * `defineOrchestration`. Use this (not duck-typing on name/entry/steps) to
 * detect workflow definitions among module exports.
 *
 * Example:
 *   const mod = await import(bundleUrl);
 *   const defs = Object.values(mod).filter(isOrchestrationDefinition);
 */
export function isOrchestrationDefinition(val: unknown): val is OrchestrationDefinition {
  if (val === null || typeof val !== 'object') return false;
  return (val as Record<symbol, unknown>)[ORCHESTRATION_DEFINITION_BRAND] === 1;
}

/**
 * Validate an orchestration's optional secret bindings: each binding's `ref` and
 * every `keys` entry must match the vault charset. Extracted from
 * `defineOrchestration` to keep its cognitive complexity within bounds.
 */
function validateSecretsDeclaration(def: { name: string; secrets?: readonly SecretBinding[] }): void {
  if (def.secrets === undefined) return;
  const refPattern = /^[A-Za-z0-9._:-]+$/;
  const keyPattern = /^[A-Za-z0-9._-]+$/;
  for (const binding of def.secrets) {
    if (!binding || typeof binding.ref !== 'string' || !refPattern.test(binding.ref)) {
      throw new Error(
        `Workflow '${def.name}' has an invalid secret binding ref: '${binding?.ref}' (must match /^[A-Za-z0-9._:-]+$/)`,
      );
    }
    for (const key of binding.keys ?? []) {
      if (typeof key !== 'string' || key.length === 0 || !keyPattern.test(key)) {
        throw new Error(
          `Workflow '${def.name}' has an invalid secret key '${key}' in ref '${binding.ref}' (must match /^[A-Za-z0-9._-]+$/)`,
        );
      }
    }
  }
}

/**
 * Validate and return a workflow definition. Checks done here:
 *   1. `name` is non-empty
 *   2. `entry` exists in `steps`
 *   3. Every step in `steps` is non-null and the map key matches `step.name`
 *
 * Attaches a non-enumerable brand symbol (`ORCHESTRATION_DEFINITION_BRAND`) so
 * the object can be detected by `isOrchestrationDefinition` after bundling +
 * dynamic import without relying on duck-typed property names.
 *
 * Static validation of every `continue` target is intentionally NOT
 * done — most are computed at runtime inside `run()`. PR review is the
 * gate for "did you reference a step that doesn't exist."
 */
export function defineOrchestration<TInput = unknown, TShared extends Record<string, unknown> = Record<string, unknown>>(
  def: OrchestrationDefinition<TInput, TShared>,
): OrchestrationDefinition<TInput, TShared> {
  if (!def.name) {
    throw new Error('Workflow definition must have a non-empty name');
  }
  if (!def.entry) {
    throw new Error(`Workflow '${def.name}' must declare an entry step`);
  }
  if (!def.steps[def.entry]) {
    throw new UnknownStepError(def.entry);
  }
  for (const [key, step] of Object.entries(def.steps)) {
    if (!step) {
      throw new Error(`Workflow '${def.name}' has null/undefined step at key '${key}'`);
    }
    if (step.name !== key) {
      throw new Error(`Workflow '${def.name}' step name mismatch at key '${key}': step.name='${step.name}'`);
    }
  }
  validateSecretsDeclaration(def);
  // Attach the brand as a non-enumerable property so it:
  //   - survives esbuild bundling (symbol properties pass through)
  //   - survives dynamic import (the imported object is the same reference)
  //   - doesn't pollute JSON.stringify or for...in iteration
  Object.defineProperty(def, ORCHESTRATION_DEFINITION_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return def;
}
