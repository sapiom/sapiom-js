import { deploy, OrchestrationError } from '@sapiom/orchestration-core';

import { makeClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations deploy` — mint push credentials, push the current
 * commit, trigger a build, and wait for it to finish.
 */
export async function runDeploy(opts: { branch?: string }): Promise<void> {
  try {
    const dir = process.cwd();
    const cfg = requireConfig(dir);
    const client = makeClient(cfg.host);

    const result = await deploy({ projectDir: dir, definitionId: cfg.definitionId, branch: opts.branch }, client);

    if (isJsonMode()) {
      ok({ definitionId: result.definitionId, buildRunId: result.buildRunId, status: result.status });
    } else {
      ok({}, [`✓ Deployed ${cfg.name} (build ${result.status})`]);
    }
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }
}
