import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getSandbox, readSandboxes, writeSandbox, configureSandbox, checkSandboxes } from './config.js';
import { PreviewOperationError } from './errors.js';
import { CONFIG_VERSION } from './schema.js';

function tmpProject(contents?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbxprev-'));
  if (contents !== undefined) {
    writeFileSync(path.join(dir, 'sapiom.json'), JSON.stringify(contents));
  }
  return dir;
}

const webSandbox = {
  type: 'sandbox',
  source: { kind: 'upload' },
  start: 'node server.js',
  port: 3000,
};

describe('config — getSandbox', () => {
  it('returns the sole sandbox when no name is given (singular-default)', () => {
    const dir = tmpProject({ resources: { web: webSandbox } });
    try {
      const sb = getSandbox(dir);
      expect(sb.name).toBe('web');
      expect(sb.port).toBe(3000);
      expect(sb.source).toEqual({ kind: 'upload' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws AMBIGUOUS when multiple sandboxes and no name', () => {
    const dir = tmpProject({ resources: { web: webSandbox, api: { ...webSandbox, port: 4000 } } });
    try {
      expect(() => getSandbox(dir)).toThrow(/Multiple sandboxes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selects by name and throws NO_SANDBOX for an unknown name', () => {
    const dir = tmpProject({ resources: { web: webSandbox, api: { ...webSandbox, port: 4000 } } });
    try {
      expect(getSandbox(dir, 'api').port).toBe(4000);
      expect(() => getSandbox(dir, 'nope')).toThrow(/No sandbox named 'nope'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-sandbox resources', () => {
    const dir = tmpProject({
      definitionId: 'orch_1',
      resources: { flow: { type: 'agent', definitionId: 'orch_1' }, web: webSandbox },
    });
    try {
      expect(Object.keys(readSandboxes(dir))).toEqual(['web']);
      expect(getSandbox(dir).name).toBe('web');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws NO_SANDBOX when the file or map is missing/empty', () => {
    const dir = tmpProject();
    try {
      expect(() => getSandbox(dir)).toThrow(/No sandbox resources/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config — writeSandbox / configureSandbox', () => {
  it('merges into resources without clobbering siblings or top-level keys, and stamps version', () => {
    const dir = tmpProject({ definitionId: 'orch_1', resources: { flow: { type: 'agent' } } });
    try {
      writeSandbox(dir, {
        name: 'web',
        source: { kind: 'upload' },
        start: 'node server.js',
        port: 3000,
        ttl: '7d',
      });
      const raw = JSON.parse(readFileSync(path.join(dir, 'sapiom.json'), 'utf8'));
      expect(raw.version).toBe(CONFIG_VERSION);
      expect(raw.definitionId).toBe('orch_1');
      expect(raw.resources.flow).toEqual({ type: 'agent' });
      expect(raw.resources.web).toEqual({
        type: 'sandbox',
        source: { kind: 'upload' },
        start: 'node server.js',
        port: 3000,
        ttl: '7d',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid body with an actionable hint (no file written)', () => {
    const dir = tmpProject();
    try {
      let caught: unknown;
      try {
        // @ts-expect-error — deliberately invalid (missing start, bad port) to exercise validation
        configureSandbox(dir, 'web', { source: { kind: 'upload' }, port: 0 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PreviewOperationError);
      expect((caught as PreviewOperationError).message).toMatch(/Invalid sandbox configuration/);
      expect((caught as PreviewOperationError).hint).toMatch(/start.*required|port/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config — validation on read', () => {
  it('throws an actionable error for a malformed sandbox entry', () => {
    const dir = tmpProject({ resources: { web: { type: 'sandbox', source: { kind: 'upload' }, port: 3000 } } });
    try {
      // missing `start`
      expect(() => getSandbox(dir)).toThrow(/Invalid sandbox resource "web"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a config from a newer tool version', () => {
    const dir = tmpProject({ version: CONFIG_VERSION + 1, resources: { web: webSandbox } });
    try {
      expect(() => getSandbox(dir)).toThrow(/version .*supports up to/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on non-JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbxprev-'));
    writeFileSync(path.join(dir, 'sapiom.json'), '{ not json');
    try {
      expect(() => getSandbox(dir)).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config — checkSandboxes', () => {
  it('reports ok with the sandbox names when all valid', () => {
    const dir = tmpProject({ resources: { web: webSandbox, api: { ...webSandbox, port: 4000 } } });
    try {
      const result = checkSandboxes(dir);
      expect(result.ok).toBe(true);
      expect(result.sandboxes.sort()).toEqual(['api', 'web']);
      expect(result.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collects issues (does not throw) for an invalid entry', () => {
    const dir = tmpProject({ resources: { web: { type: 'sandbox', source: { kind: 'upload' }, port: 3000 } } });
    try {
      const result = checkSandboxes(dir);
      expect(result.ok).toBe(false);
      expect(result.sandboxes).toEqual(['web']);
      expect(result.issues.join(' ')).toMatch(/start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
