/**
 * deploy — mint push credentials, push the current commit, trigger a build,
 * and poll until the build reaches a terminal state.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly;
 * no process.cwd() reads — the caller supplies the project directory and client.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bundleForDeploy } from './bundle.js';
import { GatewayClient } from './client.js';
import { OrchestrationError } from './errors.js';
import { assertDeployable, pushSynthesizedTree } from './git.js';

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

export interface DeployOptions {
  /** Absolute path to the orchestration project directory. */
  projectDir: string;
  /** Server-side definition ID (from sapiom.json or resolved by the caller). */
  definitionId: string;
  /** Branch to push to; defaults to 'main'. */
  branch?: string;
}

export interface DeployResult {
  definitionId: string;
  buildRunId: string;
  status: string;
}

/**
 * Deploy the current commit of an orchestration project.
 *
 * Validates the git state, mints push credentials, pushes HEAD, triggers a
 * build, and polls until the build reaches a terminal status.
 *
 * Throws `OrchestrationError` on git, network, or build failures.
 */
export async function deploy(opts: DeployOptions, client: GatewayClient): Promise<DeployResult> {
  const { projectDir, definitionId, branch = 'main' } = opts;

  assertDeployable(projectDir);

  // Bundle the definition's LOCAL code (inlining relative/shared imports) into a
  // self-contained `index.ts`, with npm packages left external + surfaced as a
  // generated package.json (pinned to the author's installed versions). We push
  // THIS synthesized tree — not the author's raw commit — so shared local utils
  // (relative imports that escape the repo root) are already inlined, while the
  // server build still installs the npm deps (bring-your-own-deps).
  const { code, dependencies } = await bundleForDeploy(projectDir);

  const { pushUrl } = await client.post<{ pushUrl: string }>(
    `/definitions/${definitionId}/push-credentials`,
    {},
  );

  const treeDir = mkdtempSync(path.join(tmpdir(), 'sapiom-deploy-'));
  try {
    writeFileSync(path.join(treeDir, 'index.ts'), code);
    writeFileSync(
      path.join(treeDir, 'package.json'),
      JSON.stringify({ name: 'orchestration-definition', private: true, type: 'module', dependencies }, null, 2) + '\n',
    );
    pushSynthesizedTree(treeDir, pushUrl, branch);
  } finally {
    rmSync(treeDir, { recursive: true, force: true });
  }

  const triggered = await client.post<BuildRun>(`/definitions/${definitionId}/builds`, {});
  const buildRunId = triggered.buildRunId ?? triggered.id;
  if (!buildRunId) {
    throw new OrchestrationError({
      code: 'BUILD_NO_ID',
      message: 'The build was triggered but no build id was returned.',
    });
  }

  const final = await pollBuild(client, definitionId, buildRunId);
  if (final.status !== 'ready') {
    throw new OrchestrationError({
      code: 'BUILD_FAILED',
      message: `Build ${final.status}.`,
      step: 'build',
      hint: final.error?.stack || final.error?.message,
    });
  }

  return { definitionId, buildRunId, status: final.status };
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
  throw new OrchestrationError({
    code: 'BUILD_TIMEOUT',
    message: 'Build did not finish in time.',
    step: 'build',
    hint: `Check it later via the logs API for build ${buildRunId}`,
  });
}
