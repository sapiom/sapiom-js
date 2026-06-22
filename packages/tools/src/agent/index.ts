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
  process.env.SAPIOM_AGENTS_URL || "https://agents.services.sapiom.ai";

/**
 * Capability-stable signal a coding run fires when it reaches a terminal state
 * (completed OR failed — it carries the result either way, the resumed step
 * branches). A workflow step paused on a coding-run handle resumes on this; it is
 * the value carried in the handle's `dispatch.resultSignal`.
 */
export const CODING_RESULT_SIGNAL = "agent.coding.result";

/** Run lifecycle, mirrored from the gateway's `AgentsRunStatus`. */
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
function workflowResumeHeaders(): Record<string, string> {
  const token = process.env.SAPIOM_CAPABILITY_RESUME_TOKEN;
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

export async function launch(
  spec: CodingRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RunHandle> {
  // 202 + a launch document; the execution_environment relationship is always present.
  const doc = await transport.request<RunDoc>(`${baseUrl}/v1/coding/runs`, {
    method: "POST",
    body: JSON.stringify(buildBody(spec)),
    headers: workflowResumeHeaders(),
  });
  const runId = doc.data.id;
  const envId = doc.data.relationships?.execution_environment?.data?.id;
  // Reuse the caller's sandbox handle when they supplied one; otherwise adopt the
  // environment the run provisioned (its id is the sandbox name) so later steps
  // can act on it.
  const sandbox = spec.sandbox ?? Sandbox.attach(envId ?? runId, {}, transport);

  const fetchDoc = () =>
    transport.request<RunDoc>(
      `${baseUrl}/v1/coding/runs/${encodeURIComponent(runId)}`,
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

export async function run(
  spec: CodingRunSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<CodingRunResult> {
  const handle = await launch(spec, transport, baseUrl);
  return handle.wait();
}

/** Ambient-bound `agent.coding` namespace. */
export const coding = { run, launch };
