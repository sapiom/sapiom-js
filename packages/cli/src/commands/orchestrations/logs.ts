import { GatewayClient } from '../../lib/client.js';
import { readConfig, requireConfig } from '../../lib/config.js';
import { isJsonMode, ok } from '../../lib/output.js';

interface StepRecord {
  stepName: string;
  attempt: number;
  status: string;
  error?: { message?: string; stack?: string } | null;
}

interface ExecutionDetail {
  id: string;
  status: string;
  currentStep?: string | null;
  error?: unknown;
  steps?: StepRecord[];
}

/**
 * `sapiom orchestrations logs [executionId]` — inspect an execution (its steps
 * and errors), a build (`--build`), or recent executions (no argument).
 */
export async function runLogs(
  executionId: string | undefined,
  opts: { build?: string },
): Promise<void> {
  const dir = process.cwd();

  if (opts.build) {
    const cfg = requireConfig(dir);
    const client = new GatewayClient(cfg.host);
    const build = await client.get(`/definitions/${cfg.definitionId}/builds/${opts.build}`);
    if (isJsonMode()) ok({ build });
    else ok({}, [`build ${opts.build}: ${(build as { status?: string }).status ?? 'unknown'}`]);
    return;
  }

  const cfg = readConfig(dir);
  const client = new GatewayClient(cfg?.host);

  if (!executionId) {
    const list = await client.get<ExecutionDetail[]>('/executions');
    if (isJsonMode()) ok({ executions: list });
    else ok({}, list.map((e) => `${e.id}  ${e.status}`));
    return;
  }

  const ex = await client.get<ExecutionDetail>(`/executions/${executionId}`);
  if (isJsonMode()) {
    ok({ execution: ex });
    return;
  }
  const lines = [`execution ${ex.id}: ${ex.status}${ex.currentStep ? ` (at ${ex.currentStep})` : ''}`];
  for (const step of ex.steps ?? []) {
    lines.push(`  ${step.status === 'failed' ? '✗' : '·'} ${step.stepName} #${step.attempt} — ${step.status}`);
    if (step.error?.message) lines.push(`      ${step.error.message}`);
  }
  ok({}, lines);
}
