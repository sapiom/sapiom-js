/**
 * run — create an execution of a server-side agent definition.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly;
 * no file-system reads — the caller supplies the definition id and input.
 *
 * The backend route is `POST /v1/workflows/executions` and takes the definition
 * id in the body alongside the execution input (not as a path segment).
 */
import { getOrchestrationAnalytics, telemetryErrorCode } from './analytics.js';
import { GatewayClient } from './client.js';
import { AgentOperationError } from './errors.js';

export interface RunOptions {
  /** Server-side definition ID. */
  definitionId: string;
  /**
   * Execution input. Accepts any JSON-serializable value; defaults to an empty
   * object so optional-input agents work without extra boilerplate.
   */
  input?: unknown;
}

export interface RunResult {
  executionId: string;
  /** Full response body from the gateway, for callers that want extra fields. */
  raw: Record<string, unknown>;
}

/**
 * Start an execution of the named agent definition.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 *
 * Emits one `workflow.run` usage-analytics event (metadata only: ids,
 * status, duration — never the execution input). Ships dark — see
 * ./analytics.ts; telemetry never changes the operation's behavior.
 */
export async function run(opts: RunOptions, client: GatewayClient): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const result = await runOperation(opts, client);
    getOrchestrationAnalytics().track('workflow.run', {
      workflow_id: opts.definitionId,
      execution_id: result.executionId,
      status: 'success',
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    getOrchestrationAnalytics().track('workflow.run', {
      workflow_id: opts.definitionId,
      status: 'error',
      error_code: telemetryErrorCode(err),
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  }
}

/** The operation body — unchanged from before the analytics wrapper. */
async function runOperation(opts: RunOptions, client: GatewayClient): Promise<RunResult> {
  const { definitionId, input = {} } = opts;

  // Backend route: POST /v1/workflows/executions — definition id is in the body,
  // not the path. The tenant scope is resolved server-side from the caller's
  // authenticated API key; it cannot be overridden by the client.
  const res = await client.post<{ executionId?: string; id?: string } & Record<string, unknown>>(
    '/executions',
    { definitionId, input },
  );
  const executionId = res.executionId ?? res.id;
  if (!executionId) {
    throw new AgentOperationError({
      code: 'RUN_NO_ID',
      message: 'The execution was started but no execution id was returned.',
    });
  }

  return { executionId, raw: res };
}

// ── Input parsing helper ──────────────────────────────────────────────────────

/**
 * Parse a JSON string into an execution input value. Exported so CLI / MCP
 * callers can reuse the same error-normalizing path without duplicating the
 * try/catch.
 */
export function parseJsonInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentOperationError({
      code: 'BAD_INPUT',
      message: 'Input is not valid JSON.',
      hint: 'Pass a valid JSON string, e.g. \'{"key":"value"}\'',
    });
  }
}
