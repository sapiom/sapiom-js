/**
 * Unit tests for deploy.ts — focused on the retry-on-auth-failure and
 * superseded-build messaging behaviors introduced alongside the git credential
 * redaction fix.
 *
 * Fully offline: GatewayClient and pushSynthesizedTree are replaced with
 * controlled stubs so no network call or git process runs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { AgentOperationError } from './errors';

// ---------------------------------------------------------------------------
// Module-level stubs for git.ts and bundle.ts so deploy.ts never touches the
// real git binary or esbuild.
// ---------------------------------------------------------------------------

jest.mock('./git.js', () => ({
  assertDeployable: jest.fn(),
  pushSynthesizedTree: jest.fn(),
}));

jest.mock('./bundle.js', () => ({
  bundleForDeploy: jest.fn().mockResolvedValue({ code: 'export default {};', dependencies: {} }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal GatewayClient stand-in that records calls and returns scripted responses. */
function makeClient(opts: {
  pushCredentials: Array<() => { pushUrl: string }>;
  pollBuild?: () => { status: string; error?: { message?: string; stack?: string } | null };
}) {
  let credIdx = 0;
  return {
    post: jest.fn(async (path: string) => {
      if (path.includes('push-credentials')) {
        const provider = opts.pushCredentials[credIdx++] ?? opts.pushCredentials[opts.pushCredentials.length - 1];
        return provider();
      }
      // trigger build
      return { buildRunId: 'build_1' };
    }),
    get: jest.fn(async () => {
      if (opts.pollBuild) return opts.pollBuild();
      return { status: 'ready' };
    }),
  };
}

function makeTmpDir(): string {
  return mkdtempSync(`${tmpdir()}/sapiom-deploy-test-`);
}

// ---------------------------------------------------------------------------
// Imports after mocks are declared (jest.mock hoists, so this is safe).
// ---------------------------------------------------------------------------

import type { GatewayClient } from './client';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deploy — push retry on auth failure', () => {
  let pushSynthesizedTree: jest.Mock;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const git = require('./git.js') as { pushSynthesizedTree: jest.Mock };
    pushSynthesizedTree = git.pushSynthesizedTree;
    pushSynthesizedTree.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('retries the push once with a fresh credential on an auth-class GIT error', async () => {
    // First push throws an auth-class error (synchronously — the real function is sync).
    // Second push succeeds.
    const authErr = new AgentOperationError({
      code: 'GIT',
      message: 'git push failed.',
      hint: 'Authentication failed for https://***@github.com/owner/repo.git',
    });
    let pushCallCount = 0;
    pushSynthesizedTree.mockImplementation(() => {
      pushCallCount += 1;
      if (pushCallCount === 1) throw authErr;
      // second call succeeds
    });

    const client = makeClient({
      pushCredentials: [
        () => ({ pushUrl: 'https://x-access-token:OLD_TOKEN@github.com/owner/repo.git' }),
        () => ({ pushUrl: 'https://x-access-token:NEW_TOKEN@github.com/owner/repo.git' }),
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    const result = await deploy(
      { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
      client as unknown as GatewayClient,
    );

    expect(result.status).toBe('ready');
    // push-credentials was minted twice (initial + re-mint on auth failure).
    const calls = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.filter(([p]) => p.includes('push-credentials'))).toHaveLength(2);
    // pushSynthesizedTree was called twice (first attempt + retry).
    expect(pushSynthesizedTree).toHaveBeenCalledTimes(2);
    // Second push used the fresh URL.
    const secondPushUrl = pushSynthesizedTree.mock.calls[1][1] as string;
    expect(secondPushUrl).toContain('NEW_TOKEN');
  });

  it('does NOT retry on a non-auth push failure', async () => {
    const nonAuthErr = new AgentOperationError({
      code: 'GIT',
      message: 'git push failed.',
      hint: 'Updates were rejected because the remote contains work that you do not have locally.',
    });
    pushSynthesizedTree.mockImplementation(() => {
      throw nonAuthErr;
    });

    const client = makeClient({
      pushCredentials: [() => ({ pushUrl: 'https://host/repo.git' })],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    await expect(
      deploy(
        { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
        client as unknown as GatewayClient,
      ),
    ).rejects.toMatchObject({ code: 'GIT', hint: expect.stringContaining('rejected') });

    // push-credentials minted exactly once (no re-mint on non-auth error).
    const calls = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.filter(([p]) => p.includes('push-credentials'))).toHaveLength(1);
    expect(pushSynthesizedTree).toHaveBeenCalledTimes(1);
  });

  it('surfaces the retry push error when both the first and retry push fail', async () => {
    const authErr = new AgentOperationError({
      code: 'GIT',
      message: 'git push failed.',
      hint: 'could not read from remote repository',
    });
    const retryErr = new AgentOperationError({
      code: 'GIT',
      message: 'git push failed.',
      hint: 'could not read from remote repository (retry)',
    });
    let callCount = 0;
    pushSynthesizedTree.mockImplementation(() => {
      callCount += 1;
      throw callCount === 1 ? authErr : retryErr;
    });

    const client = makeClient({
      pushCredentials: [
        () => ({ pushUrl: 'https://host/repo.git' }),
        () => ({ pushUrl: 'https://host/repo.git' }),
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    await expect(
      deploy(
        { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
        client as unknown as GatewayClient,
      ),
    ).rejects.toMatchObject({ code: 'GIT', hint: expect.stringContaining('retry') });

    expect(pushSynthesizedTree).toHaveBeenCalledTimes(2);
  });
});

describe('deploy — superseded build messaging', () => {
  let pushSynthesizedTree: jest.Mock;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const git = require('./git.js') as { pushSynthesizedTree: jest.Mock };
    pushSynthesizedTree = git.pushSynthesizedTree;
    pushSynthesizedTree.mockReset().mockImplementation(() => {
      // no-op: push succeeds
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('throws BUILD_SUPERSEDED (not BUILD_FAILED) when the build poll returns superseded', async () => {
    const client = makeClient({
      pushCredentials: [() => ({ pushUrl: 'https://host/repo.git' })],
      pollBuild: () => ({ status: 'superseded' }),
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    await expect(
      deploy(
        { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
        client as unknown as GatewayClient,
      ),
    ).rejects.toMatchObject({
      code: 'BUILD_SUPERSEDED',
      message: 'A newer deploy superseded this build.',
    });
  });

  it('throws BUILD_FAILED for a non-superseded terminal failure', async () => {
    const client = makeClient({
      pushCredentials: [() => ({ pushUrl: 'https://host/repo.git' })],
      pollBuild: () => ({ status: 'failed', error: { message: 'Compilation error.' } }),
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    await expect(
      deploy(
        { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
        client as unknown as GatewayClient,
      ),
    ).rejects.toMatchObject({
      code: 'BUILD_FAILED',
      message: 'Build failed.',
      hint: 'Compilation error.',
    });
  });

  it('resolves successfully for a ready build', async () => {
    const client = makeClient({
      pushCredentials: [() => ({ pushUrl: 'https://host/repo.git' })],
      pollBuild: () => ({ status: 'ready' }),
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deploy } = require('./deploy.js') as typeof import('./deploy.js');
    const result = await deploy(
      { projectDir: makeTmpDir(), definitionId: 'def_1', branch: 'main' },
      client as unknown as GatewayClient,
    );
    expect(result.status).toBe('ready');
  });
});
