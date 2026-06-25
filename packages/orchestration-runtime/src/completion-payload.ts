import { z } from 'zod';

/**
 * The step-completion wire contract (protocol 1) — what an executor reports
 * back after running one dispatched step body. The directive union mirrors the
 * protocol's directives exactly; the runner, not the executor, interprets them.
 *
 * `shared` is the full post-step snapshot; `logs` are the executor-side log
 * buffer. Both are size-capped at the host's ingress edge.
 */

const continueDirectiveSchema = z.object({
  kind: z.literal('continue'),
  stepName: z.string().min(1),
  input: z.unknown().optional(),
});

const retryDirectiveSchema = z.object({
  kind: z.literal('retry'),
  delayMs: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

const pauseDirectiveSchema = z.object({
  kind: z.literal('pause_until_signal'),
  signal: z.object({
    name: z.string().min(1),
    correlationId: z.string().optional(),
  }),
  timeoutMs: z.number().int().positive().optional(),
  resumeStep: z.string().optional(),
});

const terminateDirectiveSchema = z.object({
  kind: z.literal('terminate'),
  reason: z.string().optional(),
});

const failDirectiveSchema = z.object({
  kind: z.literal('fail'),
  reason: z.string().optional(),
});

export const wireDirectiveSchema = z.discriminatedUnion('kind', [
  continueDirectiveSchema,
  retryDirectiveSchema,
  pauseDirectiveSchema,
  terminateDirectiveSchema,
  failDirectiveSchema,
]);

export const STEP_COMPLETION_OUTCOME = {
  /** The step body returned a StepResult — `result` is present. */
  RESULT: 'result',
  /** The step body threw — `error` is present; maps to the runner's retry path. */
  THREW: 'threw',
} as const;

export const stepCompletionPayloadSchema = z
  .object({
    protocol: z.literal(1),
    correlationId: z.string().min(1),
    outcome: z.enum([STEP_COMPLETION_OUTCOME.RESULT, STEP_COMPLETION_OUTCOME.THREW]),
    result: z
      .object({
        output: z.unknown().optional(),
        directive: wireDirectiveSchema,
      })
      .optional(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    shared: z.record(z.string(), z.unknown()).optional(),
    logs: z
      .array(
        z.object({
          ts: z.string(),
          level: z.string(),
          msg: z.string(),
        }),
      )
      .max(1000)
      .optional(),
    metrics: z
      .object({
        startedAt: z.string(),
        endedAt: z.string(),
      })
      .optional(),
  })
  .refine((payload) => (payload.outcome === STEP_COMPLETION_OUTCOME.RESULT ? payload.result != null : true), {
    message: `outcome '${STEP_COMPLETION_OUTCOME.RESULT}' requires a 'result' object`,
  })
  .refine((payload) => (payload.outcome === STEP_COMPLETION_OUTCOME.THREW ? payload.error != null : true), {
    message: `outcome '${STEP_COMPLETION_OUTCOME.THREW}' requires an 'error' object`,
  });

export type StepCompletionPayload = z.infer<typeof stepCompletionPayloadSchema>;

/** Host ingress cap on the `shared` snapshot. */
export const MAX_SHARED_SNAPSHOT_BYTES = 256 * 1024;

/** Host ingress cap on the serialized `logs` buffer. */
export const MAX_LOGS_BYTES = 512 * 1024;
