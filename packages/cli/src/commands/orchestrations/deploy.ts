import { GatewayClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { assertDeployable, pushHead } from '../../lib/git.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

interface BuildRun {
  id?: string;
  buildRunId?: string;
  status: string;
  error?: { name?: string; message?: string; stack?: string } | null;
}

const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'superseded']);
const POLL_DELAYS_MS = [1000, 2000, 3000, 5000, 5000, 8000, 10000];
const POLL_BUDGET_MS = 300_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `sapiom orchestrations deploy` — mint push credentials, push the current
 * commit, trigger a build, and wait for it to finish.
 */
export async function runDeploy(opts: { branch?: string }): Promise<void> {
  const dir = process.cwd();
  const cfg = requireConfig(dir);
  assertDeployable(dir);
  const client = new GatewayClient(cfg.host);

  const { pushUrl } = await client.post<{ pushUrl: string }>(
    `/definitions/${cfg.definitionId}/push-credentials`,
    {},
  );
  pushHead(dir, pushUrl, opts.branch ?? 'main');

  const triggered = await client.post<BuildRun>(`/definitions/${cfg.definitionId}/builds`, {});
  const buildRunId = triggered.buildRunId ?? triggered.id;
  if (!buildRunId) {
    throw new CliError({ code: 'BUILD_NO_ID', message: 'The build was triggered but no build id was returned.' });
  }

  const final = await pollBuild(client, cfg.definitionId, buildRunId);
  if (final.status !== 'ready') {
    throw new CliError({
      code: 'BUILD_FAILED',
      message: `Build ${final.status}.`,
      step: 'build',
      hint: final.error?.stack || final.error?.message,
    });
  }

  if (isJsonMode()) {
    ok({ definitionId: cfg.definitionId, buildRunId, status: final.status });
  } else {
    ok({}, [`✓ Deployed ${cfg.name} (build ${final.status})`]);
  }
}

async function pollBuild(client: GatewayClient, definitionId: string, buildRunId: string): Promise<BuildRun> {
  let elapsed = 0;
  let i = 0;
  while (elapsed < POLL_BUDGET_MS) {
    const build = await client.get<BuildRun>(`/definitions/${definitionId}/builds/${buildRunId}`);
    if (TERMINAL.has(build.status)) return build;
    const delay = POLL_DELAYS_MS[Math.min(i++, POLL_DELAYS_MS.length - 1)];
    await sleep(delay);
    elapsed += delay;
  }
  throw new CliError({
    code: 'BUILD_TIMEOUT',
    message: 'Build did not finish in time.',
    step: 'build',
    hint: `Check it later: sapiom orchestrations logs --build ${buildRunId}`,
  });
}
