import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getSandbox,
  readSandboxes,
  writeSandbox,
  configureSandbox,
  checkSandboxes,
  resolveSourceDir,
} from './config.js';
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

describe('config — source.path containment', () => {
  const withPath = (sourcePath: string, kind: 'upload' | 'git' = 'upload') => ({
    ...webSandbox,
    source: kind === 'git' ? { kind, slug: 'web-repo', path: sourcePath } : { kind, path: sourcePath },
  });

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (e) {
      return (e as PreviewOperationError).code;
    }
    return undefined;
  }

  it.each(['../..', '..', 'web/../../x', '/etc'])('getSandbox rejects source.path %p', (sourcePath) => {
    const dir = tmpProject({ resources: { web: withPath(sourcePath) } });
    try {
      expect(codeOf(() => getSandbox(dir))).toBe('SOURCE_OUTSIDE_PROJECT');
      expect(codeOf(() => getSandbox(dir, 'web'))).toBe('SOURCE_OUTSIDE_PROJECT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['upload', '../..'],
    ['git', '../..'],
    ['upload', '/etc'],
  ] as const)('configureSandbox refuses a %s source with path %p and writes nothing', (kind, sourcePath) => {
    const dir = tmpProject();
    try {
      const { type: _type, ...body } = withPath(sourcePath, kind);
      let caught: unknown;
      try {
        configureSandbox(dir, 'web', body as Parameters<typeof configureSandbox>[2]);
      } catch (e) {
        caught = e;
      }
      expect((caught as PreviewOperationError).code).toBe('INVALID_SANDBOX');
      expect((caught as PreviewOperationError).hint).toMatch(/source\.path/);
      expect(existsSync(path.join(dir, 'sapiom.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('configureSandbox refuses an absolute path even when it points inside the project, leaving the file intact', () => {
    const dir = tmpProject({ resources: { web: webSandbox } });
    try {
      const before = readFileSync(path.join(dir, 'sapiom.json'), 'utf8');
      const body = { source: { kind: 'upload' as const, path: path.resolve(dir, 'web') }, start: 'node server.js', port: 3000 };
      expect(codeOf(() => configureSandbox(dir, 'web', body))).toBe('INVALID_SANDBOX');
      expect(readFileSync(path.join(dir, 'sapiom.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a source directory that is a symlink to outside the project, accepts one that stays inside', () => {
    const dir = tmpProject({ resources: { web: withPath('web') } });
    const outside = mkdtempSync(path.join(tmpdir(), 'sbxprev-outside-'));
    try {
      symlinkSync(outside, path.join(dir, 'web'));
      expect(codeOf(() => getSandbox(dir))).toBe('SOURCE_OUTSIDE_PROJECT');

      rmSync(path.join(dir, 'web'));
      mkdirSync(path.join(dir, 'real-web'));
      symlinkSync(path.join(dir, 'real-web'), path.join(dir, 'web'));
      expect(getSandbox(dir).name).toBe('web');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a missing folder under a symlink to outside the project', () => {
    const dir = tmpProject({ resources: { web: withPath('web/app') } });
    const outside = mkdtempSync(path.join(tmpdir(), 'sbxprev-outside-'));
    try {
      symlinkSync(outside, path.join(dir, 'web'));
      expect(codeOf(() => getSandbox(dir))).toBe('SOURCE_OUTSIDE_PROJECT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('configureSandbox and checkSandboxes catch a source folder symlinked outside the project', () => {
    const dir = tmpProject();
    const outside = mkdtempSync(path.join(tmpdir(), 'sbxprev-outside-'));
    try {
      symlinkSync(outside, path.join(dir, 'web'));
      const { type: _type, ...body } = withPath('web');
      expect(codeOf(() => configureSandbox(dir, 'web', body as Parameters<typeof configureSandbox>[2]))).toBe(
        'INVALID_SANDBOX',
      );
      expect(existsSync(path.join(dir, 'sapiom.json'))).toBe(false);

      writeFileSync(path.join(dir, 'sapiom.json'), JSON.stringify({ resources: { web: withPath('web') } }));
      expect(checkSandboxes(dir)).toEqual({
        ok: false,
        sandboxes: ['web'],
        issues: ['resources.web.source.path: resolves (through a symlink) outside the project directory'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([undefined, '.', 'web', './web', 'web/../web', 'missing'])(
    'resolveSourceDir keeps the lexical path for source.path %p',
    (sourcePath) => {
      const dir = tmpProject();
      try {
        mkdirSync(path.join(dir, 'web'));
        const cfg = { name: 'web', source: { kind: 'upload' as const, path: sourcePath }, start: 's', port: 3000 };
        expect(resolveSourceDir(dir, cfg)).toBe(path.resolve(dir, sourcePath ?? '.'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('checkSandboxes reports an escaping source.path as an issue without throwing', () => {
    const dir = tmpProject({ resources: { web: withPath('../..') } });
    try {
      const result = checkSandboxes(dir);
      expect(result.ok).toBe(false);
      expect(result.sandboxes).toEqual(['web']);
      expect(result.issues).toEqual(['resources.web.source.path: must stay inside the project directory']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
