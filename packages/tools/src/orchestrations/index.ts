/**
 * `orchestrations` capability — run a deployed orchestration, and (the headline
 * use) dispatch one FROM a step and pause until it finishes.
 *
 *   import { orchestrations } from "@sapiom/tools";
 *   // dispatch another orchestration and pause this step on its result:
 *   const child = await orchestrations.launch({ definition: "enrich-lead", input });
 *   return pauseUntilSignal(child, { resumeStep: "use-result" });
 *   // the resumed step receives an OrchestrationRunResultPayload
 *
 * `launch` returns a handle to pass straight to `pauseUntilSignal` (the waiting
 * step resumes when the run finishes) or to `wait()` inline for standalone use.
 * `run` is `launch` + `wait` — it blocks until the run reaches a terminal state, so
 * use it for inline standalone calls, NOT to pause a step (it returns a result, not
 * a pausable handle). An orchestration is addressed by its **slug** (its stable handle).
 */
import { Transport, defaultTransport } from "../_client/index.js";
import type { DispatchHandle } from "../dispatch.js";

const DEFAULT_BASE_URL =
  process.env.SAPIOM_WORKFLOWS_URL || "https://workflows.services.sapiom.ai";

/**
 * Signal a run fires when it reaches a terminal state (completed OR failed — the
 * payload carries which, the resumed step branches). A step paused on an
 * orchestration handle resumes on this; it is the value carried in the handle's
 * `dispatch.resultSignal`.
 */
export const ORCHESTRATIONS_RESULT_SIGNAL = "orchestrations.result";

/** Run lifecycle status. */
export type ExecutionStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
const TERMINAL = new Set<ExecutionStatus>(["completed", "failed", "cancelled"]);

export interface OrchestrationRunSpec {
  /** Slug of the deployed orchestration to run (its stable handle). */
  definition: string;
  /** Input passed to the orchestration's entry step. */
  input?: Record<string, unknown>;
  /** Optional idempotency key — a repeat with the same key returns the existing run. */
  idempotencyKey?: string;
}

/** A live, awaited run (the standalone `run()`/`wait()` result). */
export interface OrchestrationRunResult {
  executionId: string;
  status: ExecutionStatus;
  output: unknown;
  error: unknown;
}

/**
 * The typed result delivered to the step resumed from `pauseUntilSignal(handle, …)`
 * — the payload that step receives as its `input`. Discriminated on `status` so a
 * FAILURE is data the author branches on, not an exception.
 *
 *   const useResult = defineStep({
 *     name: "use-result",
 *     async run(result: OrchestrationRunResultPayload, ctx) {
 *       if (result.status === "failed") { … }
 *     },
 *   });
 */
export type OrchestrationRunResultPayload<TOutput = unknown> =
  | {
      status: "completed";
      executionId: string;
      definition: string;
      version: string;
      output: TOutput;
      startedAt: string;
      finishedAt: string;
    }
  | {
      status: "failed";
      executionId: string;
      definition: string;
      version: string;
      error: unknown;
      startedAt: string;
      finishedAt: string;
    };

/** Thrown by {@link orchestrationResultSchema}.parse on a malformed resume payload. */
export class OrchestrationResultSchemaError extends Error {}

/**
 * Runtime validator for {@link OrchestrationRunResultPayload}. `parse` returns the
 * value typed on success and throws an {@link OrchestrationResultSchemaError} on any
 * divergence. Generic in the caller's expected `output` type — the shape of
 * `output` itself is the child orchestration's contract, not validated here.
 */
export const orchestrationResultSchema = {
  parse<TOutput = unknown>(value: unknown): OrchestrationRunResultPayload<TOutput> {
    const fail = (msg: string): never => {
      throw new OrchestrationResultSchemaError(
        `invalid orchestration result payload: ${msg}`,
      );
    };
    if (!value || typeof value !== "object") fail("not an object");
    const v = value as Record<string, unknown>;

    if (v.status !== "completed" && v.status !== "failed")
      fail("status must be 'completed' or 'failed'");
    if (typeof v.executionId !== "string") fail("executionId must be a string");
    if (typeof v.definition !== "string") fail("definition must be a string");
    if (typeof v.version !== "string") fail("version must be a string");
    if (typeof v.startedAt !== "string") fail("startedAt must be a string");
    if (typeof v.finishedAt !== "string") fail("finishedAt must be a string");
    if (v.status === "completed" && !("output" in v))
      fail("a completed result must carry `output`");
    if (v.status === "failed" && !("error" in v))
      fail("a failed result must carry `error`");

    return value as OrchestrationRunResultPayload<TOutput>;
  },
};

/**
 * A launched-but-not-awaited child run. Satisfies {@link DispatchHandle}, so it can
 * be handed straight to `pauseUntilSignal(handle, { resumeStep })` to suspend the
 * step until the child finishes — or `wait()`-ed inline for standalone use.
 */
export interface RunHandle extends DispatchHandle {
  executionId: string;
  /** Fetch the current status without blocking. */
  status(): Promise<ExecutionStatus>;
  /** Poll to a terminal state and resolve the run result. */
  wait(opts?: { timeoutMs?: number; pollMs?: number }): Promise<OrchestrationRunResult>;
}

/**
 * Inside a Sapiom workflow a resume token is provided via the environment;
 * forwarding it (as a header, not a body field) lets the run resume the waiting
 * step when it finishes. Outside a workflow there's no token, so nothing is sent.
 */
function workflowResumeHeaders(): Record<string, string> {
  const token = process.env.SAPIOM_CAPABILITY_RESUME_TOKEN;
  return token ? { "x-sapiom-workflow-token": token } : {};
}

// --- wire shapes ---

/** Create-execution response. */
interface StartResponse {
  status: "enqueued" | "already_exists";
  executionId: string;
  existingStatus?: ExecutionStatus;
}

/** Execution status document — only the fields the handle reads. */
interface ExecutionDoc {
  status: ExecutionStatus;
  output?: unknown;
  error?: unknown;
}

export async function launch(
  spec: OrchestrationRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RunHandle> {
  const res = await transport.request<StartResponse>(
    `${baseUrl}/v1/workflows/${encodeURIComponent(spec.definition)}/executions`,
    {
      method: "POST",
      body: JSON.stringify({ input: spec.input ?? {}, idempotencyKey: spec.idempotencyKey }),
      headers: workflowResumeHeaders(),
    },
  );
  const executionId = res.executionId;

  const fetchDoc = () =>
    transport.request<ExecutionDoc>(
      `${baseUrl}/v1/workflows/executions/${encodeURIComponent(executionId)}`,
    );

  return {
    executionId,
    // Framework plumbing for `pauseUntilSignal` — see DispatchHandle. correlationId
    // is this run's id (the resume's correlation key).
    dispatch: { correlationId: executionId, resultSignal: ORCHESTRATIONS_RESULT_SIGNAL },
    async status() {
      return (await fetchDoc()).status;
    },
    async wait({ timeoutMs = 60 * 60_000, pollMs = 3_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const d = await fetchDoc();
        if (TERMINAL.has(d.status)) {
          return { executionId, status: d.status, output: d.output ?? null, error: d.error ?? null };
        }
        if (Date.now() > deadline) {
          throw new Error(
            `orchestration ${executionId} timed out after ${timeoutMs}ms (last status: ${d.status})`,
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

export async function run(
  spec: OrchestrationRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<OrchestrationRunResult> {
  const handle = await launch(spec, transport, baseUrl);
  return handle.wait();
}
