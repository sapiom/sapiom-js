import { z } from 'zod/v4';
// `zod/v4/core` subpath (present in zod 3.25.x AND zod 4.x): the issue type while
// the `zod` peer can resolve to v3 or v4. See introspection.ts.
import type { $ZodIssue } from 'zod/v4/core';

/** Base class for every error the primitive can throw. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Versioned wire contract for deterministic step-input validation failures. */
export const STEP_INPUT_VALIDATION_ERROR_CONTRACT = Object.freeze({
  version: 1,
  errorCode: 'STEP_INPUT_VALIDATION_FAILED',
  retryable: false,
} as const);

/** Stable cross-process representation; raw Zod issues deliberately stay local. */
export const stepInputValidationErrorPayloadSchema = z.object({
  name: z.literal('StepInputValidationError'),
  message: z.string(),
  code: z.literal(STEP_INPUT_VALIDATION_ERROR_CONTRACT.errorCode),
  version: z.number().int().positive(),
  stepName: z.string().min(1),
  retryable: z.literal(false),
  stack: z.string().optional(),
});

export type StepInputValidationErrorPayload = z.infer<typeof stepInputValidationErrorPayloadSchema>;

/**
 * A step's input failed its declared `inputSchema`. Thrown both
 * synchronously by `createExecution` (entry input rejected before any
 * row is written) and at advance time by the runner (which fails the
 * execution terminally — bad input is deterministic, so retrying is
 * pure waste). Carries the raw Zod issues so callers (the admin tool)
 * can surface field-level detail.
 */
export class StepInputValidationError extends AgentError {
  readonly code = STEP_INPUT_VALIDATION_ERROR_CONTRACT.errorCode;
  readonly version = STEP_INPUT_VALIDATION_ERROR_CONTRACT.version;
  readonly stepName: string;
  readonly issues: readonly $ZodIssue[];
  readonly retryable = STEP_INPUT_VALIDATION_ERROR_CONTRACT.retryable;

  constructor(stepName: string, issues: readonly $ZodIssue[]) {
    super(`Input for step '${stepName}' failed validation: ${formatIssues(issues)}`);
    this.name = 'StepInputValidationError';
    this.stepName = stepName;
    this.issues = issues;
  }

  /** Serialize only the stable machine contract, never version-specific Zod issues. */
  toJSON(): StepInputValidationErrorPayload {
    return {
      name: 'StepInputValidationError',
      message: this.message,
      code: this.code,
      version: this.version,
      stepName: this.stepName,
      retryable: this.retryable,
      ...(this.stack === undefined ? {} : { stack: this.stack }),
    };
  }
}

/** Recognize the input-validation payload across bundles and processes. */
export function isStepInputValidationErrorPayload(value: unknown): value is StepInputValidationErrorPayload {
  return stepInputValidationErrorPayloadSchema.safeParse(value).success;
}

/** `path.to.field: message; other: message` — compact, human-readable. */
function formatIssues(issues: readonly $ZodIssue[]): string {
  if (issues.length === 0) return 'unknown validation error';
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Definition references a step name that isn't in the steps map. */
export class UnknownStepError extends AgentError {
  readonly stepName: string;
  constructor(stepName: string) {
    super(`Unknown step: ${stepName}`);
    this.name = 'UnknownStepError';
    this.stepName = stepName;
  }
}

/**
 * A step's completion returned a directive the step did not declare — a
 * `continue` to a target outside its `next`, a `terminate`/`fail` it didn't
 * declare (`terminal`/`canFail`), or a `pause` with no matching declaration.
 * The engine raises this at the trust boundary (validating the directive against
 * the pinned manifest's per-step transitions) and fails the execution
 * terminally — untrusted code cannot route outside the declared graph. `retry`
 * is exempt (universal, capped by `maxAttemptsPerStep`).
 */
export class DisallowedTransitionError extends AgentError {
  readonly stepName: string;
  readonly directiveKind: string;
  readonly target?: string;
  constructor(stepName: string, directiveKind: string, target?: string) {
    super(
      `Step '${stepName}' returned a '${directiveKind}' directive` +
        (target ? ` to '${target}'` : '') +
        ` that is not in its declared transitions`,
    );
    this.name = 'DisallowedTransitionError';
    this.stepName = stepName;
    this.directiveKind = directiveKind;
    this.target = target;
  }
}
