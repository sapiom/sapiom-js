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

jest.mock('@sapiom/tools', () => ({
  createClient: () => ({ sandboxes: { get: mockGet, create: mockCreate, attach: mockAttach } }),
}));

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

  it('rejects an unsupported (git) source kind before any client call', async () => {
    const dir = tmpProject({ ...UPLOAD_SANDBOX, source: { kind: 'git', slug: 'x' } });
    try {
      await expect(previewSandbox({ dir })).rejects.toThrow(/not supported yet/);
      expect(mockAttach).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
