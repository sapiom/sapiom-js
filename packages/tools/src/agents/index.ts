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
 *
 * Failure is data on EVERY path, including a rejected dispatch. An unknown slug,
 * input the engine's pre-gate refuses, or a transport fault does not throw out of
 * `run`/`launch` — it resolves an {@link AgentRunResult} with `status: "rejected"`
 * and a structured {@link AgentRunError}. So `if (result.status !== "completed")`
 * stays the single branch an author writes, whether the child failed or never
 * started. (`launch` still returns a handle, but a REJECTED one carries no
 * `dispatch` — there is no child to pause on; see {@link RunHandle}.)
 */
import {
  Transport,
  TransportHttpError,
  defaultTransport,
} from "../_client/index.js";
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

/**
 * How many CONSECUTIVE failed status reads `wait()` rides out before giving up
 * with `status: "unknown"`. Enough to survive a blip or a single bad node; far
 * short of spending a full `timeoutMs` (60 min / 3 s ≈ 1200 requests) on a
 * platform that is simply down.
 */
const MAX_CONSECUTIVE_POLL_FAULTS = 5;

/**
 * Every status an {@link AgentRunResult} can carry: a run's own lifecycle, plus
 * the three outcomes where no child lifecycle could be reported.
 *
 *   - `"rejected"`  — the DISPATCH was refused, so NO RUN WAS EVER CREATED
 *                     (unknown slug, input the engine's pre-gate refuses, a
 *                     transport fault, a credential the platform declined).
 *                     `executionId` is `null`. This is the only status on which
 *                     re-dispatching is safe: nothing is running.
 *   - `"timed_out"` — the run was created and is likely still going; `wait()`
 *                     stopped polling at its `timeoutMs`. `executionId` is set.
 *   - `"unknown"`   — the run was created, but its status could not be read:
 *                     the read was refused (execution gone, credential
 *                     declined) or kept faulting. `executionId` is set and the
 *                     child MAY STILL BE RUNNING — check on it rather than
 *                     dispatching a second copy.
 *
 * All three are NON-completed statuses, which is all an author needs for the
 * common branch: `if (result.status !== "completed")` covers them alongside
 * `failed`. Only re-dispatch logic has to tell `"rejected"` from the other two.
 */
export type AgentRunStatus =
  | ExecutionStatus
  | "rejected"
  | "timed_out"
  | "unknown";

/**
 * Why an {@link AgentRunResult} carries `status: "rejected"`, `"unknown"` or
 * `"timed_out"`. The first four describe the HTTP call that failed — the
 * dispatch on `"rejected"`, the status read on `"unknown"`.
 */
export type AgentRunErrorCode =
  /** 404 — no deployed orchestration answers to that slug (or the run is gone). */
  | "not_found"
  /** 400/422 — the engine's input pre-gate refused `input`. */
  | "invalid_input"
  /** Any other non-2xx from the platform (401/403/409/5xx). */
  | "http"
  /** The request never got an answer: DNS, socket, abort, missing credential. */
  | "transport"
  /**
   * `wait()` hit its `timeoutMs` while the run was still going. Paired only
   * with `status: "timed_out"` — a poll that kept faulting resolves
   * `status: "unknown"` and keeps the underlying `http`/`transport` code.
   */
  | "timeout";

/**
 * A dispatch rejection, an unreadable status, or a `wait()` timeout as data.
 * `details` is the parsed platform response body when there was one — it
 * carries the platform's own stable `code` (e.g. `"step_input_invalid"`) and
 * validation issues — and `null` for a transport fault or a timeout.
 */
export interface AgentRunError {
  code: AgentRunErrorCode;
  message: string;
  /** HTTP status the platform answered with; `null` when there was no response. */
  status: number | null;
  /** Parsed platform response body (or its raw text); `null` when there was none. */
  details: unknown;
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

/**
 * The standalone `run()`/`wait()` result. Resolved on every outcome — a completed
 * run, a failed run, a rejected dispatch, a `wait()` timeout — so failure is
 * always data to branch on and never a thrown exception.
 */
export interface AgentRunResult {
  /**
   * The child run's id. `null` only when no run exists to name: a rejected
   * dispatch (`status: "rejected"`). Set on every other status, `"unknown"` and
   * `"timed_out"` included — the run is out there and can be checked on.
   */
  executionId: string | null;
  status: AgentRunStatus;
  /** The run's output on `"completed"`; `null` otherwise. */
  output: unknown;
  /**
   * The child's own error on `"failed"` (whatever shape it reported), or an
   * {@link AgentRunError} on `"rejected"` / `"unknown"` / `"timed_out"`.
   * `null` on success.
   */
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
 *
 * There is deliberately no `"rejected"` variant here, unlike
 * {@link AgentRunResult}: a rejected dispatch never creates a child, so nothing
 * ever fires the resume signal and no resume payload is produced. That rejection
 * surfaces on the `launch` handle and from `run`/`wait` instead.
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
 * A launched-but-not-awaited child run. Normally satisfies {@link DispatchHandle},
 * so it can be handed straight to `pauseUntilSignal(handle, { resumeStep })` to
 * suspend the step until the child finishes — or `wait()`-ed inline for standalone
 * use. A handle from a REJECTED dispatch is the exception: no child exists, so it
 * carries no `dispatch` and cannot be paused on (see `dispatch`/`rejection`).
 */
export interface RunHandle {
  /**
   * The child run's id. `null` when there is no run to name: a rejected
   * dispatch, or a delayed dispatch (`spec.at`) whose child doesn't exist until
   * the scheduled time.
   */
  executionId: string | null;
  /**
   * @internal Framework plumbing consumed by `pauseUntilSignal`.
   *
   * ABSENT when the dispatch was rejected: no child exists, so nothing will ever
   * fire the resume signal and the handle is not pausable. Pausing on such a
   * handle throws from `pauseUntilSignal` rather than hanging until the pause
   * times out — branch on {@link RunHandle.rejection} (or `await wait()`) first.
   */
  readonly dispatch?: DispatchHandle["dispatch"];
  /**
   * Set — and `dispatch` unset — exactly when the dispatch was rejected. The
   * cheap check before pausing:
   *
   *   const child = await ctx.sapiom.orchestrations.launch({ definition, input });
   *   if (child.rejection) return fail(`dispatch rejected: ${child.rejection.message}`);
   *   return pauseUntilSignal(child, { resumeStep: "use-result" });
   */
  readonly rejection?: AgentRunError;
  /**
   * Fetch the current status without blocking. `"rejected"` (without a request)
   * on a rejected handle. Unlike `wait()` this is a direct query, so a transport
   * fault reading the status DOES throw.
   */
  status(): Promise<AgentRunStatus>;
  /**
   * Poll to a terminal state and resolve the run result. Never throws: a
   * rejected dispatch (`"rejected"`), a status read that fails or keeps
   * faulting (`"unknown"`), and hitting `timeoutMs` (`"timed_out"`) all resolve
   * a non-completed {@link AgentRunResult}.
   */
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
 * Classify a thrown dispatch/poll failure as an {@link AgentRunError}. The
 * platform's own body (which carries its stable `code` and any validation
 * issues) is preserved verbatim in `details`; `code` here is the coarse,
 * author-facing bucket derived from the status.
 */
function asRunError(error: unknown): AgentRunError {
  if (error instanceof TransportHttpError) {
    return {
      code:
        error.status === 404
          ? "not_found"
          : error.status === 400 || error.status === 422
            ? "invalid_input"
            : "http",
      message: platformMessage(error.body) ?? error.message,
      status: error.status,
      details: error.body,
    };
  }
  return {
    code: "transport",
    message: error instanceof Error ? error.message : String(error),
    status: null,
    details: null,
  };
}

/** The platform's own `message` from an error body, when it sent a usable one. */
function platformMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = (body as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * The handle a REJECTED dispatch resolves to: no `dispatch` (nothing exists to
 * pause on), the rejection readable off the handle, and `wait()` resolving it as
 * an {@link AgentRunResult} so `run()` — which is `launch().wait()` — returns
 * the rejection as data instead of throwing.
 */
function rejectedHandle(rejection: AgentRunError): RunHandle {
  const result: AgentRunResult = {
    executionId: null,
    status: "rejected",
    output: null,
    error: rejection,
  };
  return {
    executionId: null,
    rejection,
    status: () => Promise.resolve("rejected"),
    wait: () => Promise.resolve(result),
  };
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
  transport: Transport,
  baseUrl: string,
): Promise<RunHandle> {
  let res: { id: string };
  try {
    res = await transport.request<{ id: string }>(
      `${baseUrl}/agents/v1/definitions/${encodeURIComponent(spec.definition)}/triggers`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "schedule_once",
          at: spec.at,
          input: spec.input ?? {},
        }),
        headers: workflowResumeHeaders(transport.resumeToken),
      },
    );
  } catch (error) {
    // Same contract as an immediate dispatch: a refused schedule is data, not a
    // throw. The handle carries no `dispatch`, so it isn't pausable.
    return rejectedHandle(asRunError(error));
  }
  const notAvailable = (): never => {
    throw new Error(
      "status()/wait() are not available for a scheduled (delayed) dispatch — the child runs at the scheduled time. Use launch + pauseUntilSignal (not run).",
    );
  };
  return {
    executionId: null, // no child execution exists until the schedule fires
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
  if (spec.at) {
    return launchScheduled(spec, transport, baseUrl);
  }
  let res: StartResponse;
  try {
    res = await transport.request<StartResponse>(
      `${baseUrl}/agents/v1/definitions/${encodeURIComponent(spec.definition)}/executions`,
      {
        method: "POST",
        body: JSON.stringify({
          input: spec.input ?? {},
          idempotencyKey: spec.idempotencyKey,
        }),
        headers: workflowResumeHeaders(transport.resumeToken),
      },
    );
  } catch (error) {
    // The dispatch itself was refused — unknown slug (404), input the engine's
    // pre-gate rejected (400), a transport fault. No child run exists, so this
    // resolves as data (`status: "rejected"`) rather than throwing: a
    // coordinator dispatching several children must be able to branch on one
    // bad slug without the whole calling step blowing up. See SAP-3219.
    return rejectedHandle(asRunError(error));
  }
  const executionId = res.executionId;

  const fetchDoc = () =>
    transport.request<ExecutionDoc>(
      `${baseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`,
    );

  return {
    executionId,
    // Framework plumbing for `pauseUntilSignal` — see DispatchHandle. correlationId
    // is this run's id (the resume's correlation key).
    dispatch: {
      correlationId: executionId,
      resultSignal: AGENTS_RESULT_SIGNAL,
    },
    async status() {
      return (await fetchDoc()).status;
    },
    async wait({ timeoutMs = 60 * 60_000, pollMs = 3_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastStatus = "unknown";
      let consecutiveFaults = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const d = await fetchDoc();
          consecutiveFaults = 0;
          lastStatus = d.status;
          if (TERMINAL.has(d.status)) {
            return {
              executionId,
              status: d.status,
              output: d.output ?? null,
              error: d.error ?? null,
            };
          }
        } catch (error) {
          const pollError = asRunError(error);
          consecutiveFaults += 1;
          // The run EXISTS — only reading its status failed — so this is never
          // `"rejected"`: an author who read that as "nothing was dispatched"
          // would start a second copy of a live child.
          //
          // A 4xx won't cure itself (execution gone, credential declined), so
          // give up at once. A 5xx or transport fault may be a blip, so ride a
          // few out — but bounded, because a real outage would otherwise burn
          // the whole `timeoutMs` on doomed requests.
          const hopeless =
            (pollError.status !== null && pollError.status < 500) ||
            consecutiveFaults >= MAX_CONSECUTIVE_POLL_FAULTS;
          if (hopeless) {
            return {
              executionId,
              status: "unknown",
              output: null,
              error: pollError,
            };
          }
        }
        if (Date.now() > deadline) {
          // Not a throw: the run is still out there, and `executionId` lets the
          // caller check on it later. Timing out is one more non-completed
          // status to branch on.
          return {
            executionId,
            status: "timed_out",
            output: null,
            error: {
              code: "timeout",
              message: `orchestration ${executionId} timed out after ${timeoutMs}ms (last status: ${lastStatus})`,
              status: null,
              details: null,
            },
          };
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

/**
 * `launch` + `wait` — block until the run reaches a terminal state and resolve
 * its result. Never throws: a failed child, a rejected dispatch (unknown slug,
 * refused input, transport fault) and a `wait()` timeout all resolve an
 * {@link AgentRunResult} whose `status` is not `"completed"`.
 *
 * The one exception is a delayed dispatch (`spec.at`): there is no run to wait
 * on until the scheduled time, so `run` throws the same way `wait` does on that
 * handle. Use `launch` + `pauseUntilSignal` for a delayed child.
 */
export async function run(
  spec: AgentRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<AgentRunResult> {
  const handle = await launch(spec, transport, baseUrl);
  return handle.wait();
}
