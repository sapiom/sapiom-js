/**
 * Transport selection for deploy (AGENT-289).
 *
 * The behaviour under test is the fallback rule: try the archive upload, and drop
 * back to the git push ONLY when the server says archives are off. That signal is
 * server-side on purpose — a client-side toggle would be a second source of truth
 * able to disagree with the engine's own switch — so these tests drive it entirely
 * through the response the fake client returns.
 */
import { AgentOperationError } from './errors';

jest.mock('./git.js', () => ({
  assertDeployable: jest.fn(),
  pushSynthesizedTree: jest.fn(),
  pushHead: jest.fn(),
}));
jest.mock('./bundle.js', () => ({
  bundleForDeploy: jest.fn(async () => ({ code: 'export {};', dependencies: {} })),
}));
jest.mock('./pack-source.js', () => ({
  packSource: jest.fn(async () => ({
    archive: Buffer.from('fake-archive'),
    files: ['index.ts', 'package.json'],
    dependencies: {},
  })),
}));

import type { GatewayClient } from './client';

/** A client whose `/source` upload either succeeds or fails with a given error. */
function makeClient(opts: { uploadFails?: AgentOperationError } = {}) {
  return {
    postArchive: jest.fn(async () => {
      if (opts.uploadFails) throw opts.uploadFails;
      return { digest: 'a'.repeat(64), sizeBytes: 12, entryCount: 2, deduped: false };
    }),
    post: jest.fn(async (path: string, body?: unknown) => {
      void body;
      if (path.includes('push-credentials')) return { pushUrl: 'https://x@example.invalid/r.git' };
      return { buildRunId: 'build_1' };
    }),
    get: jest.fn(async () => ({ status: 'ready' })),
  };
}

const load = () => (require('./deploy.js') as typeof import('./deploy.js')).deploy;
const OPTS = { projectDir: '/tmp/fake-project', definitionId: 'def_1' };

afterEach(() => jest.clearAllMocks());

describe('deploy transport selection', () => {
  it('uploads an archive by default and never mints a push credential', async () => {
    const client = makeClient();
    const result = await load()(OPTS, client as unknown as GatewayClient);

    expect(result.status).toBe('ready');
    expect(client.postArchive).toHaveBeenCalledTimes(1);
    // The point of the redesign: no credential is ever handed to the client.
    const posts = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(posts.filter(([p]) => p.includes('push-credentials'))).toHaveLength(0);
  });

  it('builds the digest the SERVER returned, with the author message', async () => {
    const client = makeClient();
    await load()({ ...OPTS, message: 'fix retry backoff' }, client as unknown as GatewayClient);

    const build = (client.post.mock.calls as Array<[string, unknown]>).find(([p]) =>
      p.endsWith('/builds'),
    );
    // Never a locally-computed digest: the server hashes what it actually received.
    expect(build?.[1]).toEqual({ digest: 'a'.repeat(64), message: 'fix retry backoff' });
  });

  it('falls back when the agent imports code outside its own directory', async () => {
    // An existing agent with a shared `kit/` a level up deployed fine via the push
    // path, because esbuild inlined it. It must keep deploying — an author who
    // upgrades the SDK did not ask for their layout to stop working.
    const { packSource } = require('./pack-source.js') as { packSource: jest.Mock };
    packSource.mockRejectedValueOnce(
      new AgentOperationError({ code: 'UNSUPPORTED_LAYOUT', message: 'imports outside' }),
    );
    const client = makeClient();
    const result = await load()(OPTS, client as unknown as GatewayClient);

    expect(result.status).toBe('ready');
    expect(client.postArchive).not.toHaveBeenCalled();
    const posts = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(posts.filter(([p]) => p.includes('push-credentials'))).toHaveLength(1);
  });

  it('falls back when the engine predates the upload route (404)', async () => {
    // The case that actually happens: the CLI ships on npm independently of the
    // engine deploy, so a user can be on a new SDK against an old engine. Without
    // this their deploy fails outright rather than using the path that still works.
    const client = makeClient({
      uploadFails: new AgentOperationError({ code: 'HTTP_404', message: 'Cannot POST /source' }),
    });
    const result = await load()(OPTS, client as unknown as GatewayClient);

    expect(result.status).toBe('ready');
    const posts = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(posts.filter(([p]) => p.includes('push-credentials'))).toHaveLength(1);
  });

  it('falls back to the git push when the server reports archives disabled', async () => {
    const client = makeClient({
      uploadFails: new AgentOperationError({ code: 'HTTP_409', message: 'disabled' }),
    });
    const result = await load()(OPTS, client as unknown as GatewayClient);

    expect(result.status).toBe('ready');
    const posts = client.post.mock.calls as Array<[string, ...unknown[]]>;
    expect(posts.filter(([p]) => p.includes('push-credentials'))).toHaveLength(1);
  });

  it('does NOT fall back on an unrelated upload failure', async () => {
    // A rejected archive (400) or an auth problem (401) is a real error the author
    // must see. Falling back would hide it and silently deploy by a different
    // route — the transport is not a retry strategy for genuine failures.
    for (const code of ['HTTP_400', 'HTTP_401', 'HTTP_500', 'NETWORK']) {
      const client = makeClient({ uploadFails: new AgentOperationError({ code, message: code }) });
      await expect(load()(OPTS, client as unknown as GatewayClient)).rejects.toMatchObject({ code });
      const posts = client.post.mock.calls as Array<[string, ...unknown[]]>;
      expect(posts.filter(([p]) => p.includes('push-credentials'))).toHaveLength(0);
      jest.clearAllMocks();
    }
  });

  it('surfaces the 409 instead of falling back when archive is pinned', async () => {
    const client = makeClient({
      uploadFails: new AgentOperationError({ code: 'HTTP_409', message: 'disabled' }),
    });
    await expect(
      load()({ ...OPTS, transport: 'archive' }, client as unknown as GatewayClient),
    ).rejects.toMatchObject({ code: 'HTTP_409' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('never attempts an upload when git is pinned', async () => {
    const client = makeClient();
    await load()({ ...OPTS, transport: 'git' }, client as unknown as GatewayClient);
    expect(client.postArchive).not.toHaveBeenCalled();
  });
});
