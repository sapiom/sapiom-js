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

import { getOrchestrationAnalytics, telemetryErrorCode } from './analytics.js';
import { bundleForDeploy } from './bundle.js';
import { GatewayClient } from './client.js';
import { AgentOperationError } from './errors.js';
import { assertDeployable, pushHead, pushSynthesizedTree } from './git.js';

/**
 * Whether a git push error looks like an auth failure — a short-lived push
 * credential may have expired between the mint and the push (e.g. a slow
 * bundle). Matches the patterns git reports for HTTP 401/403 and credential
 * rejection, checking the already-redacted hint so the match is safe to log.
 */
function isPushAuthError(err: unknown): boolean {
  if (!(err instanceof AgentOperationError) || err.code !== 'GIT') return false;
  const text = ((err.hint ?? '') + ' ' + err.message).toLowerCase();
  return (
    text.includes('authentication failed') ||
    text.includes('could not read from') ||
    text.includes('the requested url returned error: 401') ||
    text.includes('the requested url returned error: 403')
  );
}

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
  /** Absolute path to the agent project directory. */
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
 * Deploy the current commit of an agent project.
 *
 * Validates the git state, mints push credentials, pushes HEAD, triggers a
 * build, and polls until the build reaches a terminal status.
 *
 * Throws `AgentOperationError` on git, network, or build failures.
 *
 * Emits one `workflow.deploy` usage-analytics event (metadata only: ids,
 * status, duration). Live by default — see ./analytics.ts; telemetry never
 * changes the operation's behavior.
 */
export async function deploy(opts: DeployOptions, client: GatewayClient): Promise<DeployResult> {
  const startedAt = Date.now();
  try {
    const result = await deployOperation(opts, client);
    getOrchestrationAnalytics().track('workflow.deploy', {
      workflow_id: opts.definitionId,
      branch: opts.branch ?? 'main',
      build_run_id: result.buildRunId,
      build_status: result.status,
      status: 'success',
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    getOrchestrationAnalytics().track('workflow.deploy', {
      workflow_id: opts.definitionId,
      branch: opts.branch ?? 'main',
      status: 'error',
      error_code: telemetryErrorCode(err),
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  }
}

/** The operation body — unchanged from before the analytics wrapper. */
async function deployOperation(opts: DeployOptions, client: GatewayClient): Promise<DeployResult> {
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
      JSON.stringify({ name: 'agent-definition', private: true, type: 'module', dependencies }, null, 2) + '\n',
    );
    try {
      pushSynthesizedTree(treeDir, pushUrl, branch);
    } catch (pushErr) {
      // The push credential is short-lived; re-mint once and retry when the
      // failure looks like an auth rejection (HTTP 401/403, "Authentication
      // failed", "could not read from"). Non-auth failures (non-fast-forward,
      // DNS, no-commits) surface immediately with no retry.
      if (!isPushAuthError(pushErr)) throw pushErr;
      const { pushUrl: freshPushUrl } = await client.post<{ pushUrl: string }>(
        `/definitions/${definitionId}/push-credentials`,
        {},
      );
      // The tree is already init'd + committed — only repeat the push with the
      // fresh credential. Calling pushSynthesizedTree again would re-run
      // git init/add/commit on an already-committed dir and fail with
      // "nothing to commit" before the push ever fires.
      pushHead(treeDir, freshPushUrl, branch);
    }
  } finally {
    rmSync(treeDir, { recursive: true, force: true });
  }

  const triggered = await client.post<BuildRun>(`/definitions/${definitionId}/builds`, {});
  const buildRunId = triggered.buildRunId ?? triggered.id;
  if (!buildRunId) {
    throw new AgentOperationError({
      code: 'BUILD_NO_ID',
      message: 'The build was triggered but no build id was returned.',
    });
  }

  const final = await pollBuild(client, definitionId, buildRunId);
  if (final.status !== 'ready') {
    if (final.status === 'superseded') {
      // A newer deploy replaced this one while the build was in flight —
      // expected when the user re-deploys quickly. Surface a distinct code so
      // the UI can treat this as informational rather than a hard failure.
      throw new AgentOperationError({
        code: 'BUILD_SUPERSEDED',
        message: 'A newer deploy superseded this build.',
        step: 'build',
      });
    }
    throw new AgentOperationError({
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
  throw new AgentOperationError({
    code: 'BUILD_TIMEOUT',
    message: 'Build did not finish in time.',
    step: 'build',
    hint: `Check it later via the logs API for build ${buildRunId}`,
  });
}
