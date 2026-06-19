import { inspect, inspectBuild, listExecutions, OrchestrationError } from '@sapiom/orchestration-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { readConfig, requireConfig } from '../../lib/config.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations logs [executionId]` — inspect an execution (its steps
 * and errors), a build (`--build`), or recent executions (no argument).
 */
export async function runLogs(
  executionId: string | undefined,
  opts: { build?: string; host?: string; target?: CliTarget },
): Promise<void> {
  try {
    const dir = process.cwd();

    if (opts.build) {
      const cfg = requireConfig(dir);
      const client = makeClient({ projectHost: cfg.host, flagHost: opts.host, flagTarget: opts.target });
      const { build } = await inspectBuild({ definitionId: cfg.definitionId, buildRunId: opts.build }, client);
      if (isJsonMode()) ok({ build });
      else ok({}, [`build ${opts.build}: ${build.status ?? 'unknown'}`]);
      return;
    }

    const cfg = readConfig(dir);
    const client = makeClient({ projectHost: cfg?.host, flagHost: opts.host, flagTarget: opts.target });

    if (!executionId) {
      const { executions } = await listExecutions(client);
      if (isJsonMode()) ok({ executions });
      else ok({}, executions.map((e) => `${e.id}  ${e.status}`));
      return;
    }

    const { execution: ex } = await inspect({ executionId }, client);
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
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }
}
