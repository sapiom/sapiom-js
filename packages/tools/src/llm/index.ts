/**
 * `llm` capability — deferred-start routed LLM calls (the LLM gateway's submit-job
 * seam, `POST /v2/route/async`).
 *
 * Unlike `agent.run` (a full in-server loop), this routes ONE LLM call through the
 * gateway's capacity-aware admission: `submit` asks for the call and returns a
 * handle immediately; the gateway holds the job ordered by deadline and — when a
 * model has room, or the deadline is close enough to escalate toward run-now —
 * mints a single-use link and reports back. The request body itself is NEVER
 * stored by the gateway: the caller re-sends it at redemption (`redeem`).
 *
 *   const handle = await ctx.sapiom.llm.submit({
 *     request: { messages: [{ role: "user", content: "…" }], max_tokens: 512 },
 *     model: "smart",
 *     deadlineMinutes: 30,
 *   });
 *   return pauseUntilSignal(handle, { resumeStep: "use-answer" });
 *
 *   // …and in the resumed step (input: LlmRouteResultPayload):
 *   const reply = await ctx.sapiom.llm.redeem(input.link!, savedRequestBody);
 *
 * Inside a workflow the engine's resume token (ambient on the transport) rides the
 * `x-sapiom-workflow-token` header; the gateway echoes it in its webhook so the
 * engine's forwarder can resume the paused step. Standalone callers can instead
 * poll `handle.wait()` — same admission, no pause.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import type { DispatchHandle } from "../dispatch.js";

const DEFAULT_BASE_URL = resolveServiceUrl("llm", process.env.SAPIOM_LLM_URL);

/**
 * Capability-stable signal a routed job fires when it reaches a terminal state
 * (granted OR failed — it carries the result either way, the resumed step
 * branches). A workflow step paused on a submit handle resumes on this; it is the
 * value carried in the handle's `dispatch.resultSignal`.
 */
export const LLM_ROUTE_RESULT_SIGNAL = "llm.route.result";

/** Job lifecycle, mirrored from the gateway's async status endpoint. */
export type LlmRouteStatus =
  | "queued"
  | "granted"
  | "consumed"
  | "failed"
  | "expired"
  | "lost"
  | "not_found";
const TERMINAL = new Set<LlmRouteStatus>([
  "granted",
  "consumed",
  "failed",
  "expired",
  "lost",
]);

export interface LlmSubmitSpec {
  /**
   * The verbatim LLM request (Anthropic messages shape). Used only to estimate
   * routing weight at submit — the gateway does NOT store it; keep it (e.g. in
   * `ctx.shared`) and re-send it to `redeem` when the grant arrives.
   */
  request: Record<string, unknown>;
  /** Model pin, or `"smart"` for smart routing. Gateway default when omitted. */
  model?: string;
  /**
   * How long the caller will wait, in minutes. Omitted or <= 0 → run-now (top
   * priority, immediate escalation). The gateway orders jobs earliest-deadline-
   * first and escalates toward run-now as the deadline nears.
   */
  deadlineMinutes?: number;
  /** Explicit complexity/capacity weight override (gateway clamps to its bounds). */
  complexity?: number;
  /**
   * Where the gateway reports the grant (or failure). Inside a workflow leave it
   * unset — the engine injects `SAPIOM_LLM_WEBHOOK_URL` (its resume forwarder).
   * Standalone callers must pass one, or rely purely on `handle.wait()` polling
   * via a URL of their own.
   */
  webhookUrl?: string;
  /** HMAC secret: the gateway signs the webhook body as `X-Sapiom-Signature`. */
  webhookSecret?: string;
}

/**
 * The single-use link a granted job carries: call `POST {anthropicBaseUrl}/v1/messages`
 * with `apiKey` (or hand both to `redeem`). Spent on first use; expires at
 * `expiresAtMs` if never redeemed.
 */
export interface LlmGrantLink {
  anthropicBaseUrl: string;
  apiKey: string;
  /** USER-FACING model label (e.g. `"smart"`, `"m2.7"`) — the provider is never disclosed. */
  model: string;
  expiresAtMs: number;
  usage: string;
}

/**
 * The routed job's terminal result as it arrives at a step **resumed** from
 * `pauseUntilSignal(handle, { resumeStep })` — the signal payload delivered as
 * that step's `input`. `link` is present iff `status === "granted"`; on
 * `"failed"`, `error` says why (e.g. `deadline_exhausted`, `grant_mint_failed`,
 * `expired`, `lost`). Annotate the resumed step's input with this.
 */
export interface LlmRouteResultPayload {
  executionId: string;
  status: "granted" | "failed";
  link: LlmGrantLink | null;
  error: string | null;
}

/** Thrown by {@link llmRouteResultSchema}.parse on a malformed resume payload. */
export class LlmRouteResultSchemaError extends Error {}

/** Runtime validator for {@link LlmRouteResultPayload}. */
export const llmRouteResultSchema = {
  parse(value: unknown): LlmRouteResultPayload {
    const fail = (msg: string): never => {
      throw new LlmRouteResultSchemaError(
        `invalid llm route result payload: ${msg}`,
      );
    };
    if (!value || typeof value !== "object") fail("not an object");
    const v = value as Record<string, unknown>;
    if (typeof v.executionId !== "string")
      fail("executionId must be a string");
    if (v.status !== "granted" && v.status !== "failed")
      fail('status must be "granted" or "failed"');
    if (v.error !== null && typeof v.error !== "string")
      fail("error must be a string or null");
    if (!("link" in v)) fail("link is required (use null on failure)");
    if (v.link !== null) {
      const l = v.link as Record<string, unknown>;
      if (!l || typeof l !== "object") fail("link must be an object or null");
      if (typeof l.anthropicBaseUrl !== "string")
        fail("link.anthropicBaseUrl must be a string");
      if (typeof l.apiKey !== "string") fail("link.apiKey must be a string");
      if (typeof l.model !== "string") fail("link.model must be a string");
      if (typeof l.expiresAtMs !== "number")
        fail("link.expiresAtMs must be a number");
    }
    return value as LlmRouteResultPayload;
  },
};

/**
 * A submitted-but-not-awaited routed job. Satisfies {@link DispatchHandle}, so it
 * can be handed straight to `pauseUntilSignal(handle, { resumeStep })` to suspend
 * a workflow step until the gateway grants (or fails) it — or `wait()`-ed inline
 * for standalone use (polls the gateway's status endpoint).
 */
export interface LlmRouteHandle extends DispatchHandle {
  executionId: string;
  /** Fetch the current lifecycle status without blocking. */
  status(): Promise<LlmRouteStatus>;
  /** Poll to a terminal state and resolve the result payload. */
  wait(opts?: {
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<LlmRouteResultPayload>;
}

/** Same header the engine resume token rides on coding/agent launches. */
function workflowResumeHeaders(
  token: string | undefined,
): Record<string, string> {
  return token ? { "x-sapiom-workflow-token": token } : {};
}

// --- wire shapes (snake_case, as served by the gateway) ---

interface SubmitDoc {
  execution_id: string;
  status: string;
  poll?: string;
}

interface WireLink {
  anthropic_base_url: string;
  api_key: string;
  model: string;
  expires_at_ms: number;
  usage?: string;
}

interface StatusDoc {
  execution_id: string;
  status: LlmRouteStatus;
  link?: WireLink | null;
  error?: string | null;
}

function mapLink(l: WireLink | null | undefined): LlmGrantLink | null {
  if (!l) return null;
  return {
    anthropicBaseUrl: l.anthropic_base_url,
    apiKey: l.api_key,
    model: l.model,
    expiresAtMs: l.expires_at_ms,
    usage: l.usage ?? "single_request",
  };
}

function toPayload(executionId: string, d: StatusDoc): LlmRouteResultPayload {
  // consumed = granted-and-already-redeemed; the link is spent, so surface it as a
  // failure rather than handing back a dead credential. expired/lost carry their
  // wire status as the error.
  if (d.status === "granted") {
    return {
      executionId,
      status: "granted",
      link: mapLink(d.link),
      error: null,
    };
  }
  return {
    executionId,
    status: "failed",
    link: null,
    error: d.error ?? d.status,
  };
}

function submitHeaders(spec: LlmSubmitSpec, resumeToken: string | undefined) {
  const webhookUrl = spec.webhookUrl ?? process.env.SAPIOM_LLM_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error(
      "llm.submit: no webhook URL. Inside a workflow the engine injects " +
        "SAPIOM_LLM_WEBHOOK_URL; standalone callers must pass { webhookUrl }.",
    );
  }
  const h: Record<string, string> = {
    "x-sapiom-webhook-url": webhookUrl,
    ...workflowResumeHeaders(resumeToken),
  };
  if (spec.webhookSecret) h["x-sapiom-webhook-secret"] = spec.webhookSecret;
  if (spec.model) h["x-sapiom-model"] = spec.model;
  if (spec.deadlineMinutes !== undefined)
    h["x-sapiom-deadline"] = String(spec.deadlineMinutes);
  if (spec.complexity !== undefined)
    h["x-sapiom-complexity"] = String(spec.complexity);
  return h;
}

export async function submit(
  spec: LlmSubmitSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<LlmRouteHandle> {
  // 202 + {execution_id, status: "queued", poll}. The LLM gateway authenticates the
  // tenant virtual key Anthropic-style (x-api-key), not via x-sapiom-api-key.
  const doc = await transport.request<SubmitDoc>(
    `${baseUrl}/v2/route/async`,
    {
      method: "POST",
      body: JSON.stringify(spec.request),
      headers: submitHeaders(spec, transport.resumeToken),
    },
    { authHeader: "x-api-key" },
  );
  const executionId = doc.execution_id;

  const fetchDoc = () =>
    transport.request<StatusDoc>(
      `${baseUrl}/v2/route/async/${encodeURIComponent(executionId)}`,
      {},
      { authHeader: "x-api-key" },
    );

  return {
    executionId,
    // Framework plumbing for `pauseUntilSignal` — see DispatchHandle. correlationId
    // is the gateway execution id (echoed back with the webhook's callback_token).
    dispatch: {
      correlationId: executionId,
      resultSignal: LLM_ROUTE_RESULT_SIGNAL,
    },
    async status() {
      return (await fetchDoc()).status;
    },
    async wait({ timeoutMs = 30 * 60_000, pollMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const d = await fetchDoc();
        if (TERMINAL.has(d.status)) return toPayload(executionId, d);
        if (Date.now() > deadline) {
          throw new Error(
            `llm route ${executionId} timed out after ${timeoutMs}ms (last status: ${d.status})`,
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

/**
 * Spend a granted link: `POST {link.anthropicBaseUrl}/v1/messages` with the
 * single-use grant as the credential and the caller's (re-sent) request body.
 * The gateway hard-pins the model the grant was bound to, so `request.model` may
 * be anything — the routed deployment wins. Returns the parsed LLM response.
 *
 * The grant IS the credential (not the tenant key), so this takes a plain fetch
 * rather than the authenticated transport.
 */
export async function redeem<T = Record<string, unknown>>(
  link: LlmGrantLink,
  request: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  const url = `${link.anthropicBaseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "x-api-key": link.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, model: link.model }),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}
