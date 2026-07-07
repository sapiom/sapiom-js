/**
 * The dispatch seam. A host that runs step bodies somewhere other than
 * in-process (e.g. a remote executor) records the attempt, hands a
 * {@link StepDispatchRequest} to its {@link StepDispatcher}, and returns; the
 * step's result arrives later as a completion the runner applies. The
 * dispatcher is transport-only: "make the step body start executing." It must
 * not interpret directives, mutate execution state, or retry — those are the
 * runner's.
 */

/** Everything a step body needs to run once, plus the coordinates to report back. */
export interface StepDispatchRequest {
  readonly executionId: string;
  readonly workflowName: string;
  readonly stepName: string;
  readonly stepOrder: number;
  readonly attempt: number;
  /** The 'dispatched' step-attempt row this request belongs to. */
  readonly stepRowId: string;
  /** Parsed step input (schema defaults/coercions already applied). */
  readonly input: unknown;
  /** Full shared-state snapshot at dispatch time. */
  readonly shared: Record<string, unknown>;
  /** Host-enforced deadline; the executor should self-abort shortly before. */
  readonly deadlineAt: Date;
  readonly organizationId: string | null;
  readonly tenantId: string | null;
  /** The workflow-level entry input (distinct from the current step's `input`). */
  readonly workflowInput: unknown;
  /** `<executionId>:<stepOrder>:<attempt>` — echoed back on completion. */
  readonly correlationId: string;
  /** Optional manifest artifact entry filename. */
  readonly artifactEntryFile?: string;
  /** Optional content-hash of the bundle. */
  readonly artifactSha256?: string;
}

export interface StepDispatcher {
  /**
   * Start the step body executing. Resolve once the work is HANDED OFF, not
   * when it finishes. A throw here is treated as a step-attempt failure (retry
   * path) — so transport failures self-heal up to the cap like any transient error.
   */
  dispatch(request: StepDispatchRequest): Promise<void>;
}

/** Fallback dispatcher: rejects, letting the runner's retry/cap machinery fail loudly. */
export class UnsupportedStepDispatcher implements StepDispatcher {
  dispatch(request: StepDispatchRequest): Promise<void> {
    return Promise.reject(
      new Error(`No step dispatcher is configured (execution ${request.executionId}, step '${request.stepName}').`),
    );
  }
}

/**
 * Correlation id for one dispatched step attempt: `executionId:stepOrder:attempt`.
 * `stepOrder` (not stepName) so retries and later revisits of the same step name
 * each correlate to exactly one attempt row.
 */
export function buildCorrelationId(executionId: string, stepOrder: number, attempt: number): string {
  return `${executionId}:${stepOrder}:${attempt}`;
}

export interface ParsedCorrelationId {
  readonly executionId: string;
  readonly stepOrder: number;
  readonly attempt: number;
}

const CORRELATION_ID_RE = /^(\d+):(\d+):(\d+)$/;

/** Parse a completion's correlation id. Returns null on any malformed input. */
export function parseCorrelationId(correlationId: string): ParsedCorrelationId | null {
  const match = CORRELATION_ID_RE.exec(correlationId);
  if (!match) return null;
  return {
    executionId: match[1],
    stepOrder: Number(match[2]),
    attempt: Number(match[3]),
  };
}
