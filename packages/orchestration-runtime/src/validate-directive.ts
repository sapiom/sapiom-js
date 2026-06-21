import {
  DisallowedTransitionError,
  type NextStepDirective,
  UnknownStepError,
  type WorkflowManifest,
  isContinue,
  isFail,
  isPause,
  isRetry,
  isTerminate,
} from '@sapiom/orchestration';

/**
 * Per-step + per-kind transition validation against the pinned manifest: a
 * directive is allowed iff it matches one of THIS step's declared
 * `transitions`. `retry` is exempt (universal, capped separately). Returns the
 * error to fail the execution with, or null if the directive is allowed.
 *
 * Legacy fallback: a manifest pinned before per-step `transitions` existed has
 * `transitions === undefined`; we fall back to the original global
 * CONTINUE-target existence check so in-flight executions keep working.
 */
export function validateDirective(
  manifest: WorkflowManifest,
  stepName: string,
  directive: NextStepDirective,
): UnknownStepError | DisallowedTransitionError | null {
  if (isRetry(directive)) return null; // universal — not a declared edge

  // Reject unrecognized directive kinds outright. The completion's directive is
  // cast from untrusted executor output, so a buggy/malicious executor can emit
  // an unknown kind; terminal-fail it here like any other disallowed transition.
  if (!isContinue(directive) && !isTerminate(directive) && !isFail(directive) && !isPause(directive)) {
    return new DisallowedTransitionError(stepName, (directive as { kind?: string }).kind ?? 'unknown');
  }

  const transitions = manifest.steps[stepName]?.transitions;
  if (!transitions) {
    // Legacy manifest: only the CONTINUE-target existence check is available.
    if (isContinue(directive) && !manifest.steps[directive.stepName]) {
      return new UnknownStepError(directive.stepName);
    }
    return null;
  }

  if (isContinue(directive)) {
    const target = directive.stepName;
    if (!manifest.steps[target]) return new UnknownStepError(target);
    const declared = transitions.some((t) => t.kind === 'continue' && t.target === target);
    return declared ? null : new DisallowedTransitionError(stepName, 'continue', target);
  }
  if (isTerminate(directive)) {
    return transitions.some((t) => t.kind === 'terminate') ? null : new DisallowedTransitionError(stepName, 'terminate');
  }
  if (isFail(directive)) {
    return transitions.some((t) => t.kind === 'fail') ? null : new DisallowedTransitionError(stepName, 'fail');
  }
  if (isPause(directive)) {
    const signalName = directive.signal.name;
    const resume = directive.resumeStep;
    const declared = transitions.some(
      (t) => t.kind === 'pause' && t.signal === signalName && (resume === undefined || t.resumeStep === resume),
    );
    return declared ? null : new DisallowedTransitionError(stepName, 'pause', resume);
  }
  return null;
}

/**
 * The retry-vs-cap decision, as a pure function. A step is retried until its
 * attempt count would reach the cap, at which point the execution fails.
 * `currentAttempt` is the 0-based attempt that just ran.
 */
export function decideRetry(currentAttempt: number, maxAttempts: number): 'retry' | 'fail' {
  return currentAttempt + 1 >= maxAttempts ? 'fail' : 'retry';
}
