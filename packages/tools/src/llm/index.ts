/**
 * `llm` capability — routed LLM calls through the gateway's `/v2` routing
 * front-end (SAP-792), on the x402 unified edge (`llm.services.sapiom.ai`).
 *
 * Two verbs, mirroring the gateway's two entry points:
 *
 * `run` — SYNCHRONOUS (`POST /v2/anthropic/v1/messages`): one LLM call, routed through the
 * model selector (a label via `model`, else the gateway's default label) and the
 * capacity-aware load balancer, executed immediately and returned inline. Direct
 * calls are run-now class and never queue. The edge settles billing against the
 * caller's Sapiom API key (identity mode — no x402 payment handshake needed).
 *
 *   const reply = await ctx.sapiom.llm.run({
 *     request: { messages: [{ role: "user", content: "…" }], max_tokens: 512 },
 *     model: "m2.7", // a label (m2.7 | minimax-m3 | sonnet | …); omit → default label
 *   });
 *
 * `submit` — DEFERRED (`POST /v2/route/async`): unlike `agents.run` (a full
 * in-server loop), this routes ONE LLM call through the gateway's capacity-aware
 * admission: `submit` asks for the call and returns a handle immediately; the
 * gateway holds the job ordered by deadline and — when a model has room, or the
 * deadline is close enough to escalate toward run-now — mints a single-use link
 * and reports back. The request body itself is NEVER stored by the gateway: the
 * caller re-sends it at redemption (`redeem`). Submit is the unpaid control
 * plane; payment happens at redemption.
 *
 *   const handle = await ctx.sapiom.llm.submit({
 *     request: { messages: [{ role: "user", content: "…" }], max_tokens: 512 },
 *     model: "m2.7", // a label; omit → default label
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
 *
 * `createSession` / `getSession` / `callSession` / `releaseSession` — SESSIONS
 * (`/v2/sessions`, Surface B): the REST resource replacing the async+grant lane.
 * Create reserves future capacity for a label; once READY the session accepts
 * REPEATED drop-in calls (both wire shapes) with the normal Sapiom credential
 * until its TTL/token budget ends it — no single-use token. `submit`/`redeem`
 * keep working until the migration completes.
 *
 *   const s = await ctx.sapiom.llm.createSession({
 *     label: "sonnet", deadlineMinutes: 60,
 *     budget: { maxTokens: 2_000_000, ttlMinutes: 120 },
 *   });
 *   const ready = await s.wait();                       // or pauseUntilSignal(s, …)
 *   const reply = await ctx.sapiom.llm.callSession(s, { max_tokens: 512, messages: […] });
 *   await ctx.sapiom.llm.releaseSession(s);             // or let TTL/budget end it
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

export interface LlmRunSpec {
  /**
   * The verbatim LLM request (Anthropic messages shape) — forwarded as-is and
   * executed immediately on the routed deployment. Any `model` inside the body
   * is superseded by the routing decision (set the route label via `model` below).
   */
  request: Record<string, unknown>;
  /** Route label (e.g. `"m2.7"`, `"minimax-m3"`, `"sonnet"`). Omit → the gateway's default label. */
  model?: string;
  /**
   * Guarantee an answer by spilling to the label's declared fallback when the
   * preferred capacity is saturated (never-429). DEFAULTS TO TRUE here: the
   * gateway's own direct default is OFF (drop-in callers get plain 429 +
   * backoff), but a workflow step usually can't retry-with-backoff cheaply, so
   * the SDK opts workflows in. Set `false` to take 429s and handle them.
   * Note: spilling can serve a costlier deployment (usually Anthropic).
   */
  neverFail?: boolean;
  /** Explicit complexity/capacity weight override (gateway clamps to its bounds). */
  complexity?: number;
}

export interface LlmSubmitSpec {
  /**
   * The verbatim LLM request (Anthropic messages shape). Used only to estimate
   * routing weight at submit — the gateway does NOT store it; keep it (e.g. in
   * `ctx.shared`) and re-send it to `redeem` when the grant arrives.
   */
  request: Record<string, unknown>;
  /** Route label (e.g. `"m2.7"`, `"minimax-m3"`, `"sonnet"`). Omit → the gateway's default label. */
  model?: string;
  /**
   * How long the caller will wait, in minutes. Omitted or <= 0 → run-now (top
   * priority, immediate escalation). The gateway orders jobs earliest-deadline-
   * first and escalates toward run-now as the deadline nears.
   */
  deadlineMinutes?: number;
  /**
   * Never-429 override for the deferred route. Omit → the gateway's async
   * default (ON — deferred work guarantees an answer). Set `false` to let a
   * saturated cascade fail instead of spilling to the fallback.
   */
  neverFail?: boolean;
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
  /** USER-FACING model label (e.g. `"m2.7"`, `"minimax-m3"`) — the provider is never disclosed. */
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
    if (typeof v.executionId !== "string") fail("executionId must be a string");
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
  if (spec.neverFail !== undefined)
    h["x-sapiom-never-fail"] = String(spec.neverFail);
  if (spec.deadlineMinutes !== undefined)
    h["x-sapiom-deadline"] = String(spec.deadlineMinutes);
  if (spec.complexity !== undefined)
    h["x-sapiom-complexity"] = String(spec.complexity);
  return h;
}

/**
 * Synchronous routed call: `POST /v2/anthropic/v1/messages` on the x402 edge (Surface A —
 * the PATH is the wire shape; this client speaks Anthropic Messages). The gateway
 * selects the deployment (the label via `spec.model`, else the default label), admits it
 * against the shared capacity ledger (run-now class — never queued), executes,
 * and returns the completion inline. Billing settles against the caller's
 * Sapiom API key at the edge (identity mode; the default `x-sapiom-api-key`
 * header is exactly what the edge's identity guard reads).
 */
export async function run<T = Record<string, unknown>>(
  spec: LlmRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (spec.model) headers["x-sapiom-model"] = spec.model;
  // Workflow surface defaults to never-fail ON (see LlmRunSpec.neverFail) —
  // sent explicitly either way so the behavior never rides a gateway default.
  headers["x-sapiom-never-fail"] = String(spec.neverFail ?? true);
  if (spec.complexity !== undefined)
    headers["x-sapiom-complexity"] = String(spec.complexity);
  return transport.request<T>(`${baseUrl}/v2/anthropic/v1/messages`, {
    method: "POST",
    body: JSON.stringify(spec.request),
    headers,
  });
}

export async function submit(
  spec: LlmSubmitSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<LlmRouteHandle> {
  // 202 + {execution_id, status: "queued", poll}. The `/v2` control plane sits on
  // the x402 edge, whose identity guard reads the default `x-sapiom-api-key`
  // header (SAP-1496: a Sapiom API key is required on every /v2 route).
  const doc = await transport.request<SubmitDoc>(`${baseUrl}/v2/route/async`, {
    method: "POST",
    body: JSON.stringify(spec.request),
    headers: submitHeaders(spec, transport.resumeToken),
  });
  const executionId = doc.execution_id;

  const fetchDoc = () =>
    transport.request<StatusDoc>(
      `${baseUrl}/v2/route/async/${encodeURIComponent(executionId)}`,
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
 * Spend a granted link: `POST {link.anthropicBaseUrl}/v2/anthropic/v1/messages` with the
 * single-use grant in the `x-sapiom-grant-token` header, the caller's Sapiom API
 * key as identity, and the (re-sent) request body. This is the PAID call — the
 * edge settles it against the caller's account ("payment at redemption",
 * SAP-1496), and the gateway routes it to the exact deployment the grant
 * reserved (single-use, consumed atomically; the response `model` carries the
 * user-facing label). `request.model` may be anything — the reserved deployment
 * wins. Returns the parsed LLM response.
 */
export async function redeem<T = Record<string, unknown>>(
  link: LlmGrantLink,
  request: Record<string, unknown>,
  transport: Transport = defaultTransport(),
): Promise<T> {
  const url = `${link.anthropicBaseUrl.replace(/\/$/, "")}/v2/anthropic/v1/messages`;
  return transport.request<T>(url, {
    method: "POST",
    headers: { "x-sapiom-grant-token": link.apiKey },
    body: JSON.stringify(request),
  });
}

// ---------------------------------------------------------------------------
// Sessions (Surface B) — `/v2/sessions`, the REST resource replacing the
// async+grant lane: create a session (deferred capacity), poll or resume until
// READY, then call it REPEATEDLY with the normal Sapiom credential until its
// TTL/token budget ends it. No single-use token, no body re-send ceremony.
// `submit`/`redeem` above keep working until the migration completes.
// ---------------------------------------------------------------------------

/**
 * Capability-stable signal a session fires when it leaves `pending` (ready OR
 * failed — the payload carries the session either way; the resumed step
 * branches on `state`). Delivered by the gateway's ready-webhook through the
 * engine's resume forwarder, correlated by the session id.
 */
export const LLM_SESSION_READY_SIGNAL = "llm.session.ready";

/** Session lifecycle, mirrored from `GET /v2/sessions/{id}`. */
export type LlmSessionState =
  | "pending"
  | "ready"
  | "active"
  | "expired"
  | "exhausted"
  | "failed"
  | "not_found";
const SESSION_SETTLED = new Set<LlmSessionState>([
  "ready",
  "active",
  "expired",
  "exhausted",
  "failed",
]);

export interface LlmSessionCreateSpec {
  /** Route label (e.g. `"sonnet"`, `"haiku"`). Mutually exclusive with `model`; omit both → the gateway's default label. */
  label?: string;
  /** Pin an exact Sapiom-supported alias. Mutually exclusive with `label`. */
  model?: string;
  /** How long you'll wait for capacity, in minutes. Omitted or <= 0 → run-now. */
  deadlineMinutes?: number;
  /**
   * The session's envelope. `ttlMinutes` starts counting at READY (default:
   * gateway-configured, 60); `maxTokens` caps total usage (input + output)
   * across ALL calls — omit for time-boxed only.
   */
  budget?: { maxTokens?: number; ttlMinutes?: number };
  /**
   * Never-429 override for the capacity request. Omit → the gateway's async
   * default (ON — a queued session is guaranteed to become ready, possibly on
   * the label's costlier fallback).
   */
  neverFail?: boolean;
  /**
   * Where the gateway reports readiness. Inside a workflow leave it unset —
   * the engine's `SAPIOM_LLM_WEBHOOK_URL` (resume forwarder) is used when
   * present. Unlike `submit`, a webhook is OPTIONAL: standalone callers may
   * rely purely on `handle.wait()` polling.
   */
  webhookUrl?: string;
  /** HMAC secret: the gateway signs the webhook body as `X-Sapiom-Signature`. */
  webhookSecret?: string;
}

/** A session as the gateway reports it (camelCase view of the wire doc). */
export interface LlmSession {
  sessionId: string;
  state: LlmSessionState;
  /** USER-FACING label (e.g. `"sonnet"`) — the serving provider is never disclosed. */
  model?: string;
  /** Present from READY on: the drop-in base URLs scoped under the session. */
  baseUrls?: { anthropic: string; openai: string };
  expiresAtMs?: number;
  budget?: { maxTokens: number | null; usedTokens?: number; ttlMinutes?: number | null };
  /** Set when `state === "failed"` (e.g. `deadline_exhausted`, `released_by_client`). */
  error?: string;
}

/**
 * A created-but-possibly-not-ready session. Satisfies {@link DispatchHandle}
 * (hand it to `pauseUntilSignal(handle, { resumeStep })`), or `wait()` inline.
 */
export interface LlmSessionHandle extends DispatchHandle {
  sessionId: string;
  /** Fetch the current session doc without blocking. */
  get(): Promise<LlmSession>;
  /** Poll until the session leaves `pending`; resolves the session (check `state`). */
  wait(opts?: { timeoutMs?: number; pollMs?: number }): Promise<LlmSession>;
}

// --- wire shapes (snake_case, as served by the gateway) ---

interface SessionDoc {
  session_id: string;
  state: LlmSessionState;
  model?: string;
  base_urls?: { anthropic: string; openai: string };
  expires_at_ms?: number;
  budget?: {
    max_tokens?: number | null;
    used_tokens?: number;
    ttl_minutes?: number | null;
  };
  error?: string | null;
}

function mapSession(d: SessionDoc): LlmSession {
  const out: LlmSession = { sessionId: d.session_id, state: d.state };
  if (d.model) out.model = d.model;
  if (d.base_urls) out.baseUrls = d.base_urls;
  if (d.expires_at_ms !== undefined) out.expiresAtMs = d.expires_at_ms;
  if (d.budget)
    out.budget = {
      maxTokens: d.budget.max_tokens ?? null,
      usedTokens: d.budget.used_tokens,
      ttlMinutes: d.budget.ttl_minutes ?? null,
    };
  if (d.error) out.error = d.error;
  return out;
}

/**
 * Create a session: `POST /v2/sessions` — a plain JSON resource create (NOT an
 * LLM payload; nothing about your prompts is sent or stored). Returns a handle
 * immediately (`202 pending`); the gateway reserves capacity within
 * `deadlineMinutes` and reports READY via webhook and/or the pollable GET.
 */
export async function createSession(
  spec: LlmSessionCreateSpec = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<LlmSessionHandle> {
  if (spec.label !== undefined && spec.model !== undefined) {
    throw new Error("llm.createSession: `label` and `model` are mutually exclusive");
  }
  const body: Record<string, unknown> = {};
  if (spec.label) body.label = spec.label;
  if (spec.model) body.model = spec.model;
  if (spec.deadlineMinutes !== undefined)
    body.deadline_minutes = spec.deadlineMinutes;
  if (spec.budget) {
    const budget: Record<string, unknown> = {};
    if (spec.budget.maxTokens !== undefined) budget.max_tokens = spec.budget.maxTokens;
    if (spec.budget.ttlMinutes !== undefined) budget.ttl_minutes = spec.budget.ttlMinutes;
    body.budget = budget;
  }
  if (spec.neverFail !== undefined) body.never_fail = spec.neverFail;
  // Webhook is optional (poll-only is a legitimate mode). Inside a workflow the
  // engine's forwarder URL + the ambient resume token wire up pause/resume.
  const webhookUrl = spec.webhookUrl ?? process.env.SAPIOM_LLM_WEBHOOK_URL;
  if (webhookUrl) {
    const webhook: Record<string, unknown> = { url: webhookUrl };
    if (spec.webhookSecret) webhook.secret = spec.webhookSecret;
    if (transport.resumeToken) webhook.token = transport.resumeToken;
    body.webhook = webhook;
  }

  const doc = await transport.request<SessionDoc>(`${baseUrl}/v2/sessions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const sessionId = doc.session_id;

  const fetchDoc = () =>
    transport.request<SessionDoc>(
      `${baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}`,
    );

  return {
    sessionId,
    dispatch: {
      correlationId: sessionId,
      resultSignal: LLM_SESSION_READY_SIGNAL,
    },
    async get() {
      return mapSession(await fetchDoc());
    },
    async wait({ timeoutMs = 30 * 60_000, pollMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const d = await fetchDoc();
        if (SESSION_SETTLED.has(d.state)) return mapSession(d);
        if (Date.now() > deadline) {
          throw new Error(
            `llm session ${sessionId} timed out after ${timeoutMs}ms (last state: ${d.state})`,
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

/** Fetch a session by id (tenant-scoped: other accounts' ids read as `not_found`). */
export async function getSession(
  sessionId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<LlmSession> {
  return mapSession(
    await transport.request<SessionDoc>(
      `${baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
}

/**
 * Call a ready session — `POST /v2/sessions/{id}/anthropic/v1/messages` (the
 * default Anthropic shape; pass `shape: "openai"` for Chat Completions).
 * REPEATABLE: keep calling until the server ends the session — TTL/budget
 * terminals return 410 (`session_expired` / `session_exhausted`); each call is
 * billed individually against the caller's Sapiom key, exactly like `run`.
 * `request.model` may be anything — the session's reserved deployment wins,
 * and the response `model` carries the user-facing label.
 */
export async function callSession<T = Record<string, unknown>>(
  session: LlmSessionHandle | LlmSession | string,
  request: Record<string, unknown>,
  opts: { shape?: "anthropic" | "openai" } = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<T> {
  const sessionId = typeof session === "string" ? session : session.sessionId;
  const suffix =
    opts.shape === "openai"
      ? "openai/v1/chat/completions"
      : "anthropic/v1/messages";
  return transport.request<T>(
    `${baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/${suffix}`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

/**
 * Release a session early: `DELETE /v2/sessions/{id}` — frees the reserved
 * capacity; idempotent (a session already at a terminal returns its state).
 */
export async function releaseSession(
  session: LlmSessionHandle | LlmSession | string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<LlmSession> {
  const sessionId = typeof session === "string" ? session : session.sessionId;
  return mapSession(
    await transport.request<SessionDoc>(
      `${baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  );
}
