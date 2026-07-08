/**
 * The five ways a step can tell the runner what to do next.
 *
 * The shape of this union is the load-bearing contract of the primitive.
 * Adding new kinds is additive (existing steps that don't return them are
 * unaffected); changing the shape of an existing kind breaks every step
 * that uses it.
 *
 * `pause_until_signal.signal` is a structured { name, correlationId } pair —
 * NOT a bare string. Even though webhook-routed resume is deferred for v1
 * (only resume is implemented), step authors can already write
 * pause directives in the shape the routing layer will consume.
 */

import type { DispatchHandle } from '@sapiom/tools';

/**
 * Single source of truth for directive `kind` values.
 *
 * Step authors and framework code reference these constants instead of
 * hardcoding `'continue'`, `'retry'`, etc. The directive interfaces below
 * derive their `kind` literal type from this object, so a rename here
 * propagates everywhere through the type system.
 */
export const DIRECTIVE_KIND = {
  CONTINUE: 'continue',
  RETRY: 'retry',
  PAUSE_UNTIL_SIGNAL: 'pause_until_signal',
  TERMINATE: 'terminate',
  FAIL: 'fail',
} as const;

export type DirectiveKind = (typeof DIRECTIVE_KIND)[keyof typeof DIRECTIVE_KIND];

export type NextStepDirective =
  | ContinueDirective
  | RetryDirective
  | PauseUntilSignalDirective
  | TerminateDirective
  | FailDirective;

/** Run the named step next. If `input` is omitted, the next step receives the current step's output. */
export interface ContinueDirective {
  readonly kind: typeof DIRECTIVE_KIND.CONTINUE;
  readonly stepName: string;
  readonly input?: unknown;
}

/**
 * Run this step again. The runner caps attempts at `maxAttemptsPerStep`
 * (default 3); exceeding the cap throws RetryLimitExceededError and
 * finalizes the workflow as failed.
 */
export interface RetryDirective {
  readonly kind: typeof DIRECTIVE_KIND.RETRY;
  readonly delayMs?: number;
  readonly reason?: string;
}

/**
 * Pause until an external signal arrives. The runner records the pause
 * (status='paused', signal name + correlationId stored on the execution row)
 * and the inline runner exits via AgentPausedError.
 *
 * Signal-routed resume is implemented in `signals.service.ts`:
 * `AgentSignals.fireSignal(name, correlationId, payload)` looks up paused
 * executions by (signal.name, correlationId) and wakes each one with the
 * payload as the resume step's input. Operator-driven resume also works.
 */
export interface PauseUntilSignalDirective {
  readonly kind: typeof DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL;
  readonly signal: {
    readonly name: string;
    readonly correlationId?: string;
  };
  readonly timeoutMs?: number;
  /** Step to run when the signal arrives. Defaults to the paused step. */
  readonly resumeStep?: string;
}

/** Finalize the workflow as completed. `output` (already on the StepResult) is the workflow's final output. */
export interface TerminateDirective {
  readonly kind: typeof DIRECTIVE_KIND.TERMINATE;
  readonly reason?: string;
}

/**
 * Finalize the workflow as failed — deterministically, without burning the
 * retry cap. Sets `status='failed'` on the row in one shot. The step's
 * `output` (on the `StepResult`) is preserved so callers can read structured
 * failure context (which sub-task failed, why, what was produced before the
 * abort). The `reason` is a short human-readable label for logs / dashboards.
 *
 * **When to use this vs throwing:**
 *   - FAIL is for KNOWN-TERMINAL failures the step has already diagnosed
 *     (e.g. "the coding agent reported `success: false`"). One CAS write,
 *     one log line, one failure event.
 *   - Throwing is for UNEXPECTED errors that may be transient (network
 *     blip, race condition). The retry-up-to-cap mechanism gives those a
 *     self-heal path before terminal failure.
 *
 * Mis-using throw for terminal failures wastes `maxAttemptsPerStep` cycles
 * and produces misleading "retry" log noise. Mis-using FAIL for transient
 * errors removes the self-heal safety net. Pick the one whose semantics
 * match the failure mode you're handling.
 *
 * **Agent-level cleanup pattern:** FAIL ends the execution immediately —
 * any cleanup steps the workflow wants to run (sandbox teardown, file
 * cleanup, etc.) must happen BEFORE the FAIL directive fires. The standard
 * shape is: an earlier step stashes a "this run failed" flag in `ctx.shared`,
 * cleanup steps run unconditionally, and the FINAL step inspects the flag
 * and emits TERMINATE or FAIL (the single FAIL emit site).
 *
 * **Forward-compatible for hooks / recovery:** when a workflow-level
 * `onFailure` hook surface lands, it fires off this directive's terminal
 * state. The hook can read the row's `output` + `error` + `sharedState`
 * to drive retry-with-different-input, escalation, or compensating
 * transactions.
 */
export interface FailDirective {
  readonly kind: typeof DIRECTIVE_KIND.FAIL;
  /** Short human label for the failure (logs, dashboards). Distinct from `output` which carries structured caller data. */
  readonly reason?: string;
}

export function isContinue(d: NextStepDirective): d is ContinueDirective {
  return d.kind === DIRECTIVE_KIND.CONTINUE;
}

export function isRetry(d: NextStepDirective): d is RetryDirective {
  return d.kind === DIRECTIVE_KIND.RETRY;
}

export function isPause(d: NextStepDirective): d is PauseUntilSignalDirective {
  return d.kind === DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL;
}

export function isTerminate(d: NextStepDirective): d is TerminateDirective {
  return d.kind === DIRECTIVE_KIND.TERMINATE;
}

export function isFail(d: NextStepDirective): d is FailDirective {
  return d.kind === DIRECTIVE_KIND.FAIL;
}

// ---------------------------------------------------------------------------
// Branded transition constructors (the authoring surface)
// ---------------------------------------------------------------------------
//
// `defineStep` derives a step's `run` return type from its declared `next` /
// `terminal` / `canFail` / `pause` via `Allowed<…>` (see step.ts). The branded
// types below are what make that enforcement possible: `Goto<Target>` and
// `Pause<Resume>` carry the target step name as a *type parameter*, so the
// declared edge set can constrain which targets are expressible.
//
// They are PURE value constructors — no runtime context, importable anywhere.
// Each is assignable to its corresponding wire interface above (Goto → Continue,
// etc.), so a returned directive is still a `NextStepDirective`. The output
// payload each carries is extracted by the runner into the completion's
// `result.output`; the runner rebuilds the clean wire directive it POSTs (see
// the runner's output-extraction). `goto`'s payload is BOTH this step's audit
// output and the next step's input (unifying the old StepResult.output +
// ContinueDirective.input).

/** A `continue` to `Target`, carrying `Target` at the type level so `Allowed<…>` can gate it. */
export interface Goto<Target extends string> {
  readonly kind: typeof DIRECTIVE_KIND.CONTINUE;
  readonly stepName: Target;
  /** This step's output AND the next step's input. Omitted → next step receives `undefined`. */
  readonly input?: unknown;
}

/** Finalize the workflow as completed. `output` becomes the workflow's final output. */
export interface Terminate {
  readonly kind: typeof DIRECTIVE_KIND.TERMINATE;
  readonly output?: unknown;
  readonly reason?: string;
}

/** Finalize the workflow as failed (deterministic, no retry). `output` carries structured failure context. */
export interface Fail {
  readonly kind: typeof DIRECTIVE_KIND.FAIL;
  readonly reason?: string;
  readonly output?: unknown;
}

/** Pause until a signal, resuming at `Resume` (type-level so `Allowed<…>` can gate it). */
export interface Pause<Resume extends string> {
  readonly kind: typeof DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL;
  readonly signal: { readonly name: string; readonly correlationId?: string };
  readonly resumeStep?: Resume;
  readonly timeoutMs?: number;
  /** Optional audit output recorded for the pausing step. */
  readonly output?: unknown;
}

/** Re-run this step. Universal (not a declared edge); engine caps attempts at `maxAttemptsPerStep`. */
export interface Retry {
  readonly kind: typeof DIRECTIVE_KIND.RETRY;
  readonly delayMs?: number;
  readonly reason?: string;
}

/** Route to `target` (must be in the step's declared `next`), passing `output` as its input. */
export function goto<const Target extends string>(target: Target, output?: unknown): Goto<Target> {
  return { kind: DIRECTIVE_KIND.CONTINUE, stepName: target, input: output };
}

/** Finalize as completed with `output` as the workflow's final output. Requires `terminal: true`. */
export function terminate(output?: unknown, opts?: { reason?: string }): Terminate {
  return { kind: DIRECTIVE_KIND.TERMINATE, output, reason: opts?.reason };
}

/** Finalize as failed with a `reason` label and optional structured `output`. Requires `canFail: true`. */
export function fail(reason?: string, opts?: { output?: unknown }): Fail {
  return { kind: DIRECTIVE_KIND.FAIL, reason, output: opts?.output };
}

/**
 * Pause until a signal arrives, then resume at `resumeStep`. Two ways to specify
 * the wait — both still require a matching `pause: { signal, resumeStep }`
 * declaration on the step (the build-time graph edge):
 *
 *   1. Explicit args (synchronous). For human approval or any external webhook
 *      that isn't a dispatched Sapiom capability. `correlationId` defaults to the
 *      ambient `executionId` (filled by the runner) when omitted.
 *
 *        return pauseUntilSignal({ signal: 'demo.approval', resumeStep: 'finalize' });
 *
 *   2. A dispatched-capability handle, or the launch promise itself (async — it
 *      awaits the launch). Reads the `signal` + `correlationId` off the handle's
 *      `dispatch` member, so the author writes neither. Erases to the identical
 *      `Pause` directive as form (1).
 *
 *        return pauseUntilSignal(ctx.sapiom.models.coding.launch({ task }), { resumeStep: 'review' });
 *
 * Both are consumed as `return pauseUntilSignal(...)` from an async `run()`, so
 * async-return flattening makes the sync/async distinction invisible at the call
 * site.
 */
export function pauseUntilSignal<const Resume extends string>(args: {
  signal: string;
  resumeStep?: Resume;
  correlationId?: string;
  timeoutMs?: number;
  output?: unknown;
}): Pause<Resume>;
export function pauseUntilSignal<const Resume extends string>(
  handle: DispatchHandle | Promise<DispatchHandle>,
  opts?: { resumeStep?: Resume; timeoutMs?: number; output?: unknown },
): Promise<Pause<Resume>>;
export function pauseUntilSignal<const Resume extends string>(
  argOrHandle:
    | { signal: string; resumeStep?: Resume; correlationId?: string; timeoutMs?: number; output?: unknown }
    | DispatchHandle
    | Promise<DispatchHandle>,
  opts?: { resumeStep?: Resume; timeoutMs?: number; output?: unknown },
): Pause<Resume> | Promise<Pause<Resume>> {
  // The launch promise — await it, then build from the resolved handle.
  if (isThenable(argOrHandle)) {
    return Promise.resolve(argOrHandle).then((handle) => pauseFromHandle(handle, opts));
  }
  // A resolved dispatch handle — async for a uniform handle-form contract.
  if ('dispatch' in argOrHandle) {
    return Promise.resolve(pauseFromHandle(argOrHandle, opts));
  }
  // Explicit args — synchronous.
  return {
    kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
    signal: { name: argOrHandle.signal, correlationId: argOrHandle.correlationId },
    resumeStep: argOrHandle.resumeStep,
    timeoutMs: argOrHandle.timeoutMs,
    output: argOrHandle.output,
  };
}

function isThenable(x: unknown): x is Promise<DispatchHandle> {
  return x != null && typeof (x as { then?: unknown }).then === 'function';
}

function pauseFromHandle<Resume extends string>(
  handle: DispatchHandle,
  opts: { resumeStep?: Resume; timeoutMs?: number; output?: unknown } | undefined,
): Pause<Resume> {
  return {
    kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
    signal: { name: handle.dispatch.resultSignal, correlationId: handle.dispatch.correlationId },
    resumeStep: opts?.resumeStep,
    timeoutMs: opts?.timeoutMs,
    output: opts?.output,
  };
}

/** Re-run this step (optionally after `delayMs`). Always allowed; capped by `maxAttemptsPerStep`. */
export function retry(opts?: { delayMs?: number; reason?: string }): Retry {
  return { kind: DIRECTIVE_KIND.RETRY, delayMs: opts?.delayMs, reason: opts?.reason };
}
