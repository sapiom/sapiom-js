/**
 * `models` capability — LLM execution (coding agents + the instant loop). The fuzzy
 * counterpart to a deterministic step: hand it a task in natural language, it edits
 * a checkout in a sandbox (`models.coding`) or runs an in-server reasoning loop
 * (`models.run`, below).
 *
 *   import { models, repositories } from "@sapiom/tools";
 *   const repo = await repositories.create("landing");
 *   const run = await models.coding.run({
 *     task: "Build a one-page landing site in index.html.",
 *     gitRepository: repo,        // auto-cloned into the sandbox at /workspace/<slug>
 *   });
 *   await repo.pushFromSandbox(run.sandbox, { message: "build: landing" });
 *
 * `run` awaits completion; `launch` returns a handle to poll yourself. Both return
 * a live `Sandbox` handle so a later step can read files, exec, or push from it.
 * The cross-capability inputs (`gitRepository: Repository`, `sandbox: Sandbox`) are
 * passed as instances and resolved here to their wire ids.
 *
 * The wire contract is the gateway's JSON:API-shaped envelope (`data.attributes` /
 * `data.relationships.execution_environment`). Attributes are snake_case on the
 * wire; this module maps them to the camelCase SDK surface below.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import type { DispatchHandle } from "../dispatch.js";
import { Sandbox } from "../sandboxes/index.js";
import type { Repository } from "../repositories/index.js";
import { ensureCodingRunOk, CodingRunHttpError } from "./errors.js";

export { CodingRunHttpError };

const DEFAULT_BASE_URL =
  process.env.SAPIOM_MODELS_URL ??
  process.env.SAPIOM_TOOLS_BASE ??
  "https://tools.sapiom.ai";

/**
 * Capability-stable signal a coding run fires when it reaches a terminal state
 * (completed OR failed — it carries the result either way, the resumed step
 * branches). A workflow step paused on a coding-run handle resumes on this; it is
 * the value carried in the handle's `dispatch.resultSignal`.
 */
export const CODING_RESULT_SIGNAL = "models.coding.result";

/** Run lifecycle, mirrored from the gateway's `ModelsRunStatus`. */
export type RunStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed";
const TERMINAL = new Set<RunStatus>(["completed", "failed"]);

export interface CodingRunSpec {
  /** Natural-language instruction for the coding agent. */
  task: string;
  /** Sapiom repository to clone into the coding sandbox. */
  gitRepository?: Repository;
  /** Reuse an existing sandbox instead of provisioning a fresh one. */
  sandbox?: Sandbox;
  /** Subdirectory (under the runner root) the agent SDK runs in. */
  workingDirectory?: string;
  /** Keep the sandbox alive after the run finishes. SDK default: true (the mesh needs it). */
  keepSandbox?: boolean;
  /**
   * Routing label for the coding agent's LLM calls (e.g. `"smart"`). The
   * platform resolves it against its configured label set — a raw provider
   * model id is never honored. Omit to let the platform choose (the
   * recommended default); pass `"smart"` if you need to pin explicitly.
   */
  model?: ModelLabel;
}

/**
 * A routing label — the vocabulary the platform resolves against its
 * configured label set (never a raw provider model id). `"smart"` is
 * suggested for autocomplete; any other string is still accepted, since the
 * full label set is configured server-side. `Record<never, never>` is the
 * lint-safe spelling of the `string & {}` idiom (see
 * `content-generation/index.ts`'s `LiteralUnion`).
 */
export type ModelLabel = "smart" | (string & Record<never, never>);

export interface CodingRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  thinkingTokens: number;
}

export interface CodingRunOutcome {
  success: boolean;
  turns: number;
  modelUsed: string | null;
  /**
   * The billing class (size) the run's label resolved to, in the SKU
   * vocabulary the platform bills in (e.g. `"medium"`) — never a model or
   * provider id. `undefined`/`null` means the server did not disclose it
   * (coding runs cannot observe this today, and older servers omit the
   * field) — treat as unknown, never fabricate a value.
   */
  servedClass?: string | null;
  /**
   * The billing lane the run executed in (e.g. `"run_now"`).
   * `undefined`/`null` means not disclosed — same caveats as `servedClass`.
   */
  lane?: string | null;
  durationMs: number;
  toolCallCount: number;
  usage: CodingRunUsage;
}

export interface CodingRunError {
  /** `launch` (failed before the agent ran) vs `run` (failed mid-execution). */
  stage: string;
  message: string;
}

export interface CodingRunResult {
  runId: string;
  status: RunStatus;
  summary: string | null;
  result: CodingRunOutcome | null;
  error: CodingRunError | null;
  /** Live handle to the sandbox the run executed in. */
  sandbox: Sandbox;
}

/** Execution-environment `type` for a remote cloud sandbox; its `id` is the sandbox name. */
export const EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX = "blaxel_sandbox";

/**
 * The execution environment a coding run used. For a `"blaxel_sandbox"`, `id` is
 * the sandbox NAME — the value `ctx.sapiom.sandboxes.attach(id)` takes.
 */
export interface ExecutionEnvironmentRef {
  /** Environment kind (today: `"blaxel_sandbox"` | `"local_host"`). */
  type: string;
  /** Type-specific id; for `"blaxel_sandbox"`, the sandbox name. */
  id: string;
}

/**
 * The coding run's terminal result as it arrives at a step **resumed** from
 * `pauseUntilSignal(runHandle, { resumeStep })` — the signal payload delivered as
 * that step's `input`. It crossed a wire boundary, so there are no live handles:
 * to act on the run's sandbox, re-attach one from `executionEnvironment` —
 * `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (when its `type`
 * is `"blaxel_sandbox"`). `executionEnvironment` is `null` when the run never
 * provisioned one (e.g. a launch-stage failure).
 *
 * Annotate a resumed step's input with this so you don't have to hand-roll the
 * shape:
 *
 *   const finalize = defineStep({
 *     name: "finalize", terminal: true,
 *     async run(result: CodingResultPayload, ctx) { … },
 *   });
 */
export interface CodingResultPayload {
  runId: string;
  status: RunStatus;
  summary: string | null;
  result: CodingRunOutcome | null;
  error: CodingRunError | null;
  executionEnvironment: ExecutionEnvironmentRef | null;
}

/**
 * Map a live, awaited {@link CodingRunResult} to the plain {@link CodingResultPayload}
 * a resumed step receives across the wire boundary (live handles become an
 * `executionEnvironment` reference).
 */
export function toResumePayload(run: CodingRunResult): CodingResultPayload {
  return {
    runId: run.runId,
    status: run.status,
    summary: run.summary,
    result: run.result,
    error: run.error,
    executionEnvironment: {
      type: EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
      id: run.sandbox.name,
    },
  };
}

/** Thrown by {@link codingResultSchema}.parse on a malformed resume payload. */
export class CodingResultSchemaError extends Error {}

const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
];

/**
 * Runtime validator for {@link CodingResultPayload}. `parse` returns the value typed
 * on success and throws a {@link CodingResultSchemaError} on any divergence. The
 * `executionEnvironment` key is required (use `null` when no environment was
 * provisioned).
 */
export const codingResultSchema = {
  parse(value: unknown): CodingResultPayload {
    const fail = (msg: string): never => {
      throw new CodingResultSchemaError(
        `invalid coding result payload: ${msg}`,
      );
    };
    if (!value || typeof value !== "object") fail("not an object");
    const v = value as Record<string, unknown>;

    if (typeof v.runId !== "string") fail("runId must be a string");
    if (!RUN_STATUSES.includes(v.status as RunStatus))
      fail(`status must be one of ${RUN_STATUSES.join(", ")}`);
    if (v.summary !== null && typeof v.summary !== "string")
      fail("summary must be a string or null");

    if (v.result !== null) {
      const r = v.result as Record<string, unknown>;
      if (!r || typeof r !== "object") fail("result must be an object or null");
      if (typeof r.success !== "boolean")
        fail("result.success must be a boolean");
      if (typeof r.turns !== "number") fail("result.turns must be a number");
      if (r.modelUsed !== null && typeof r.modelUsed !== "string")
        fail("result.modelUsed must be a string or null");
      if (typeof r.durationMs !== "number")
        fail("result.durationMs must be a number");
      if (typeof r.toolCallCount !== "number")
        fail("result.toolCallCount must be a number");
      if (!r.usage || typeof r.usage !== "object")
        fail("result.usage must be an object");
    }

    if (v.error !== null) {
      const e = v.error as Record<string, unknown>;
      if (!e || typeof e !== "object") fail("error must be an object or null");
      if (typeof e.stage !== "string") fail("error.stage must be a string");
      if (typeof e.message !== "string") fail("error.message must be a string");
    }

    if (!("executionEnvironment" in v))
      fail(
        "executionEnvironment is required (use null when no environment was provisioned)",
      );
    if (v.executionEnvironment !== null) {
      const env = v.executionEnvironment as Record<string, unknown>;
      if (!env || typeof env !== "object")
        fail("executionEnvironment must be an object or null");
      if (typeof env.type !== "string")
        fail("executionEnvironment.type must be a string");
      if (typeof env.id !== "string")
        fail("executionEnvironment.id must be a string");
    }

    return value as CodingResultPayload;
  },
};

/**
 * A launched-but-not-awaited run. Satisfies {@link DispatchHandle}, so it can be
 * handed straight to `pauseUntilSignal(handle, { resumeStep })` to suspend a
 * workflow step until the run finishes — or `wait()`-ed inline for standalone use.
 */
export interface RunHandle extends DispatchHandle {
  runId: string;
  sandbox: Sandbox;
  /** Fetch the current status without blocking. */
  status(): Promise<RunStatus>;
  /** Poll to a terminal state and resolve the full result. */
  wait(opts?: {
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<CodingRunResult>;
}

/**
 * When launched from inside a Sapiom workflow step, the engine injects an opaque
 * per-execution resume token into the sandbox env. Forwarding it as a header — NOT
 * a body field, so author-supplied request fields can't clobber it — lets the
 * gateway call back into the engine to resume the paused workflow when the run
 * finishes. Absent outside a workflow → no header, no behavior change.
 */
function workflowResumeHeaders(
  token: string | undefined,
): Record<string, string> {
  return token ? { "x-sapiom-workflow-token": token } : {};
}

// --- wire shapes (snake_case, as served by the gateway serializer) ---

interface WireResult {
  success: boolean;
  turns: number;
  model_used: string | null;
  served_class?: string | null;
  lane?: string | null;
  duration_ms: number;
  tool_call_count: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_create_tokens?: number;
    thinking_tokens?: number;
  };
}

interface RunDoc {
  data: {
    id: string;
    attributes: {
      status: RunStatus;
      summary?: string | null;
      result?: WireResult | null;
      error?: { stage: string; message: string } | null;
    };
    relationships?: { execution_environment?: { data?: { id: string } } };
  };
}

function mapResult(r: WireResult | null | undefined): CodingRunOutcome | null {
  if (!r) return null;
  return {
    success: r.success,
    turns: r.turns,
    modelUsed: r.model_used ?? null,
    // Disclosure fields: absent on older servers ⇒ null (unknown), never fabricated.
    servedClass: r.served_class ?? null,
    lane: r.lane ?? null,
    durationMs: r.duration_ms,
    toolCallCount: r.tool_call_count,
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_tokens ?? 0,
      cacheCreateTokens: r.usage?.cache_create_tokens ?? 0,
      thinkingTokens: r.usage?.thinking_tokens ?? 0,
    },
  };
}

function buildBody(spec: CodingRunSpec): Record<string, unknown> {
  return {
    task: spec.task,
    git_repository: spec.gitRepository?.slug,
    execution_environment_id: spec.sandbox?.name,
    working_directory: spec.workingDirectory,
    keep_sandbox: spec.keepSandbox ?? true,
    model: spec.model,
  };
}

async function codingRequest<T>(
  url: string,
  init: RequestInit,
  transport: Transport,
): Promise<T> {
  const response = await transport.fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  await ensureCodingRunOk(response, `${init.method ?? "GET"} ${url} failed`);
  return (await response.json()) as T;
}

export async function codingLaunch(
  spec: CodingRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RunHandle> {
  // 202 + a launch document; the execution_environment relationship is always present.
  const doc = await codingRequest<RunDoc>(
    `${baseUrl}/models/v1/coding/runs`,
    {
      method: "POST",
      body: JSON.stringify(buildBody(spec)),
      headers: workflowResumeHeaders(transport.resumeToken),
    },
    transport,
  );
  const runId = doc.data.id;
  const envId = doc.data.relationships?.execution_environment?.data?.id;
  // Reuse the caller's sandbox handle when they supplied one; otherwise adopt the
  // environment the run provisioned (its id is the sandbox name) so later steps
  // can act on it.
  const sandbox = spec.sandbox ?? Sandbox.attach(envId ?? runId, {}, transport);

  const fetchDoc = () =>
    codingRequest<RunDoc>(
      `${baseUrl}/models/v1/coding/runs/${encodeURIComponent(runId)}`,
      {},
      transport,
    );
  const toResult = (d: RunDoc): CodingRunResult => ({
    runId,
    status: d.data.attributes.status,
    summary: d.data.attributes.summary ?? null,
    result: mapResult(d.data.attributes.result),
    error: d.data.attributes.error ?? null,
    sandbox,
  });

  return {
    runId,
    sandbox,
    // Framework plumbing for `pauseUntilSignal` — see DispatchHandle. correlationId
    // is the run id (the join key x402 echoes back when it forwards completion).
    dispatch: { correlationId: runId, resultSignal: CODING_RESULT_SIGNAL },
    async status() {
      return (await fetchDoc()).data.attributes.status;
    },
    async wait({ timeoutMs = 20 * 60_000, pollMs = 3_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const d = await fetchDoc();
        if (TERMINAL.has(d.data.attributes.status)) return toResult(d);
        if (Date.now() > deadline) {
          throw new Error(
            `coding run ${runId} timed out after ${timeoutMs}ms (last status: ${d.data.attributes.status})`,
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

export async function codingRun(
  spec: CodingRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<CodingRunResult> {
  const handle = await codingLaunch(spec, transport, baseUrl);
  return handle.wait();
}

/** Ambient-bound `models.coding` namespace. */
export const coding = { run: codingRun, launch: codingLaunch };

// ============================================================================
// Default model run (instant, in-server loop) — `models.run` / `models.launch`
//
// The fast, no-sandbox sibling of `models.coding`: hand it a prompt (and optional
// remote MCP tools), the loop runs in Sapiom's server and returns text. No
// filesystem, no sandbox handle. Multi-model under the hood; you just call
// `models.run`. Same dispatch contract as coding, so `launch()` works with
// `pauseUntilSignal(handle, { resumeStep })`.
// ============================================================================

/**
 * Capability-stable signal an instant model run fires when it reaches a terminal
 * state (completed OR failed — it carries the result either way). A workflow step
 * paused on a model-run handle resumes on this; it's the handle's
 * `dispatch.resultSignal`.
 */
export const MODEL_RUN_RESULT_SIGNAL = "models.run.result";

/** Run lifecycle, mirrored from the gateway's `ModelRunStatus` (no `queued`). */
export type ModelRunStatus = "pending" | "running" | "completed" | "failed";
const MODEL_TERMINAL = new Set<ModelRunStatus>(["completed", "failed"]);

/** A remote MCP server (Streamable HTTP) the agent may call tools on. */
export interface ModelMcp {
  url: string;
  headers?: Record<string, string>;
}

export interface ModelRunSpec {
  /** The prompt for the agent. */
  prompt: string;
  /** System prompt steering the agent. */
  system?: string;
  /**
   * Routing label for the run's LLM calls (e.g. `"smart"`). The platform
   * resolves it against its configured label set — a raw provider model id
   * is never honored. An unrecognized value is never silently dropped: the
   * run routes via the platform default and the platform reports it in the
   * result's `warnings` (SAP-2765). Omit to let the platform choose (the
   * recommended default); pass `"smart"` if you need to pin explicitly.
   */
  model?: ModelLabel;
  /** Max output tokens per turn. */
  maxTokens?: number;
  /** Remote MCP servers the agent may call tools on (network round-trip per call). */
  mcps?: ModelMcp[];
}

export interface ModelRunOutcome {
  success: boolean;
  stopReason: string;
  turns: number;
  modelUsed: string | null;
  /**
   * The billing class (size) the run's label resolved to (the final turn's,
   * on a multi-turn run), in the SKU vocabulary the platform bills in (e.g.
   * `"medium"`) — never a model or provider id. `undefined`/`null` means the
   * server did not disclose it (older server, resolution failure) — treat as
   * unknown, never fabricate a value.
   */
  servedClass?: string | null;
  /**
   * The billing lane the run executed in (e.g. `"run_now"`).
   * `undefined`/`null` means not disclosed — same caveats as `servedClass`.
   */
  lane?: string | null;
  /**
   * Routing/honesty warnings reported by the platform (SAP-2765) — e.g. a
   * supplied `model` the platform didn't recognize (the run then routed via
   * the platform default). Treat `undefined` as none on any path: the wire
   * omits the key on a clean run and the stub never sets it.
   */
  warnings?: string[];
  durationMs: number;
  /**
   * Rough cost estimate for the run, in USD — an estimate, NOT the amount you
   * are billed. Don't reconcile invoices or gate spend against it.
   *
   * `null` when the platform doesn't report an estimate for a run. Guard before
   * arithmetic (`outcome.costUsd ?? 0`, or skip the row): `null` means "not
   * reported", never "this run was free".
   */
  costUsd: number | null;
  usage: CodingRunUsage;
}

export interface ModelRunError {
  message: string;
}

export interface ModelRunResult {
  runId: string;
  status: ModelRunStatus;
  /** The agent's final text output (null while non-terminal). */
  output: string | null;
  result: ModelRunOutcome | null;
  error: ModelRunError | null;
}

/**
 * A launched-but-not-awaited instant run. Satisfies {@link DispatchHandle}, so it
 * can be handed to `pauseUntilSignal(handle, { resumeStep })` — or `wait()`-ed
 * inline. Unlike coding there is no `sandbox` (the loop runs in-server).
 */
export interface ModelRunHandle extends DispatchHandle {
  runId: string;
  status(): Promise<ModelRunStatus>;
  wait(opts?: { timeoutMs?: number; pollMs?: number }): Promise<ModelRunResult>;
}

/**
 * The instant run's terminal result as it arrives at a step resumed from
 * `pauseUntilSignal(runHandle, { resumeStep })` — the signal payload delivered as
 * that step's `input`. No live handles cross the wire, so it equals
 * {@link ModelRunResult}. Annotate a resumed step's input with this.
 */
export type ModelRunResultPayload = ModelRunResult;

/** Thrown by {@link modelRunResultSchema}.parse on a malformed resume payload. */
export class ModelRunResultSchemaError extends Error {}

/**
 * Guarded `warnings` normalization — enforces the ONE encoding of "no
 * warnings" (`undefined`) on every path that hands a {@link ModelRunOutcome}
 * to a consumer: only string elements survive; an empty/absent/malformed value
 * becomes `undefined`, never a present-but-empty array a consumer's
 * `if (outcome.warnings)` would misread.
 */
function normalizeWarnings(value: unknown): string[] | undefined {
  const warnings = Array.isArray(value) ? value.filter((w): w is string => typeof w === "string") : [];
  return warnings.length ? warnings : undefined;
}

/** Runtime validator for {@link ModelRunResultPayload}. */
export const modelRunResultSchema = {
  parse(value: unknown): ModelRunResultPayload {
    const fail = (msg: string): never => {
      throw new ModelRunResultSchemaError(`invalid agent run result payload: ${msg}`);
    };
    if (!value || typeof value !== "object") fail("not an object");
    const v = value as Record<string, unknown>;
    if (typeof v.runId !== "string") fail("runId must be a string");
    if (!(["pending", "running", "completed", "failed"] as ModelRunStatus[]).includes(v.status as ModelRunStatus))
      fail("status must be a valid ModelRunStatus");
    if (v.output !== null && typeof v.output !== "string") fail("output must be a string or null");
    if (v.result !== null && (typeof v.result !== "object" || !v.result)) fail("result must be an object or null");
    if (v.error !== null && (typeof v.error !== "object" || !v.error)) fail("error must be an object or null");
    if (v.result) {
      // Same warnings encoding as the polled path (mapModelResult): the resume
      // payload is server-serialized, so a wire `[]` would otherwise reach the
      // resumed step present-but-empty.
      const r = v.result as Record<string, unknown>;
      const warnings = normalizeWarnings(r.warnings);
      if (warnings) r.warnings = warnings;
      else delete r.warnings;
      // Same cost encoding as the polled path (mapModelResult). The server
      // feeds both paths from one projection, so this is belt-and-braces
      // rather than a divergence today — but a `number | null` field must
      // never hand a resumed step `undefined`, which is what a missing key
      // would otherwise do.
      r.costUsd = typeof r.costUsd === "number" ? r.costUsd : null;
    }
    return value as ModelRunResultPayload;
  },
};

// --- wire shapes (snake_case, as served by the gateway serializer) ---

interface ModelWireResult {
  success: boolean;
  stop_reason: string;
  turns: number;
  model_used: string | null;
  served_class?: string | null;
  lane?: string | null;
  /** Present only when the run has warnings (e.g. an unhonored `model` pin); guarded at map time. */
  warnings?: string[];
  duration_ms: number;
  /** Nullable on the wire: the platform doesn't report an estimate for every run. */
  cost_usd?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_create_tokens?: number;
    thinking_tokens?: number;
  };
}

interface ModelRunDoc {
  data: {
    id: string;
    attributes: {
      status: ModelRunStatus;
      output?: string | null;
      result?: ModelWireResult | null;
      error?: { message: string } | null;
    };
  };
}

function mapModelResult(r: ModelWireResult | null | undefined): ModelRunOutcome | null {
  if (!r) return null;
  return {
    success: r.success,
    stopReason: r.stop_reason,
    turns: r.turns,
    modelUsed: r.model_used ?? null,
    // Disclosure fields: absent on older servers ⇒ null (unknown), never fabricated.
    servedClass: r.served_class ?? null,
    lane: r.lane ?? null,
    durationMs: r.duration_ms,
    // ONE encoding of "no cost estimate": a wire `null`, a missing key, and a
    // malformed value all land on `null` — never a fabricated `0`, which a
    // consumer would read as "this run was free".
    costUsd: typeof r.cost_usd === "number" ? r.cost_usd : null,
    // Passthrough via the shared guard (`normalizeWarnings`): the key is
    // absent unless at least one string warning survives — a wire `[]`, a
    // non-array, or an all-junk array maps to absent, matching the documented
    // "treat undefined as none".
    ...(() => {
      const warnings = normalizeWarnings(r.warnings);
      return warnings ? { warnings } : {};
    })(),
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_tokens ?? 0,
      cacheCreateTokens: r.usage?.cache_create_tokens ?? 0,
      thinkingTokens: r.usage?.thinking_tokens ?? 0,
    },
  };
}

function buildModelBody(spec: ModelRunSpec): Record<string, unknown> {
  return {
    prompt: spec.prompt,
    system: spec.system,
    model: spec.model,
    max_tokens: spec.maxTokens,
    mcps: spec.mcps,
  };
}

export async function launch(
  spec: ModelRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ModelRunHandle> {
  const doc = await transport.request<ModelRunDoc>(`${baseUrl}/models/v1/runs`, {
    method: "POST",
    body: JSON.stringify(buildModelBody(spec)),
    headers: workflowResumeHeaders(transport.resumeToken),
  });
  const runId = doc.data.id;

  const fetchDoc = () =>
    transport.request<ModelRunDoc>(`${baseUrl}/models/v1/runs/${encodeURIComponent(runId)}`);
  const toResult = (d: ModelRunDoc): ModelRunResult => ({
    runId,
    status: d.data.attributes.status,
    output: d.data.attributes.output ?? null,
    result: mapModelResult(d.data.attributes.result),
    error: d.data.attributes.error ?? null,
  });

  return {
    runId,
    // Framework plumbing for `pauseUntilSignal` — correlationId is the run id (the
    // join key x402 echoes back when it forwards completion).
    dispatch: { correlationId: runId, resultSignal: MODEL_RUN_RESULT_SIGNAL },
    async status() {
      return (await fetchDoc()).data.attributes.status;
    },
    async wait({ timeoutMs = 10 * 60_000, pollMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const d = await fetchDoc();
        if (MODEL_TERMINAL.has(d.data.attributes.status)) return toResult(d);
        if (Date.now() > deadline) {
          throw new Error(
            `agent run ${runId} timed out after ${timeoutMs}ms (last status: ${d.data.attributes.status})`,
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

export async function run(
  spec: ModelRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ModelRunResult> {
  const handle = await launch(spec, transport, baseUrl);
  return handle.wait();
}
