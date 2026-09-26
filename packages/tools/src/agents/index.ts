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
 * The two entry points report a REFUSED DISPATCH (unknown slug, input the engine's
 * pre-gate rejects, a transport fault) differently, because they return different
 * kinds of thing:
 *
 *   - `run` RESOLVES it as data — `status: "rejected"` with a structured
 *     {@link AgentRunError}. Its result is already discriminated on `status`, and
 *     to a coordinator "the child failed" and "the child never started" are one
 *     fact: this stage did not deliver. So `if (result.status !== "completed")`
 *     stays the single branch, and a fan-out coordinator needs no try/catch.
 *   - `launch` THROWS an {@link AgentDispatchError}. It returns a pausable
 *     handle, and a dispatch that produced no child has no handle to give: an
 *     object that cannot be paused on, whose `executionId` is null, would be
 *     lying about what it is. Catch it and `fail()` the step, or let it surface.
 *
 * Either way, only a refusal the platform PROVED is reported as "nothing was
 * created" (`status: "rejected"`, or `childMayExist: false` on the thrown
 * error). An ambiguous dispatch — a 5xx, or a response lost after the platform
 * accepted the request — is reported as `"unknown"` / `childMayExist: true`,
 * because a child may be running that we never learned the id of. Re-dispatch
 * only on the proven case, or pass an `idempotencyKey`.
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
 * How `wait()` (and `status()`) ride out a TRANSIENT status-read fault — a 429
 * or 408, a 5xx, or a transport fault such as a reset socket — instead of
 * ending the wait on it. Each option has a default; pass `wait({ retry })` to
 * override one.
 *
 * Why this exists (SAP-3615): the platform rate-limits the agents routes per
 * client IP, and every sandbox shares one egress IP. When ~100 parents polled
 * their children every 3 s in lockstep, a single 429 on a status read failed
 * the parent run outright — 236 of 413 runs in one incident. A poll that keeps
 * going, and spreads out when told to, is what a coordinator needs.
 */
export interface WaitRetryOptions {
  /**
   * Delay before the first retry after a fault, in ms. Doubles on each
   * consecutive fault (2 s, 4 s, 8 s, …) up to `maxBackoffMs`, with up to 20%
   * upward jitter so parents that tripped the same limit together do not
   * re-poll in step. A `Retry-After` header from the platform replaces the
   * computed delay for that retry. Default `2_000`.
   */
  initialBackoffMs?: number;
  /** Ceiling on a computed back-off delay, in ms. Default `30_000`. */
  maxBackoffMs?: number;
  /**
   * How many CONSECUTIVE transient faults `wait()` rides out before giving up
   * with `status: "unknown"` (carrying the last fault). A successful read
   * resets the count. With the default schedule twelve faults span about four
   * and a half minutes of back-off — enough to outlast a rate-limit window or a
   * deploy, far short of spending a whole `timeoutMs` on a platform that is
   * simply down. The caller's `timeoutMs` still bounds everything. Default `12`.
   */
  maxConsecutiveFaults?: number;
}

const DEFAULT_WAIT_RETRY: Required<WaitRetryOptions> = {
  initialBackoffMs: 2_000,
  maxBackoffMs: 30_000,
  maxConsecutiveFaults: 12,
};

/**
 * A `status()` read is a direct query, so it retries only briefly — this many
 * attempts on the default back-off (≈ 2 s + 4 s) — before throwing the fault.
 */
const STATUS_READ_ATTEMPTS = 3;

/**
 * Statuses that PROVE the platform created no child, so re-dispatching is safe.
 * Each is refused before (or instead of) any run row existing: no such
 * definition, input the pre-gate rejected, a credential declined.
 *
 * Everything else is ambiguous. A 5xx may have created the row and then failed;
 * a lost response (no status at all) may have been lost AFTER the platform
 * accepted the request. Those resolve `"unknown"`, never `"rejected"`.
 */
const PROVES_NO_CHILD = new Set([400, 401, 403, 404, 422]);

/**
 * Transient poll statuses below 500: the platform answered, but with "ask
 * again". Both clear on their own, so they must not end a `wait()` the way a
 * 404 does. Every 5xx is transient too; every other 4xx is permanent.
 */
const TRANSIENT_POLL_STATUSES = new Set([408, 429]);

/**
 * The SDK's own deadline message (`models`' and `wait()`'s "timed out after …ms").
 * Never a transient fault: it means a budget is spent, not that the platform
 * hiccupped, so a caller who wraps a poll in its own timeout is not retried into.
 */
const SDK_DEADLINE_MESSAGE = /\btimed out after \d+ms\b/;

/** `"GET https://… → 429 {…}"` — the transport's message shape, for a fallback status read. */
const STATUS_IN_MESSAGE = /\u2192 (\d{3})\b/;

/**
 * Every status an {@link AgentRunResult} can carry: a run's own lifecycle, plus
 * the three outcomes where no child lifecycle could be reported.
 *
 *   - `"rejected"`  — the dispatch was refused in a way that PROVES no run was
 *                     created (unknown slug, input the engine's pre-gate
 *                     refuses, a credential the platform declined).
 *                     `executionId` is `null`. This is the only status on which
 *                     re-dispatching is safe: nothing is running. Reached from
 *                     `run` only — `launch` throws {@link AgentDispatchError}
 *                     for the same condition.
 *   - `"timed_out"` — the run was created and is likely still going; `wait()`
 *                     stopped polling at its `timeoutMs`. `executionId` is set.
 *   - `"unknown"`   — a child MAY EXIST and may still be running, so do not
 *                     dispatch a second copy. Two ways to get here:
 *                       · the run was created but its status could not be read
 *                         (the read was refused, or kept faulting) —
 *                         `executionId` is set, so you can check on it;
 *                       · the DISPATCH itself was ambiguous (a 5xx, or a
 *                         response lost after the platform accepted the
 *                         request) — `executionId` is `null`, because no id was
 *                         ever returned to us.
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
 * validation issues — and `null` for a transport fault. On a `"timeout"` it is
 * the {@link AgentRunError} of the poll fault the deadline interrupted (say,
 * the 429 the loop was backing off from), or `null` when the last read
 * succeeded.
 */
export interface AgentRunError {
  code: AgentRunErrorCode;
  message: string;
  /** HTTP status the platform answered with; `null` when there was no response. */
  status: number | null;
  /** Parsed platform response body (or its raw text); `null` when there was none. */
  details: unknown;
}

/**
 * Thrown by `launch` when the DISPATCH is refused, so no child run was created:
 * an unknown slug (404), input the engine's pre-gate rejects (400/422), any
 * other non-2xx, or a transport fault.
 *
 *   try {
 *     const child = await ctx.sapiom.agents.launch({ definition, input });
 *     return pauseUntilSignal(child, { resumeStep: "use-result" });
 *   } catch (error) {
 *     if (error instanceof AgentDispatchError) return fail(error.message);
 *     throw error;
 *   }
 *
 * `run` does NOT throw this — it converts the same rejection into an
 * {@link AgentRunResult} with `status: "rejected"` and this error's fields as
 * its `AgentRunError`.
 *
 * NOTE: uncaught, this is an ordinary step throw, so the engine retries it up
 * to `maxAttemptsPerStep` before failing the run. A refused dispatch is
 * deterministic and will not self-heal, so catch it and `fail()` rather than
 * letting the retry cap burn. (Making it terminal-without-retry needs the
 * engine's non-retryable set to admit it — see `non-retryable-step-error.ts`.)
 */
export class AgentDispatchError extends Error {
  /** Coarse, author-facing bucket — see {@link AgentRunErrorCode}. */
  readonly code: AgentRunErrorCode;
  /** HTTP status the platform answered with; `null` for a transport fault. */
  readonly status: number | null;
  /** Parsed platform response body (or its raw text); `null` when there was none. */
  readonly details: unknown;
  /**
   * Whether a child may have been created anyway. `false` only when the
   * platform's answer PROVES it created nothing (unknown slug, refused input,
   * declined credential — see {@link PROVES_NO_CHILD}).
   *
   * `true` means the outcome is ambiguous: a 5xx may have created the run row
   * and then failed, and a lost response may have been lost after the platform
   * accepted the request. DO NOT re-dispatch on `true` without an
   * `idempotencyKey` — you may start a second copy of a live child.
   */
  readonly childMayExist: boolean;

  constructor(error: AgentRunError) {
    super(error.message);
    this.name = "AgentDispatchError";
    this.code = error.code;
    this.status = error.status;
    this.details = error.details;
    this.childMayExist =
      error.status === null || !PROVES_NO_CHILD.has(error.status);
  }

  /** This rejection as the `error` of a non-completed {@link AgentRunResult}. */
  toRunError(): AgentRunError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
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
   * The child run's id, or `null` when no id was ever returned to us: a
   * `"rejected"` dispatch (nothing was created) or an ambiguous one
   * (`"unknown"` — something may have been created, but we never learned its
   * id). Set on every other status, including a `"unknown"` that came from a
   * failed status read and every `"timed_out"`.
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
 * A launched-but-not-awaited child run. Satisfies {@link DispatchHandle}, so it can
 * be handed straight to `pauseUntilSignal(handle, { resumeStep })` to suspend the
 * step until the child finishes — or `wait()`-ed inline for standalone use.
 *
 * Every handle you receive is pausable: `launch` throws rather than handing back a
 * handle for a dispatch that created no child.
 */
export interface RunHandle extends DispatchHandle {
  /**
   * The child run's id. `null` only for a delayed dispatch (`spec.at`), whose
   * child does not exist until the scheduled time. A refused dispatch never
   * produces a handle at all — `launch` throws {@link AgentDispatchError}.
   */
  executionId: string | null;
  /**
   * Fetch the current status without blocking on the run. A transient fault
   * (429/408, 5xx, a transport error) is retried a few times on the default
   * back-off, honouring `Retry-After`; then, and on any other failure at once
   * (404 — the run is gone; 401/403), the error IS thrown. Unlike `wait()` this
   * is a direct query with a direct answer.
   */
  status(): Promise<ExecutionStatus>;
  /**
   * Poll to a terminal state and resolve the run result. Never throws: a
   * rejected dispatch (`"rejected"`), a status read that fails or keeps
   * faulting (`"unknown"`), and hitting `timeoutMs` (`"timed_out"`) all resolve
   * a non-completed {@link AgentRunResult}.
   *
   * Polls every `pollMs` while the run is going. A TRANSIENT fault on a read —
   * 429 or 408, any 5xx, a transport error such as `fetch failed` /
   * `ECONNRESET` — does not end the wait: the loop backs off (2 s, 4 s, 8 s, …
   * capped at 30 s, with jitter; a `Retry-After` header wins when the platform
   * sends one) and reads again, up to `retry.maxConsecutiveFaults` (12) in a
   * row before resolving `"unknown"` with the last fault. A successful read
   * resets the count. A permanent fault (404, 401/403, a malformed body)
   * resolves `"unknown"` at once. No back-off ever outlasts `timeoutMs`: the
   * deadline is checked before every sleep, and a sleep is clamped to it.
   *
   * From inside a step, prefer `launch` + `pauseUntilSignal(handle, …)` for a
   * long child: the step suspends and resumes on the child's result signal,
   * making NO poll calls at all — so it cannot be rate-limited, and holds no
   * sandbox while it waits. `wait()`/`run` are for standalone, inline use.
   */
  wait(opts?: {
    timeoutMs?: number;
    pollMs?: number;
    /** Back-off for transient read faults — see {@link WaitRetryOptions}. */
    retry?: WaitRetryOptions;
  }): Promise<AgentRunResult>;
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
  // A transport that threw a plain Error for a non-2xx (an older or
  // third-party one) still names the status in the message — recover it, so a
  // 429 is not mistaken for a socket fault. Never matches a transport fault
  // (`fetch failed`, `ECONNRESET`), which carries no arrow-status.
  const message = error instanceof Error ? error.message : String(error);
  const statusInMessage = STATUS_IN_MESSAGE.exec(message);
  if (statusInMessage) {
    const status = Number(statusInMessage[1]);
    return {
      code:
        status === 404
          ? "not_found"
          : status === 400 || status === 422
            ? "invalid_input"
            : "http",
      message,
      status,
      details: null,
    };
  }
  return {
    code: "transport",
    message,
    status: null,
    details: null,
  };
}

/** A status-read fault, classified for the poll loop. */
interface PollFault {
  runError: AgentRunError;
  /** Whether reading again may succeed — see {@link isTransientPollFault}. */
  transient: boolean;
  /** The platform's `Retry-After`, in ms, when the transport exposed one. */
  retryAfterMs: number | null;
}

/**
 * Whether a status-read fault may clear on its own, so the loop should back off
 * and read again rather than give up:
 *
 *   - 408/429 and every 5xx: the platform said "ask again" or fell over — yes.
 *   - any other 4xx (404 gone, 401/403 declined): deterministic — no.
 *   - no status at all: a transport fault (DNS, reset socket, aborted fetch,
 *     `fetch failed`) — yes, EXCEPT a malformed 2xx body (a `SyntaxError` from
 *     the JSON parse, i.e. a contract break) or the SDK's own deadline error,
 *     neither of which a retry can fix.
 */
function isTransientPollFault(
  error: unknown,
  runError: AgentRunError,
): boolean {
  if (runError.status !== null) {
    return (
      runError.status >= 500 || TRANSIENT_POLL_STATUSES.has(runError.status)
    );
  }
  if (error instanceof SyntaxError) return false;
  if (SDK_DEADLINE_MESSAGE.test(runError.message)) return false;
  return true;
}

function classifyPollFault(error: unknown): PollFault {
  const runError = asRunError(error);
  return {
    runError,
    transient: isTransientPollFault(error, runError),
    retryAfterMs:
      error instanceof TransportHttpError ? error.retryAfterMs : null,
  };
}

/**
 * Delay before retry number `attempt` (1-based) of a run of consecutive
 * transient faults. The platform's `Retry-After` wins when it sent a positive
 * one; otherwise the delay doubles from `initialBackoffMs` and is capped at
 * `maxBackoffMs`. Either way up to 20% jitter is added (upward, so a
 * `Retry-After` is never undercut) — parents that tripped one rate limit
 * together must not come back together.
 */
function backoffMs(
  fault: PollFault,
  attempt: number,
  policy: Required<WaitRetryOptions>,
): number {
  const jitter = 1 + Math.random() * 0.2;
  if (fault.retryAfterMs !== null && fault.retryAfterMs > 0) {
    return Math.round(fault.retryAfterMs * jitter);
  }
  const doubled = policy.initialBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(Math.min(policy.maxBackoffMs, doubled * jitter));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The platform's own `message` from an error body, when it sent a usable one. */
function platformMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = (body as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
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
    // Same contract as an immediate dispatch: there is no handle to give for a
    // schedule the platform refused.
    throw new AgentDispatchError(asRunError(error));
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
    // pre-gate rejected (400), a transport fault. No child run exists, so there
    // is no pausable handle to return: throw a typed error the author can catch
    // and route to `fail()`. `run()` converts this same rejection into data.
    // See SAP-3219.
    throw new AgentDispatchError(asRunError(error));
  }
  const executionId = res.executionId;

  const fetchDoc = () =>
    transport.request<ExecutionDoc>(
      `${baseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`,
    );

  // `status()` is a direct query, so it rides out only a short run of transient
  // faults before throwing the last one — long enough to survive one
  // rate-limit answer, short enough to still be "fetch the status".
  const fetchDocBriefly = async (): Promise<ExecutionDoc> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetchDoc();
      } catch (error) {
        const fault = classifyPollFault(error);
        if (!fault.transient || attempt >= STATUS_READ_ATTEMPTS) throw error;
        await sleep(backoffMs(fault, attempt, DEFAULT_WAIT_RETRY));
      }
    }
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
      return (await fetchDocBriefly()).status;
    },
    async wait({ timeoutMs = 60 * 60_000, pollMs = 3_000, retry = {} } = {}) {
      const policy: Required<WaitRetryOptions> = {
        initialBackoffMs:
          retry.initialBackoffMs ?? DEFAULT_WAIT_RETRY.initialBackoffMs,
        maxBackoffMs: retry.maxBackoffMs ?? DEFAULT_WAIT_RETRY.maxBackoffMs,
        maxConsecutiveFaults:
          retry.maxConsecutiveFaults ?? DEFAULT_WAIT_RETRY.maxConsecutiveFaults,
      };
      const deadline = Date.now() + timeoutMs;
      // Not "unknown" — that is now a real status, and this string only ever
      // lands in the timeout message as "we never read one".
      let lastStatus = "unread";
      let consecutiveFaults = 0;
      // The fault the loop was backing off from when the deadline fell, if any
      // — reported in the timeout's `details` so a 429 storm is diagnosable.
      let lastFault: AgentRunError | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let delayMs = pollMs;
        try {
          const d = await fetchDoc();
          consecutiveFaults = 0;
          lastFault = null;
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
          const fault = classifyPollFault(error);
          consecutiveFaults += 1;
          lastFault = fault.runError;
          // The run EXISTS — only reading its status failed — so this is never
          // `"rejected"`: an author who read that as "nothing was dispatched"
          // would start a second copy of a live child.
          //
          // A permanent fault (execution gone, credential declined, malformed
          // body) won't cure itself, so give up at once. A transient one —
          // 408/429 ("ask again"), a 5xx, a transport blip — is ridden out with
          // back-off, bounded by `maxConsecutiveFaults` because a real outage
          // would otherwise burn the whole `timeoutMs` on doomed requests.
          const hopeless =
            !fault.transient ||
            consecutiveFaults >= policy.maxConsecutiveFaults;
          if (hopeless) {
            return {
              executionId,
              status: "unknown",
              output: null,
              error: fault.runError,
            };
          }
          delayMs = backoffMs(fault, consecutiveFaults, policy);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
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
              details: lastFault,
            },
          };
        }
        // A back-off never outlasts the caller's budget: clamp it, so the last
        // read lands at the deadline's edge rather than well past it.
        await sleep(Math.min(delayMs, remainingMs));
      }
    },
  };
}

/**
 * `launch` + `wait` — block until the run reaches a terminal state and resolve
 * its result. Failure is data on every path: a failed child, a REFUSED DISPATCH
 * (unknown slug, refused input, transport fault) and a `wait()` timeout all
 * resolve an {@link AgentRunResult} whose `status` is not `"completed"`, so
 * `if (result.status !== "completed")` is the single branch a coordinator needs
 * and no try/catch is required.
 *
 * Unlike `launch`, this does not throw {@link AgentDispatchError} — it converts
 * it to `status: "rejected"`. `launch` throws because it owes the caller a
 * pausable handle and a refused dispatch has none; `run` owes a result, and a
 * result can carry the rejection.
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
  let handle: RunHandle;
  try {
    handle = await launch(spec, transport, baseUrl);
  } catch (error) {
    if (error instanceof AgentDispatchError) {
      return {
        executionId: null,
        // `"rejected"` promises the caller that nothing is running, so it is
        // reserved for a refusal the platform's answer PROVES. An ambiguous
        // dispatch (5xx, or a response lost after the platform accepted the
        // request) may have created a child we never learned the id of —
        // `"unknown"` says exactly that, and warns off a blind re-dispatch.
        status: error.childMayExist ? "unknown" : "rejected",
        output: null,
        error: error.toRunError(),
      };
    }
    throw error;
  }
  return handle.wait();
}
