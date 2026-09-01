/**
 * `orchestrations` capability — run a deployed orchestration, and (the headline
 * use) dispatch one FROM a step and pause until it finishes.
 *
 *   import { orchestrations } from "@sapiom/tools";
 *   // dispatch another orchestration and pause this step on its result:
 *   const child = await orchestrations.launch({ definition: "enrich-lead", input });
 *   return pauseUntilSignal(child, { resumeStep: "use-result" });
 *   // the resumed step receives an AgentRunResultPayload
 *
 * `launch` returns a handle to pass straight to `pauseUntilSignal` (the waiting
 * step resumes when the run finishes) or to `wait()` inline for standalone use.
 * `run` is `launch` + `wait` — it blocks until the run reaches a terminal state, so
 * use it for inline standalone calls, NOT to pause a step (it returns a result, not
 * a pausable handle). An orchestration is addressed by its **slug** (its stable handle).
 */
import { defaultTransport } from "../_client/index.js";
import type { Transport } from "../_client/index.js";
import { takeAgentRuntimeCallsite } from "./runtime-callsite-store.js";
import type { DispatchHandle } from "../dispatch.js";

const DEFAULT_BASE_URL =
  process.env.SAPIOM_AGENTS_URL ??
  process.env.SAPIOM_TOOLS_BASE ??
  "https://tools.sapiom.ai";

/**
 * Signal a run fires when it reaches a terminal state (completed OR failed — the
 * payload carries which, the resumed step branches). A step paused on an
 * orchestration handle resumes on this; it is the value carried in the handle's
 * `dispatch.resultSignal`.
 */
export const AGENTS_RESULT_SIGNAL = "agents.result";

/** Run lifecycle status. */
export type ExecutionStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
const TERMINAL = new Set<ExecutionStatus>(["completed", "failed", "cancelled"]);

const AGENT_RUNTIME_PROVENANCE_VERSION = 1 as const;
const AGENT_RUNTIME_PROVENANCE_VERSION_HEADER =
  "x-sapiom-runtime-provenance-version";
const AGENT_RUNTIME_CALLSITE_HEADER = "x-sapiom-runtime-callsite-evidence";
const AGENT_RUNTIME_LINEAGE_HEADER = "x-sapiom-runtime-lineage-receipt";
const MAX_OPAQUE_TOKEN_LENGTH = 8_192;
const RUNTIME_PROVENANCE_REDACTION = "[REDACTED runtime provenance]";

interface LineageRecord {
  readonly receipt: string;
  active: boolean;
  consumed: boolean;
}

const resultLineage = new WeakMap<object, LineageRecord>();

function supportedOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    !/[\r\n]/.test(value)
  );
}

function takeAgentRuntimeLineage(directInput: unknown): string | undefined {
  if (directInput === null || typeof directInput !== "object") return undefined;
  const record = resultLineage.get(directInput);
  resultLineage.delete(directInput);
  const receipt =
    record?.active && !record.consumed ? record.receipt : undefined;
  if (record) record.consumed = true;
  return receipt;
}

function retainAgentRuntimeLineage(
  targets: readonly object[],
  version: string | null,
  receipt: string | null,
): void {
  if (
    version !== String(AGENT_RUNTIME_PROVENANCE_VERSION) ||
    !supportedOpaqueToken(receipt)
  ) {
    return;
  }
  const record: LineageRecord = {
    receipt: `${receipt}`,
    active: true,
    consumed: false,
  };
  for (const target of targets) resultLineage.set(target, record);
  const timer = setTimeout(() => {
    record.active = false;
  }, 0);
  timer.unref?.();
}

function redactAgentRuntimeProvenance(
  text: string,
  privateValues: readonly (string | null | undefined)[],
): string {
  let redacted = text;
  const values = [...new Set(privateValues.filter(supportedOpaqueToken))].sort(
    (left, right) => right.length - left.length,
  );
  for (const value of values) {
    redacted = redacted.split(value).join(RUNTIME_PROVENANCE_REDACTION);
  }
  return redacted;
}

function redactedAgentRuntimeError(
  error: unknown,
  privateValues: readonly (string | null | undefined)[],
): unknown {
  const values = [...new Set(privateValues.filter(supportedOpaqueToken))].sort(
    (left, right) => right.length - left.length,
  );
  if (values.length === 0) return error;

  const redactString = (value: string): string =>
    redactAgentRuntimeProvenance(value, values);
  if (!(error instanceof Error)) {
    const message = String(error);
    const redacted = redactString(message);
    return redacted === message ? error : new Error(redacted);
  }

  const sanitizedErrors = new WeakMap<Error, Error>();
  const sanitizeError = (source: Error): Error => {
    const cached = sanitizedErrors.get(source);
    if (cached) return cached;

    let changed = false;
    const target = Object.create(Object.getPrototypeOf(source)) as Error;
    sanitizedErrors.set(source, target);

    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if ("value" in descriptor) {
        if (typeof descriptor.value === "string") {
          const value = redactString(descriptor.value);
          changed ||= value !== descriptor.value;
          descriptor.value = value;
        } else if (descriptor.value instanceof Error) {
          const value = sanitizeError(descriptor.value);
          changed ||= value !== descriptor.value;
          descriptor.value = value;
        }
      }
      Object.defineProperty(target, key, descriptor);
    }

    if (!changed) {
      sanitizedErrors.set(source, source);
      return source;
    }
    return target;
  };

  return sanitizeError(error);
}

export interface AgentRunSpec {
  /** Slug of the deployed orchestration to run (its stable handle). */
  definition: string;
  /** Input passed to the orchestration's entry step. */
  input?: Record<string, unknown>;
  /** Optional idempotency key — a repeat with the same key returns the existing run. */
  idempotencyKey?: string;
  /**
   * Delayed dispatch (from inside a step): schedule the child to run at this time instead of now,
   * and pause on the returned handle — the step resumes with the child's result once it fires and
   * finishes. The handle is pause-only (`status`/`wait` throw), since the child doesn't exist until
   * the scheduled time. Accepts a `Date` or an ISO 8601 string (a `Date` is sent as UTC ISO).
   *
   * For a plain fire-and-forget one-off (no pause/resume), use `schedules.create` instead.
   */
  at?: string | Date;
}

/** A live, awaited run (the standalone `run()`/`wait()` result). */
export interface AgentRunResult {
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
 *     async run(result: AgentRunResultPayload, ctx) {
 *       if (result.status === "failed") { … }
 *     },
 *   });
 */
export type AgentRunResultPayload<TOutput = unknown> =
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

/** Thrown by {@link agentResultSchema}.parse on a malformed resume payload. */
export class AgentResultSchemaError extends Error {}

/**
 * Runtime validator for {@link AgentRunResultPayload}. `parse` returns the
 * value typed on success and throws an {@link AgentResultSchemaError} on any
 * divergence. Generic in the caller's expected `output` type — the shape of
 * `output` itself is the child orchestration's contract, not validated here.
 */
export const agentResultSchema = {
  parse<TOutput = unknown>(value: unknown): AgentRunResultPayload<TOutput> {
    const fail = (msg: string): never => {
      throw new AgentResultSchemaError(
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

    return value as AgentRunResultPayload<TOutput>;
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
  wait(opts?: { timeoutMs?: number; pollMs?: number }): Promise<AgentRunResult>;
}

/**
 */
function workflowResumeHeaders(
  token: string | undefined,
): Record<string, string> {
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

/**
 * Delayed dispatch: create a one-off schedule (carrying the parent resume token) instead of a run
 * now. The child fires at `spec.at`; when it finishes it resumes the step paused on this handle.
 * The correlation is derived from the created schedule's id (`trigger-<id>`) — the same value the
 * engine stamps on the eventually-fired child, so the resume lands. Pause-only: there is no child
 * to poll until the scheduled time, so `status`/`wait` throw.
 */
async function launchScheduled(
  spec: AgentRunSpec,
  input: Record<string, unknown>,
  transport: Transport,
  baseUrl: string,
): Promise<RunHandle> {
  const res = await transport.request<{ id: string }>(
    `${baseUrl}/agents/v1/definitions/${encodeURIComponent(spec.definition)}/triggers`,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "schedule_once",
        at: spec.at,
        input,
      }),
      headers: workflowResumeHeaders(transport.resumeToken),
    },
  );
  const notAvailable = (): never => {
    throw new Error(
      "status()/wait() are not available for a scheduled (delayed) dispatch — the child runs at the scheduled time. Use launch + pauseUntilSignal (not run).",
    );
  };
  return {
    executionId: "", // no child execution exists until the schedule fires
    dispatch: {
      correlationId: `trigger-${res.id}`,
      resultSignal: AGENTS_RESULT_SIGNAL,
    },
    status: notAvailable,
    wait: notAvailable,
  };
}

export async function launch(
  spec: AgentRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RunHandle> {
  const input = spec.input ?? {};
  const callsite = takeAgentRuntimeCallsite(spec);
  // Always consume an exact input receipt at an observed agent boundary. It is
  // forwarded only when this same invocation has trusted v1 build evidence.
  const inputLineageReceipt = takeAgentRuntimeLineage(input);
  if (spec.at) {
    return launchScheduled(spec, input, transport, baseUrl);
  }
  const provenanceHeaders: Record<string, string> = {};
  const privateProvenanceValues: string[] = [];
  if (callsite) {
    provenanceHeaders[AGENT_RUNTIME_PROVENANCE_VERSION_HEADER] = String(
      AGENT_RUNTIME_PROVENANCE_VERSION,
    );
    provenanceHeaders[AGENT_RUNTIME_CALLSITE_HEADER] = callsite;
    privateProvenanceValues.push(callsite);
    if (inputLineageReceipt) {
      provenanceHeaders[AGENT_RUNTIME_LINEAGE_HEADER] = inputLineageReceipt;
      privateProvenanceValues.push(inputLineageReceipt);
    }
  }
  let res: StartResponse;
  try {
    res = await transport.request<StartResponse>(
      `${baseUrl}/agents/v1/definitions/${encodeURIComponent(spec.definition)}/executions`,
      {
        method: "POST",
        body: JSON.stringify({
          input,
          idempotencyKey: spec.idempotencyKey,
        }),
        headers: {
          ...workflowResumeHeaders(transport.resumeToken),
          ...provenanceHeaders,
        },
      },
    );
  } catch (error) {
    throw redactedAgentRuntimeError(error, privateProvenanceValues);
  }
  const executionId = res.executionId;

  const fetchDoc = async (): Promise<{
    doc: ExecutionDoc;
    provenanceVersion: string | null;
    lineageReceipt: string | null;
  }> => {
    const url = `${baseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`;
    let response: Response;
    try {
      response = await transport.fetch(url, {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      throw redactedAgentRuntimeError(error, privateProvenanceValues);
    }
    const provenanceVersion =
      response.headers?.get?.(AGENT_RUNTIME_PROVENANCE_VERSION_HEADER) ?? null;
    const lineageReceipt =
      response.headers?.get?.(AGENT_RUNTIME_LINEAGE_HEADER) ?? null;
    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw redactedAgentRuntimeError(error, [
          ...privateProvenanceValues,
          lineageReceipt,
        ]);
      }
      throw new Error(
        redactAgentRuntimeProvenance(
          `GET ${url} → ${response.status} ${body}`,
          [...privateProvenanceValues, lineageReceipt],
        ),
      );
    }
    let doc: ExecutionDoc;
    try {
      doc = (await response.json()) as ExecutionDoc;
    } catch (error) {
      throw redactedAgentRuntimeError(error, [
        ...privateProvenanceValues,
        lineageReceipt,
      ]);
    }
    return {
      doc,
      provenanceVersion,
      lineageReceipt,
    };
  };

  return {
    executionId,
    // Framework plumbing for `pauseUntilSignal` — see DispatchHandle. correlationId
    // is this run's id (the resume's correlation key).
    dispatch: {
      correlationId: executionId,
      resultSignal: AGENTS_RESULT_SIGNAL,
    },
    async status() {
      return (await fetchDoc()).doc.status;
    },
    async wait({ timeoutMs = 60 * 60_000, pollMs = 3_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { doc: d, provenanceVersion, lineageReceipt } = await fetchDoc();
        if (TERMINAL.has(d.status)) {
          const result: AgentRunResult = {
            executionId,
            status: d.status,
            output: d.output ?? null,
            error: d.error ?? null,
          };
          const lineageTargets: object[] = [result];
          // This exact output object is the author-facing value commonly handed
          // to the next agent. Copies, nested values, and primitives remain
          // deliberately unassociated.
          if (d.output !== null && typeof d.output === "object") {
            lineageTargets.push(d.output);
          }
          retainAgentRuntimeLineage(
            lineageTargets,
            provenanceVersion,
            lineageReceipt,
          );
          return result;
        }
        if (Date.now() > deadline) {
          throw new Error(
            redactAgentRuntimeProvenance(
              `orchestration ${executionId} timed out after ${timeoutMs}ms (last status: ${d.status})`,
              [...privateProvenanceValues, lineageReceipt],
            ),
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

export async function run(
  spec: AgentRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<AgentRunResult> {
  const handle = await launch(spec, transport, baseUrl);
  return handle.wait();
}
