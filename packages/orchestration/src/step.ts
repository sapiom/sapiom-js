// `zod/v4` subpath (zod 3.25.x): keeps the shared `zod` resolution on v3
// while this engine uses the v4 type + API surface. See introspection.ts.
import type { ZodType } from 'zod/v4';

import type { OrchestrationExecutionContext } from './context.js';
import type { Fail, Goto, NextStepDirective, Pause, Retry, Terminate } from './directives.js';

/**
 * @deprecated Authoring uses {@link defineStep}/{@link StepDefinition}. This
 * interface + {@link StepResult} are retained because the engine re-exports them
 * (`apps/workflows-engine/src/workflows/_core/step.ts`) and uses `StepResult`
 * as the internal shape it reconstructs from a completion payload — they are NOT
 * the customer authoring surface anymore.
 *
 * A workflow step: consumes typed input + ctx, returns an output + a directive.
 */
export interface Step<
  TIn = unknown,
  TOut = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  readonly inputSchema?: ZodType<TIn>;
  readonly timeoutMs?: number;
  run(input: TIn, ctx: OrchestrationExecutionContext<TShared>): Promise<StepResult<TOut>>;
}

/**
 * The engine's internal per-step shape: the audit `output` + the `next`
 * directive. The runner reconstructs this from a completion payload (extracting
 * `output` from the returned directive — see the runner's output-extraction).
 */
export interface StepResult<TOut = unknown> {
  /** Persisted to the step's audit row. Default input for the next step. */
  readonly output: TOut;
  readonly next: NextStepDirective;
}

// ---------------------------------------------------------------------------
// Declared-edge authoring: defineStep + Allowed
// ---------------------------------------------------------------------------

/**
 * The set of transitions a step's `run` may return, derived from its declared
 * routing capabilities. This is the load-bearing type: `goto` to a target not
 * in `Next` (or `terminate`/`fail`/`pause` a step that didn't declare it) is not
 * assignable to this union → a compile error at the `run` return.
 *
 * `Retry` is always present (universal badge, not a declared edge — the engine
 * caps it by `maxAttemptsPerStep`). A step with `next: []` and no
 * terminal/canFail/pause can therefore still only `retry` (and is flagged as a
 * dead-end by `validateGraph`).
 */
export type Allowed<
  Next extends readonly string[],
  Term extends boolean,
  CanFail extends boolean,
  PauseTo extends string,
> =
  | Goto<Next[number]>
  | (Term extends true ? Terminate : never)
  | (CanFail extends true ? Fail : never)
  | ([PauseTo] extends [never] ? never : Pause<PauseTo>)
  | Retry;

/**
 * A step as stored in a workflow's `steps` map — type-erased over routing. The
 * declared routing capabilities (`next`/`terminal`/`canFail`/`pause`) are
 * **runtime properties** `defineStep` always writes, which is what
 * `buildManifest` reads to emit the graph (exactly as it reads `inputSchema`).
 */
export interface StepDefinition<TShared extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  /** Declared `continue` targets (the graph's outgoing edges from this step). */
  readonly next: readonly string[];
  /** May `terminate`. */
  readonly terminal: boolean;
  /** May `fail`. */
  readonly canFail: boolean;
  /** Declared pause edge, if any. */
  readonly pause?: { readonly signal: string; readonly resumeStep: string };
  readonly inputSchema?: ZodType<unknown>;
  readonly timeoutMs?: number;
  run(input: unknown, ctx: OrchestrationExecutionContext<TShared>): Promise<NextStepDirective>;
}

/**
 * Define a step. `defineStep` derives the `run` return type from the declared
 * `next`/`terminal`/`canFail`/`pause` (via {@link Allowed}) — making undeclared
 * transitions a compile error — and stores those declarations as runtime
 * properties for `buildManifest` to read.
 *
 * `TShared` is inferred from the `ctx` annotation in `run`
 * (`ctx: OrchestrationExecutionContext<MyShared>`); `TIn` from `inputSchema` or the
 * `input` annotation. `next`/`terminal`/`canFail`/`pause` are inferred as
 * literals (`const` type params), so no `as const` is needed.
 */
export function defineStep<
  TIn = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
  const Next extends readonly string[] = readonly [],
  const Term extends boolean = false,
  const CanFail extends boolean = false,
  // Capture the whole pause object as a `const` type param (not a nested
  // property of a fixed-shape param) so its `resumeStep` literal is preserved —
  // a nested `resumeStep: PauseTo` widens to `string` and defeats enforcement.
  const PauseDecl extends { signal: string; resumeStep: string } | undefined = undefined,
>(def: {
  name: string;
  next?: Next;
  terminal?: Term;
  canFail?: CanFail;
  pause?: PauseDecl;
  inputSchema?: ZodType<TIn>;
  timeoutMs?: number;
  // Arrow-property (not method) type so `def.run` can be read as a value below
  // without tripping @typescript-eslint/unbound-method.
  run: (
    input: TIn,
    ctx: OrchestrationExecutionContext<TShared>,
  ) => Promise<Allowed<Next, Term, CanFail, PauseDecl extends { resumeStep: infer R extends string } ? R : never>>;
}): StepDefinition<TShared> {
  return {
    name: def.name,
    next: def.next ?? [],
    terminal: def.terminal ?? false,
    canFail: def.canFail ?? false,
    ...(def.pause ? { pause: def.pause } : {}),
    ...(def.inputSchema ? { inputSchema: def.inputSchema as ZodType<unknown> } : {}),
    ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
    run: def.run as unknown as (input: unknown, ctx: OrchestrationExecutionContext<TShared>) => Promise<NextStepDirective>,
  };
}
