import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { previewSandbox } from './preview.js';

// jest hoists jest.mock above imports; factory-referenced vars must be `mock`-prefixed.
const mockGet = jest.fn();
const mockCreate = jest.fn().mockResolvedValue({});
const mockUploadDir = jest.fn().mockResolvedValue(undefined);
const mockDeployPreview = jest.fn();
const mockAttach = jest.fn(() => ({ uploadDir: mockUploadDir, deployPreview: mockDeployPreview }));
const mockRepoGet = jest.fn();
const mockRepoCreate = jest.fn();
const mockPushLocalDir = jest.fn();

jest.mock('@sapiom/tools', () => ({
  createClient: () => ({
    sandboxes: { get: mockGet, create: mockCreate, attach: mockAttach },
    repositories: { get: mockRepoGet, create: mockRepoCreate },
  }),
}));
jest.mock('./git-push.js', () => ({ pushLocalDir: (...args: unknown[]) => mockPushLocalDir(...args) }));

function tmpProject(sandbox: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbxprev-'));
  writeFileSync(path.join(dir, 'sapiom.json'), JSON.stringify({ resources: { web: sandbox } }));
  return dir;
}

const UPLOAD_SANDBOX = { type: 'sandbox', source: { kind: 'upload' }, build: 'npm install', start: 'node server.js', port: 3000 };

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ status: 'running', url: 'https://rt' });
  mockDeployPreview.mockResolvedValue({ url: 'https://x.preview.bl.run', status: 'deployed', logs: '' });
});

describe('previewSandbox', () => {
  it('reuses a running sandbox: uploads then deploys, returns the result', async () => {
    const dir = tmpProject(UPLOAD_SANDBOX);
    try {
      const result = await previewSandbox({ dir, apiKey: 'sk_test' });

      expect(mockCreate).not.toHaveBeenCalled(); // sandbox already exists
      expect(mockUploadDir).toHaveBeenCalledWith(path.resolve(dir, '.'));
      expect(mockDeployPreview).toHaveBeenCalledWith({
        build: 'npm install',
        start: 'node server.js',
        port: 3000,
        env: undefined,
      });
      expect(result).toEqual({ name: 'web', url: 'https://x.preview.bl.run', status: 'deployed', logs: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provisions the sandbox when absent, then deploys', async () => {
    mockGet.mockRejectedValueOnce(new Error('404 not found')); // existence check
    mockGet.mockResolvedValue({ status: 'running', url: 'https://rt' }); // readiness poll
    const dir = tmpProject(UPLOAD_SANDBOX);
    try {
      await previewSandbox({ dir, apiKey: 'sk_test' });
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'web', port: 3000 }));
      expect(mockDeployPreview).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git source: ensures the repo (create-if-absent), pushes local, deploys from git', async () => {
    mockRepoGet.mockRejectedValue(new Error('404')); // repo does not exist yet
    mockRepoCreate.mockResolvedValue({ slug: 'my-app', cloneUrl: 'http://git.local/repositories/t/my-app' });
    const dir = tmpProject({ ...UPLOAD_SANDBOX, source: { kind: 'git', slug: 'my-app' } });
    try {
      const result = await previewSandbox({ dir, apiKey: 'sk_test' });

      expect(mockRepoCreate).toHaveBeenCalledWith('my-app');
      expect(mockPushLocalDir).toHaveBeenCalledWith(
        path.resolve(dir, '.'),
        'http://git.local/repositories/t/my-app',
        'sk_test',
      );
      expect(mockUploadDir).not.toHaveBeenCalled(); // git source doesn't upload
      expect(mockDeployPreview).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'git', repo: 'my-app' } }));
      expect(result.status).toBe('deployed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git source: reuses an existing repo (no create)', async () => {
    mockRepoGet.mockResolvedValue({ slug: 'my-app', cloneUrl: 'http://git.local/repositories/t/my-app' });
    const dir = tmpProject({ ...UPLOAD_SANDBOX, source: { kind: 'git', slug: 'my-app' } });
    try {
      await previewSandbox({ dir, apiKey: 'sk_test' });
      expect(mockRepoCreate).not.toHaveBeenCalled();
      expect(mockPushLocalDir).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
