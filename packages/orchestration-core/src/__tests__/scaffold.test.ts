/**
 * Unit tests for the scaffold operation.
 *
 * These tests are fully local — no network calls. They use a temp directory
 * for the target so the filesystem is the only external dependency.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OrchestrationError } from '../errors';
import { scaffold } from '../scaffold';

// Point template resolution at the bundled templates dir (two levels up from
// src/), bypassing the dist/ path that TEMPLATES_DIR normally expects.
const FIXTURE_TEMPLATES = path.resolve(__dirname, '..', '..', 'templates');

beforeEach(() => {
  process.env.SAPIOM_TEMPLATES_DIR = FIXTURE_TEMPLATES;
});

afterEach(() => {
  delete process.env.SAPIOM_TEMPLATES_DIR;
});

function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'sapiom-scaffold-test-'));
}

describe('scaffold', () => {
  it('creates the target directory and applies replacements', async () => {
    const base = makeTmp();
    const targetDir = path.join(base, 'my-orch');
    try {
      const result = await scaffold({
        targetDir,
        template: 'default',
        projectName: 'my-orch',
        versions: { orchestration: '1.0.0', tools: '1.0.0', zod: '3.0.0' },
      });

      expect(result.targetDir).toBe(targetDir);
      expect(result.projectName).toBe('my-orch');
      expect(result.template).toBe('default');
      expect(existsSync(path.join(targetDir, 'index.ts'))).toBe(true);

      // Replacements applied: __PROJECT_NAME__ → my-orch in package.json
      const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('my-orch');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('defaults projectName to path.basename(targetDir)', async () => {
    const base = makeTmp();
    const targetDir = path.join(base, 'auto-named');
    try {
      const result = await scaffold({
        targetDir,
        versions: { orchestration: '1.0.0', tools: '1.0.0', zod: '3.0.0' },
      });
      expect(result.projectName).toBe('auto-named');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('throws DIR_NOT_EMPTY when target exists and is non-empty', async () => {
    const targetDir = makeTmp();
    // mkdtempSync creates a non-empty-ish dir — add a file to be sure
    writeFileSync(path.join(targetDir, 'existing.txt'), 'x');
    try {
      await expect(
        scaffold({ targetDir, versions: { orchestration: '1.0.0', tools: '1.0.0', zod: '3.0.0' } }),
      ).rejects.toMatchObject({ code: 'DIR_NOT_EMPTY' });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('throws UNKNOWN_TEMPLATE for a non-existent template', async () => {
    const base = makeTmp();
    const targetDir = path.join(base, 'no-template');
    try {
      await expect(
        scaffold({ targetDir, template: 'does-not-exist', versions: { orchestration: '1.0.0', tools: '1.0.0', zod: '3.0.0' } }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_TEMPLATE' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('renames _gitignore to .gitignore', async () => {
    const base = makeTmp();
    const targetDir = path.join(base, 'dotfile-test');
    try {
      await scaffold({
        targetDir,
        versions: { orchestration: '1.0.0', tools: '1.0.0', zod: '3.0.0' },
      });
      expect(existsSync(path.join(targetDir, '.gitignore'))).toBe(true);
      expect(existsSync(path.join(targetDir, '_gitignore'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('OrchestrationError', () => {
  it('serialises to a StructuredError shape', () => {
    const err = new OrchestrationError({ code: 'TEST', message: 'msg', hint: 'fix it' });
    expect(err.toStructured()).toEqual({ code: 'TEST', message: 'msg', hint: 'fix it' });
    expect(err.name).toBe('OrchestrationError');
  });
});
