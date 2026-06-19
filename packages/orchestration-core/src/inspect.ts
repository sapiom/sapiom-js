/**
 * inspect / logs — fetch execution details, step records, or build status.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 * The function named `inspect` (vs `logs`) makes the intent clear for
 * programmatic consumers; the CLI alias these as "logs" on its command surface.
 */
import { GatewayClient } from './client.js';

export interface StepRecord {
  stepName: string;
  attempt: number;
  status: string;
  error?: { message?: string; stack?: string } | null;
}

export interface ExecutionDetail {
  id: string;
  status: string;
  currentStep?: string | null;
  error?: unknown;
  steps?: StepRecord[];
}

export interface BuildDetail {
  id?: string;
  status: string;
  error?: unknown;
}

// ── Inspect an execution ──────────────────────────────────────────────────────

export interface InspectOptions {
  executionId: string;
}

export interface InspectResult {
  execution: ExecutionDetail;
}

/**
 * Fetch full detail for a single execution, including its step records.
 *
 * Throws `OrchestrationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function inspect(opts: InspectOptions, client: GatewayClient): Promise<InspectResult> {
  const execution = await client.get<ExecutionDetail>(`/executions/${opts.executionId}`);
  return { execution };
}

// ── List recent executions ────────────────────────────────────────────────────

export interface ListExecutionsResult {
  executions: ExecutionDetail[];
}

/**
 * List recent executions (no filter — the gateway decides the page size and
 * ordering). Callers can pass a definitionId in opts if the gateway supports it.
 */
export async function listExecutions(client: GatewayClient): Promise<ListExecutionsResult> {
  const executions = await client.get<ExecutionDetail[]>('/executions');
  return { executions };
}

// ── Inspect a build ───────────────────────────────────────────────────────────

export interface InspectBuildOptions {
  definitionId: string;
  buildRunId: string;
}

export interface InspectBuildResult {
  build: BuildDetail;
}

/**
 * Fetch build status for a specific build run.
 *
 * Throws `OrchestrationError` (code `HTTP_*` | `NETWORK`) on gateway errors.
 */
export async function inspectBuild(opts: InspectBuildOptions, client: GatewayClient): Promise<InspectBuildResult> {
  const build = await client.get<BuildDetail>(
    `/definitions/${opts.definitionId}/builds/${opts.buildRunId}`,
  );
  return { build };
}
