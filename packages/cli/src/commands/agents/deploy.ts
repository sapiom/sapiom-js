import { deploy, AgentOperationError } from '@sapiom/orchestration-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom agents deploy` — mint push credentials, push the current
 * commit, trigger a build, and wait for it to finish.
 *
 * Note: the backend tenant deploy routes (POST definitions, push-credentials,
 * builds) are being added in a parallel effort and are not yet merged. Until
 * those land, deploy end-to-end will return 404 from the backend.
 */
export async function runDeploy(opts: { branch?: string; host?: string; target?: CliTarget }): Promise<void> {
  try {
    const dir = process.cwd();
    const cfg = requireConfig(dir);
    const client = makeClient({ projectHost: cfg.host, flagHost: opts.host, flagTarget: opts.target });

    const result = await deploy({ projectDir: dir, definitionId: cfg.definitionId, branch: opts.branch }, client);

    if (isJsonMode()) {
      ok({ definitionId: result.definitionId, buildRunId: result.buildRunId, status: result.status });
    } else {
      ok({}, [`✓ Deployed ${cfg.name} (build ${result.status})`]);
    }
  } catch (err) {
    if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
    throw err;
  }
}
