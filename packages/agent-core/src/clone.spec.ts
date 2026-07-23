/**
 * Unit tests for `clone` (the template-clone handoff, SAP-1357, and the
 * definitionId clone-a-deployed-workflow path, SAP-1839).
 *
 * Fully offline: global.fetch is mocked for the fork/clone-token/definitions
 * calls, and the git clone is injected as a fake that only records its inputs
 * and materializes an empty target dir. The filesystem (a temp dir) is the
 * only real dependency.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createClient } from './client';
import { clone } from './clone';
import { CONFIG_FILE } from './config';
import type { CloneRepoOptions } from './git';

type MockResponse = { status: number; body: unknown };

function mockFetch(responses: MockResponse[]): jest.SpyInstance {
  let i = 0;
  return jest.spyOn(global, 'fetch' as never).mockImplementation((async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    const text = JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'Error',
      text: async () => text,
    } as Response;
  }) as never);
}

function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'sapiom-clone-test-'));
}

const client = createClient({ host: 'https://example.com', apiKey: 'sk_test' });

const FORK_BODY = {
  id: 'fork-uuid-1',
  templateId: 'web-research-digest',
  repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
  defaultBranch: 'main',
};
const TOKEN_BODY = {
  repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
  defaultBranch: 'main',
  cloneUrl: 'https://x-access-token:ghs_secretTOKEN@github.com/Sapiom-Platform/sapiom-fork-abc.git',
  expiresAt: '2026-07-07T01:00:00.000Z',
};
const DEFINITION_TOKEN_BODY = {
  repoFullName: 'Sapiom-Platform/ag-uuid-1',
  defaultBranch: 'main',
  cloneUrl: 'https://x-access-token:ghs_secretTOKEN@github.com/Sapiom-Platform/ag-uuid-1.git',
  expiresAt: '2026-07-07T01:00:00.000Z',
};

/** A fake clone that just records its inputs and creates the target dir. */
function recordingClone(): { fn: (o: CloneRepoOptions) => void; calls: CloneRepoOptions[] } {
  const calls: CloneRepoOptions[] = [];
  return {
    calls,
    fn: (o: CloneRepoOptions) => {
      calls.push(o);
      mkdirSync(o.targetDir, { recursive: true });
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('clone', () => {
  it('forks a template, mints a token, clones, and writes provenance', async () => {
    const spy = mockFetch([
      { status: 200, body: FORK_BODY },
      { status: 200, body: TOKEN_BODY },
    ]);
    const base = makeTmp();
    const target = path.join(base, 'project');
    const rec = recordingClone();
    try {
      const result = await clone(
        { templateId: 'web-research-digest', targetDir: target, cloneRepo: rec.fn },
        client,
      );

      // Hits fork then clone-token, in order.
      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls[0]).toBe('https://example.com/v1/workflows/templates/web-research-digest/fork');
      expect(urls[1]).toBe('https://example.com/v1/workflows/forks/fork-uuid-1/clone-token');

      // Clones with the minted URL and checks out the fork's default branch.
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].cloneUrl).toBe(TOKEN_BODY.cloneUrl);
      expect(rec.calls[0].branch).toBe('main');
      expect(rec.calls[0].targetDir).toBe(target);

      // Result carries provenance but NEVER the credential.
      expect(result).toMatchObject({
        forkId: 'fork-uuid-1',
        templateId: 'web-research-digest',
        repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
        defaultBranch: 'main',
        targetDir: target,
        tokenExpiresAt: '2026-07-07T01:00:00.000Z',
      });
      expect(JSON.stringify(result)).not.toContain('ghs_secretTOKEN');

      // sapiom.json records provenance, no definitionId (created at deploy), no token.
      const cfg = JSON.parse(readFileSync(path.join(target, CONFIG_FILE), 'utf8'));
      expect(cfg).toEqual({
        repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
        defaultBranch: 'main',
        forkId: 'fork-uuid-1',
        templateId: 'web-research-digest',
      });
      expect(JSON.stringify(cfg)).not.toContain('ghs_secretTOKEN');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('clones an existing fork without forking (no templateId in config)', async () => {
    mockFetch([{ status: 200, body: TOKEN_BODY }]);
    const base = makeTmp();
    const target = path.join(base, 'project');
    const rec = recordingClone();
    try {
      const result = await clone({ forkId: 'fork-uuid-1', targetDir: target, cloneRepo: rec.fn }, client);

      expect(result.forkId).toBe('fork-uuid-1');
      expect(result.templateId).toBeUndefined();
      const cfg = JSON.parse(readFileSync(path.join(target, CONFIG_FILE), 'utf8'));
      expect(cfg.templateId).toBeUndefined();
      expect(cfg.forkId).toBe('fork-uuid-1');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('clones by definitionId directly (no fork step), and pre-links sapiom.json', async () => {
    const spy = mockFetch([{ status: 200, body: DEFINITION_TOKEN_BODY }]);
    const base = makeTmp();
    const target = path.join(base, 'project');
    const rec = recordingClone();
    try {
      const result = await clone(
        { definitionId: '253', targetDir: target, cloneRepo: rec.fn },
        client,
      );

      // Hits the definitions clone-token endpoint directly — no fork call.
      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls).toEqual(['https://example.com/v1/workflows/definitions/253/clone-token']);

      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].cloneUrl).toBe(DEFINITION_TOKEN_BODY.cloneUrl);
      expect(rec.calls[0].branch).toBe('main');

      // Result carries the definitionId, no forkId/templateId, no credential.
      expect(result).toMatchObject({
        definitionId: '253',
        repoFullName: 'Sapiom-Platform/ag-uuid-1',
        defaultBranch: 'main',
        targetDir: target,
      });
      expect(result.forkId).toBeUndefined();
      expect(result.templateId).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('ghs_secretTOKEN');

      // sapiom.json is pre-linked: definitionId present, no forkId, no token.
      const cfg = JSON.parse(readFileSync(path.join(target, CONFIG_FILE), 'utf8'));
      expect(cfg).toEqual({
        repoFullName: 'Sapiom-Platform/ag-uuid-1',
        defaultBranch: 'main',
        definitionId: '253',
      });
      expect(JSON.stringify(cfg)).not.toContain('ghs_secretTOKEN');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects when none of templateId, forkId, or definitionId is given', async () => {
    const spy = mockFetch([{ status: 200, body: {} }]);
    await expect(clone({ targetDir: '/tmp/whatever', cloneRepo: () => {} }, client)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects when more than one of templateId, forkId, or definitionId is given', async () => {
    await expect(
      clone({ templateId: 't', forkId: 'f', targetDir: '/tmp/whatever', cloneRepo: () => {} }, client),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      clone(
        { templateId: 't', definitionId: '1', targetDir: '/tmp/whatever', cloneRepo: () => {} },
        client,
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      clone(
        { forkId: 'f', definitionId: '1', targetDir: '/tmp/whatever', cloneRepo: () => {} },
        client,
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('rejects a non-empty target directory before any network call', async () => {
    const base = makeTmp();
    const target = path.join(base, 'project');
    mkdirSync(target, { recursive: true });
    // Make it non-empty.
    mkdirSync(path.join(target, 'sub'));
    const spy = mockFetch([{ status: 200, body: {} }]);
    try {
      await expect(clone({ forkId: 'f', targetDir: target, cloneRepo: () => {} }, client)).rejects.toMatchObject({
        code: 'DIR_NOT_EMPTY',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a non-https clone URL from the endpoint (never handed to git)', async () => {
    mockFetch([{ status: 200, body: { ...TOKEN_BODY, cloneUrl: '--upload-pack=touch /tmp/pwned' } }]);
    const base = makeTmp();
    const target = path.join(base, 'project');
    const rec = recordingClone();
    try {
      await expect(clone({ forkId: 'f', targetDir: target, cloneRepo: rec.fn }, client)).rejects.toMatchObject({
        code: 'BAD_CLONE_URL',
      });
      expect(rec.calls).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('surfaces a gateway error from the fork call', async () => {
    mockFetch([{ status: 404, body: { message: 'No such template' } }]);
    const base = makeTmp();
    try {
      await expect(
        clone({ templateId: 'missing', targetDir: path.join(base, 'p'), cloneRepo: () => {} }, client),
      ).rejects.toMatchObject({ code: 'HTTP_404' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
