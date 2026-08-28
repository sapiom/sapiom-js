import { deploy, AgentOperationError } from '@sapiom/agent-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom agents deploy` — package the current local source, build it, and wait
 * for the build to finish.
 *
 * No git repository is required. The source is uploaded as an archive; a server
 * that has archives switched off falls back to the old push transparently, so
 * this command behaves the same either way (AGENT-289).
 */
export async function runDeploy(opts: {
  branch?: string;
  message?: string;
  transport?: string;
  host?: string;
  target?: CliTarget;
}): Promise<void> {
  try {
    const dir = process.cwd();
    const cfg = requireConfig(dir);
    const client = makeClient({ projectHost: cfg.host, flagHost: opts.host, flagTarget: opts.target });

    if (opts.transport !== undefined && opts.transport !== "archive" && opts.transport !== "git") {
      // Rejected here rather than passed through: an unrecognised value would
      // silently take the default path, which is the opposite of pinning one.
      throw new CliError({
        code: "BAD_TRANSPORT",
        message: `--transport must be 'archive' or 'git' (got '${opts.transport}').`,
      });
    }

    const result = await deploy(
      {
        projectDir: dir,
        definitionId: cfg.definitionId,
        branch: opts.branch,
        ...(opts.message ? { message: opts.message } : {}),
        ...(opts.transport ? { transport: opts.transport as "archive" | "git" } : {}),
      },
      client,
    );

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
