import type { Sapiom } from '@sapiom/tools';

import type { NextStepDirective } from './directives.js';

/**
 * Minimal structural logger interface for step code.
 *
 * WHY a separate interface rather than importing from the engine:
 * The SDK is a public contract package — it must not depend on
 * `apps/workflows-engine` or any of its internal modules. At the same
 * time, the engine needs to pass its own `Logger` (from
 * `src/observability/index.ts`) through `ctx.logger` to steps.
 *
 * Solution: define `StepLogger` here with EXACTLY the four methods that
 * step code actually calls (`info`, `warn`, `error`, `debug`). The engine's
 * `Logger` type is structurally identical — same four method signatures —
 * so it satisfies `StepLogger` with zero engine changes. No cast, no
 * wrapper, no coupling. If the engine ever adds methods to `Logger`,
 * those additions are invisible to step code (structural compatibility
 * still holds). If step code ever needs a new log level, add it here
 * and the engine's richer Logger still satisfies the widened interface.
 */
export interface StepLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The set of finished-step status values a StepExecutionRecord can carry.
 * Mirrors `Exclude<StepStatus, 'running'>` from the engine entity — defined
 * here as a literal union so the SDK does not depend on the engine's TypeORM
 * entity. The engine assigns values from its own `STEP_STATUS` constant which
 * has the same string literals, so the types are mutually assignable.
 */
export type FinishedStepStatus = 'dispatched' | 'succeeded' | 'failed';

/**
 * What every step sees on each `run()` call. Read-only from the step's
 * perspective except for `shared.set(...)` and any side effects the step
 * chooses to perform.
 *
 * The two channels for state, with different semantics:
 *   - `input` (the first arg to run) and the step's return `output` —
 *     the audit trail. Every (input, output) pair is persisted to
 *     workflow_step_executions and becomes the answer to "what did this
 *     step do?"
 *   - `ctx.shared` — the named cross-step value bus. Typed via the
 *     workflow definition's TShared generic. Persisted to
 *     workflow_executions.shared_state after every step.
 *
 * Don't double-thread the same value through both channels — pick the
 * one whose semantics match. Rule of thumb: if the next step needs it,
 * pass it through `output → input`. If something three steps downstream
 * needs it, put it in `shared`.
 */
export interface AgentExecutionContext<TShared extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable id; the workflow_executions row primary key. */
  readonly executionId: string;
  readonly workflowName: string;

  /**
   * Tenant scope, stamped on the execution at creation and immutable for
   * the lifetime of the run. Both null for admin / cross-tenant workflows.
   *
   * Polsia's mid-flight `bindCompany` (for onboarding's
   * create-company-then-bind shape) is intentionally NOT ported: Sapiom
   * callers supply `organizationId` + `tenantId` to `createExecution`
   * upfront, so the scope never changes after the row is written.
   */
  readonly organizationId: string | null;
  readonly tenantId: string | null;

  /** The value passed to the workflow's entry step. Unchanged across the run. */
  readonly input: unknown;

  /** Typed named-slot store; persisted to shared_state after each step. */
  readonly shared: TypedContextStore<TShared>;

  /** Completed step executions in this run, oldest first. */
  readonly history: readonly StepExecutionRecord[];

  /** 0-based attempt counter for the current step. */
  readonly attempts: number;

  readonly logger: StepLogger;

  /**
   * The pre-auth'd Sapiom capability client — the same tools your agents call
   * over MCP, now callable from step code (`ctx.sapiom.sandboxes.create(...)`,
   * `ctx.sapiom.agent.coding.run(...)`, …). The runner constructs it from the
   * per-execution tenant credential the engine injects into the step sandbox,
   * so every capability call is tenant-scoped, metered, and traced with zero
   * auth plumbing in the step.
   *
   * Provided via `ctx` (never a module import): each artifact is an independent
   * self-contained bundle with its own inlined SDK copy, so a ctx-carried client
   * is the only form that crosses the bundle boundary already bound — the same
   * reason `logger` rides on `ctx`.
   */
  readonly sapiom: Sapiom;
}

export interface TypedContextStore<TShared extends Record<string, unknown>> {
  get<K extends keyof TShared>(key: K): TShared[K] | undefined;
  set<K extends keyof TShared>(key: K, value: TShared[K]): void;
  has<K extends keyof TShared>(key: K): boolean;
  snapshot(): Partial<TShared>;
}

/**
 * History entry exposed to steps via ctx.history. Matches the shape of
 * a finished workflow_step_executions row.
 *
 * `sharedStateAfter` is the snapshot of ctx.shared at the moment this
 * step's run() resolved/threw — useful for steps that compare current
 * shared with what an earlier step left, or for debugging the evolution
 * of cross-step values.
 */
export interface StepExecutionRecord {
  readonly stepName: string;
  readonly attempt: number;
  readonly status: FinishedStepStatus;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: unknown;
  readonly nextDirective: NextStepDirective | null;
  readonly sharedStateAfter: Record<string, unknown> | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

/**
 * Internal: in-memory ContextStore backed by a plain object. The runner
 * builds one of these per advance() call, seeded from the execution row's
 * shared_state, and writes the mutated snapshot back after the step runs.
 */
export class InMemoryContextStore<TShared extends Record<string, unknown>> implements TypedContextStore<TShared> {
  private state: Partial<TShared>;

  constructor(initial: Partial<TShared> = {}) {
    this.state = { ...initial };
  }

  get<K extends keyof TShared>(key: K): TShared[K] | undefined {
    return this.state[key];
  }

  set<K extends keyof TShared>(key: K, value: TShared[K]): void {
    this.state[key] = value;
  }

  has<K extends keyof TShared>(key: K): boolean {
    return key in this.state;
  }

  snapshot(): Partial<TShared> {
    return { ...this.state };
  }
}
