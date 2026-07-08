/**
 * `agent` capability — LLM execution (coding agents). The fuzzy counterpart to a
 * deterministic step: hand it a task in natural language, it edits a checkout in a
 * sandbox.
 *
 *   import { agent, repositories } from "@sapiom/tools";
 *   const repo = await repositories.create("landing");
 *   const run = await agent.coding.run({
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
export const CODING_RESULT_SIGNAL = "agent.coding.result";

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
  /** Repo to clone into the sandbox at `/workspace/<slug>` and operate on. */
  gitRepository?: Repository;
  /** Reuse an existing sandbox instead of provisioning a fresh one. */
  sandbox?: Sandbox;
  /** Subdirectory (under the runner root) the agent SDK runs in. */
  workingDirectory?: string;
  /** Keep the sandbox alive after the run finishes. SDK default: true (the mesh needs it). */
  keepSandbox?: boolean;
  /** Override the model the agent runs on. */
  model?: string;
}

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

export async function codingLaunch(
  spec: CodingRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RunHandle> {
  // 202 + a launch document; the execution_environment relationship is always present.
  const doc = await transport.request<RunDoc>(`${baseUrl}/models/v1/coding/runs`, {
    method: "POST",
    body: JSON.stringify(buildBody(spec)),
    headers: workflowResumeHeaders(transport.resumeToken),
  });
  const runId = doc.data.id;
  const envId = doc.data.relationships?.execution_environment?.data?.id;
  // Reuse the caller's sandbox handle when they supplied one; otherwise adopt the
  // environment the run provisioned (its id is the sandbox name) so later steps
  // can act on it.
  const sandbox = spec.sandbox ?? Sandbox.attach(envId ?? runId, {}, transport);

  const fetchDoc = () =>
    transport.request<RunDoc>(
      `${baseUrl}/models/v1/coding/runs/${encodeURIComponent(runId)}`,
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

/** Ambient-bound `agent.coding` namespace. */
export const coding = { run: codingRun, launch: codingLaunch };

// ============================================================================
// Default agent (instant, in-server loop) — `agent.run` / `agent.launch`
//
// The fast, no-sandbox sibling of `agent.coding`: hand it a prompt (and optional
// remote MCP tools), the loop runs in Sapiom's server and returns text. No
// filesystem, no sandbox handle. Multi-model under the hood; you just call
// `agent.run`. Same dispatch contract as coding, so `launch()` works with
// `pauseUntilSignal(handle, { resumeStep })`.
// ============================================================================

/**
 * Capability-stable signal an instant agent run fires when it reaches a terminal
 * state (completed OR failed — it carries the result either way). A workflow step
 * paused on an agent-run handle resumes on this; it's the handle's
 * `dispatch.resultSignal`.
 */
export const MODEL_RUN_RESULT_SIGNAL = "agent.run.result";

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
  /** Override the model / routing alias. */
  model?: string;
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
  durationMs: number;
  costUsd: number;
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
    return value as ModelRunResultPayload;
  },
};

// --- wire shapes (snake_case, as served by the gateway serializer) ---

interface ModelWireResult {
  success: boolean;
  stop_reason: string;
  turns: number;
  model_used: string | null;
  duration_ms: number;
  cost_usd: number;
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
    durationMs: r.duration_ms,
    costUsd: r.cost_usd,
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
